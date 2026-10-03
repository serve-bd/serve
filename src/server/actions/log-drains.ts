"use server";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { type OrgContext, requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull, encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { hostIsPrivate } from "@/server/net/public-host";
import { sampleLine } from "@/server/log-drains/config";

const drainSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(80),
  kind: z.enum(["http", "loki"]),
  url: z
    .string()
    .trim()
    .url("Enter a URL like https://logs.example.com/ingest.")
    .refine((u) => /^https?:\/\//.test(u), "Use an http or https URL."),
  /** Empty keeps the stored value when editing. */
  headerName: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9-]*$/, "Use letters, digits and dashes in the header name."),
  headerValue: z.string().max(4000),
  username: z.string().trim().max(200),
  password: z.string().max(4000),
  projectIds: z.array(z.string().max(64)).max(200),
});

type Secrets = { header?: { name: string; value: string }; username?: string; password?: string };

async function assertTarget(ctx: OrgContext, url: string) {
  // Logs and the test line go to this address: only the Root organization may point inside the network.
  if (!ctx.isRoot && (await hostIsPrivate(url))) throw new UserError("That address is on a private network or does not resolve.");
}

async function knownProjects(organizationId: string, ids: string[]) {
  if (!ids.length) return null;
  const rows = await db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(and(eq(schema.project.organizationId, organizationId), inArray(schema.project.id, ids)));
  return rows.length ? rows.map((r) => r.id) : null;
}

/** The secrets to store: typed values, or the stored ones where a field was left empty. */
function mergeSecrets(data: z.infer<typeof drainSchema>, stored: Secrets): Secrets {
  if (data.kind === "loki") return { username: data.username || stored.username, password: data.password || stored.password };
  if (!data.headerName) return {};
  return { header: { name: data.headerName, value: data.headerValue || (stored.header?.name === data.headerName ? stored.header.value : "") } };
}

/** Resync Vector on every server in the background: the drain works within a minute either way. */
function resync() {
  void import("@/server/log-drains/sync").then((m) => m.syncLogDrains()).catch(() => {});
}

export async function addLogDrain(input: z.input<typeof drainSchema>) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const data = drainSchema.parse(input);
    await assertTarget(ctx, data.url);
    const id = newId();
    await db.insert(schema.logDrain).values({
      id,
      organizationId: ctx.org.id,
      name: data.name,
      kind: data.kind,
      url: data.url,
      secrets: encrypt(JSON.stringify(mergeSecrets(data, {}))),
      projectIds: await knownProjects(ctx.org.id, data.projectIds),
    });
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "log-drain.added",
      message: `Added the log drain ${data.name}`,
      targetType: "log-drain",
      targetId: id,
    });
    resync();
    return { id };
  });
}

async function getDrain(id: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(schema.logDrain)
    .where(and(eq(schema.logDrain.id, id), eq(schema.logDrain.organizationId, organizationId)));
  if (!row) throw new UserError("Log drain not found.");
  return row;
}

export async function updateLogDrain(id: string, input: z.input<typeof drainSchema>) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const row = await getDrain(id, ctx.org.id);
    const data = drainSchema.parse(input);
    await assertTarget(ctx, data.url);
    // Stored secrets only go to the address they were saved for.
    const stored: Secrets = data.url === row.url ? JSON.parse(decryptOrNull(row.secrets) ?? "{}") : {};
    await db
      .update(schema.logDrain)
      .set({
        name: data.name,
        kind: data.kind,
        url: data.url,
        secrets: encrypt(JSON.stringify(mergeSecrets(data, stored))),
        projectIds: await knownProjects(ctx.org.id, data.projectIds),
        updatedAt: new Date(),
      })
      .where(eq(schema.logDrain.id, id));
    resync();
    return null;
  });
}

export async function setLogDrainEnabled(id: string, enabled: boolean) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    await getDrain(id, ctx.org.id);
    await db.update(schema.logDrain).set({ enabled, updatedAt: new Date() }).where(eq(schema.logDrain.id, id));
    resync();
    return null;
  });
}

export async function deleteLogDrain(id: string) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const row = await getDrain(id, ctx.org.id);
    await db.delete(schema.logDrain).where(eq(schema.logDrain.id, id));
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "log-drain.removed",
      message: `Removed the log drain ${row.name}`,
      targetType: "log-drain",
      targetId: id,
    });
    resync();
    return null;
  });
}

/** Send one sample line from the dashboard, the way Vector sends them, and report the answer. */
export async function testLogDrain(id: string) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const row = await getDrain(id, ctx.org.id);
    await assertTarget(ctx, row.url);
    const secrets: Secrets = JSON.parse(decryptOrNull(row.secrets) ?? "{}");
    const line = sampleLine(ctx.org.id);
    let url = row.url;
    const headers: Record<string, string> = { "content-type": "application/json" };
    let body: string;
    if (row.kind === "loki") {
      url = `${row.url.replace(/\/loki\/api\/v1\/push\/?$/, "").replace(/\/$/, "")}/loki/api/v1/push`;
      if (secrets.username || secrets.password) headers.authorization = `Basic ${Buffer.from(`${secrets.username ?? ""}:${secrets.password ?? ""}`).toString("base64")}`;
      body = JSON.stringify({
        streams: [
          {
            stream: { project: line.project, environment: line.environment, service: line.service, stream: line.stream, server: line.server },
            values: [[`${Date.now()}000000`, JSON.stringify(line)]],
          },
        ],
      });
    } else {
      if (secrets.header?.name) headers[secrets.header.name] = secrets.header.value;
      body = JSON.stringify([line]);
    }
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new UserError(`Could not reach ${new URL(url).host}: ${(error as Error).message}`);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new UserError(`${new URL(url).host} answered ${res.status}${text ? `: ${text}` : ""}`);
    }
    return null;
  });
}
