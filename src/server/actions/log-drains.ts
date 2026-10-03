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
import { sampleLine, syslogTarget } from "@/server/log-drains/config";

const drainSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name.").max(80),
    kind: z.enum(["http", "loki", "elasticsearch", "splunk", "syslog"]),
    url: z.string().trim().url("Enter a URL like https://logs.example.com/ingest."),
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
    serviceIds: z.array(z.string().max(64)).max(1000).default([]),
    index: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-z0-9_.-]*$/, "Use lowercase letters, digits, dots, dashes and underscores in the index."),
    sourcetype: z.string().trim().max(100),
  })
  // Syslog takes tcp://, tls:// or udp:// with a port; the others http or https.
  .refine((d) => (d.kind === "syslog" ? !!syslogTarget(d.url) : /^https?:\/\//.test(d.url)), {
    path: ["url"],
    message: "Use tcp://, tls:// or udp:// with a port for syslog, and an http or https URL for the others.",
  });

type Secrets = { header?: { name: string; value: string }; username?: string; password?: string };

async function assertTarget(ctx: OrgContext, url: string) {
  // Logs and the test line go to this address: only the Root organization may point inside the network.
  if (!ctx.isRoot && (await hostIsPrivate(url))) throw new UserError("That address is on a private network or does not resolve.");
}

/** The organization's own services among these ids; none: null. */
async function knownServices(organizationId: string, ids: string[]) {
  if (!ids.length) return null;
  const rows = await db
    .select({ id: schema.service.id })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(eq(schema.project.organizationId, organizationId), inArray(schema.service.id, ids)));
  return rows.length ? rows.map((r) => r.id) : null;
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
  if (data.kind === "loki" || data.kind === "elasticsearch") return { username: data.username || stored.username, password: data.password || stored.password };
  if (data.kind === "splunk") return { password: data.password || stored.password };
  if (data.kind === "syslog") return {};
  if (!data.headerName) return {};
  return { header: { name: data.headerName, value: data.headerValue || (stored.header?.name === data.headerName ? stored.header.value : "") } };
}

function optionsOf(data: z.infer<typeof drainSchema>) {
  if (data.kind === "elasticsearch") return { index: data.index || null };
  if (data.kind === "splunk") return { index: data.index || null, sourcetype: data.sourcetype || null };
  return null;
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
      serviceIds: await knownServices(ctx.org.id, data.serviceIds),
      options: optionsOf(data),
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
        serviceIds: await knownServices(ctx.org.id, data.serviceIds),
        options: optionsOf(data),
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

/**
 * From a service's settings: send its logs to a drain, or stop. A drain that covers the service's
 * whole project already sends them: that is changed on the drain itself.
 */
export async function setServiceLogDrain(drainId: string, serviceId: string, on: boolean) {
  return act(async () => {
    const ctx = await requirePermission("integrations.manage");
    const row = await getDrain(drainId, ctx.org.id);
    const { serviceInOrg } = await import("@/server/services/access");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const projects = row.projectIds ?? [];
    const services = row.serviceIds ?? [];
    if (projects.includes(service.projectId)) throw new UserError(`${row.name} sends the logs of this whole project. Change it in Integrations → Log drains.`);
    const next = on ? [...new Set([...services, serviceId])] : services.filter((id) => id !== serviceId);
    await db
      .update(schema.logDrain)
      .set({ serviceIds: next.length ? next : null, updatedAt: new Date() })
      .where(eq(schema.logDrain.id, drainId));
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
    if (row.kind === "syslog") {
      await sendSyslogTest(row.url, line);
      return null;
    }
    let url = row.url;
    const headers: Record<string, string> = { "content-type": "application/json" };
    let body: string;
    const basic = () => {
      if (secrets.username || secrets.password) headers.authorization = `Basic ${Buffer.from(`${secrets.username ?? ""}:${secrets.password ?? ""}`).toString("base64")}`;
    };
    if (row.kind === "loki") {
      url = `${row.url.replace(/\/loki\/api\/v1\/push\/?$/, "").replace(/\/$/, "")}/loki/api/v1/push`;
      basic();
      body = JSON.stringify({
        streams: [
          {
            stream: { project: line.project, environment: line.environment, service: line.service, stream: line.stream, server: line.server },
            values: [[`${Date.now()}000000`, JSON.stringify(line)]],
          },
        ],
      });
    } else if (row.kind === "elasticsearch") {
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
      url = `${row.url.replace(/\/$/, "")}/_bulk`;
      headers["content-type"] = "application/x-ndjson";
      basic();
      body = `${JSON.stringify({ create: { _index: `${row.options?.index || "serve-logs"}-${day}` } })}\n${JSON.stringify({ ...line, "@timestamp": line.timestamp })}\n`;
    } else if (row.kind === "splunk") {
      url = `${row.url.replace(/\/services\/collector.*$/, "").replace(/\/$/, "")}/services/collector/event`;
      headers.authorization = `Splunk ${secrets.password ?? ""}`;
      body = JSON.stringify({ event: line, sourcetype: row.options?.sourcetype || "serve", host: line.server, ...(row.options?.index ? { index: row.options.index } : {}) });
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
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (!res.ok) throw new UserError(`${new URL(url).host} answered ${res.status}${text ? `: ${text}` : ""}`);
    // A bulk request answers 200 even when every line was refused.
    if (row.kind === "elasticsearch" && /"errors"\s*:\s*true/.test(text)) throw new UserError(`Elasticsearch refused the line: ${text}`);
    return null;
  });
}

/** One RFC 5424 line over TCP, TLS or UDP, the way Vector sends them. */
async function sendSyslogTest(url: string, line: ReturnType<typeof sampleLine>) {
  const target = syslogTarget(url);
  if (!target) throw new UserError("Use tcp://, tls:// or udp:// with a port.");
  const text = `<14>1 ${line.timestamp} ${line.server} ${line.service} - - - ${line.message}\n`;
  const fail = (error: Error) => new UserError(`Could not reach ${target.host}:${target.port}: ${error.message}`);
  if (target.mode === "udp") {
    const dgram = await import("node:dgram");
    const socket = dgram.createSocket(target.host.includes(":") ? "udp6" : "udp4");
    await new Promise<void>((resolve, reject) => socket.send(text, target.port, target.host, (error) => (error ? reject(fail(error)) : resolve()))).finally(() => socket.close());
    return;
  }
  const net = await import("node:net");
  const tls = await import("node:tls");
  await new Promise<void>((resolve, reject) => {
    const socket = target.tls ? tls.connect({ host: target.host, port: target.port, servername: target.host }) : net.connect({ host: target.host, port: target.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new UserError(`${target.host}:${target.port} did not answer in time.`));
    }, 10_000);
    socket.once(target.tls ? "secureConnect" : "connect", () =>
      socket.end(text, () => {
        clearTimeout(timer);
        resolve();
      }),
    );
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(fail(error));
    });
  });
}
