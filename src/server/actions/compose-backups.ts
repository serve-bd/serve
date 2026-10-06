"use server";

import { encrypt } from "@/server/crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { serviceInOrg } from "@/server/services/access";
import { serverOf } from "@/server/servers/context";
import { composeDatabases, parseBackupKey } from "@/server/backups/compose";
import { stackStorage } from "@/server/backups/storage";
import type { ComposeBackupConfig } from "@/server/services/types";

async function stack(serviceId: string, adminOnly = false) {
  const ctx = await requirePermission("databases.backups");
  if (adminOnly && !ctx.isAdmin) throw new UserError("Only organization admins can change backups.");
  const { service } = await serviceInOrg(serviceId, ctx.org.id);
  // Apps get storage backups too; database containers are found only in compose files.
  if (service.type !== "compose" && service.type !== "app") throw new UserError("Backups of volumes and folders are for apps and compose stacks.");
  return { ctx, service, content: service.type === "compose" ? (service.compose?.content ?? "") : "" };
}

export type BackupOption = { key: string; kind: "db" | "volume" | "dir"; name: string; detail: string; containers: string[] };

async function validKey(service: { id: string; slug: string } & Parameters<typeof serverOf>[0], content: string, key: string) {
  const parsed = parseBackupKey(key);
  if (!parsed) throw new UserError("Unknown backup.");
  if (parsed.kind === "db") {
    if (!composeDatabases(content).some((d) => d.service === parsed.name)) throw new UserError(`${parsed.name} is not a database container of this stack.`);
    return parsed;
  }
  const mounted = await stackStorage(await serverOf(service), service.id);
  if (!mounted.some((m) => m.kind === parsed.kind && m.source === parsed.name)) throw new UserError(`${parsed.name} is not mounted by this stack. Start the stack first.`);
  return parsed;
}

/** Changes the stack's backups from what is stored now, locked so saves at the same moment all stay. */
async function updateConfigs(serviceId: string, change: (current: Record<string, ComposeBackupConfig>) => Record<string, ComposeBackupConfig>) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ composeBackups: schema.service.composeBackups }).from(schema.service).where(eq(schema.service.id, serviceId)).for("update");
    const next = change(row?.composeBackups ?? {});
    await tx
      .update(schema.service)
      .set({ composeBackups: Object.keys(next).length ? next : null })
      .where(eq(schema.service.id, serviceId));
  });
}

/** Adds a database, volume or directory to the stack's backups (manual until a schedule is set). */
export async function addComposeBackup(serviceId: string, key: string) {
  return act(async () => {
    const { ctx, service, content } = await stack(serviceId, true);
    const current = service.composeBackups ?? {};
    if (current[key]) return { key };
    const parsed = await validKey(service, content, key);
    await updateConfigs(service.id, (now) => (now[key] ? now : { ...now, [key]: { schedule: null, retention: 7 } }));
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "backup.add",
      targetType: "service",
      targetId: service.id,
      message: `Added a backup of ${parsed.name} to ${service.name}`,
    });
    return { key };
  });
}

const configSchema = z.object({
  schedule: z.string().max(100).nullable(),
  retention: z.number().int().min(1).max(365),
  retentionS3: z.number().int().min(1).max(3650).nullable(),
  s3DestinationId: z.string().max(64).nullable(),
  local: z.boolean().optional(),
  timeoutMinutes: z.number().int().min(1).max(10080).nullable().optional(),
  lowPriority: z.boolean().optional(),
  /** A new passphrase encrypts the backups from now on; null stops encrypting; left out keeps it. */
  passphrase: z.string().min(8, "Use at least 8 characters for the passphrase").max(200).nullable().optional(),
  copyDestinationIds: z.array(z.string().max(64)).optional(),
  keep: z
    .object({
      days: z.number().int().min(0).max(36500).nullable().optional(),
      daily: z.number().int().min(0).max(36500).nullable().optional(),
      weekly: z.number().int().min(0).max(5200).nullable().optional(),
      monthly: z.number().int().min(0).max(1200).nullable().optional(),
      yearly: z.number().int().min(0).max(100).nullable().optional(),
    })
    .nullable()
    .optional(),
});

/** Schedule, retention and S3 storage of one backup of a stack. */
export async function saveComposeBackup(serviceId: string, key: string, input: z.infer<typeof configSchema>) {
  return act(async () => {
    const { ctx, service } = await stack(serviceId, true);
    const data = configSchema.parse(input);
    const current = service.composeBackups ?? {};
    if (!current[key]) throw new UserError("Add this backup first.");
    if (data.schedule) {
      const { CronExpressionParser } = await import("cron-parser");
      try {
        CronExpressionParser.parse(data.schedule);
      } catch {
        throw new UserError("The backup schedule is not a valid cron expression.");
      }
    }
    for (const id of [...(data.copyDestinationIds ?? []), ...(data.s3DestinationId ? [data.s3DestinationId] : [])]) {
      const [dest] = await db
        .select({ id: schema.s3Destination.id })
        .from(schema.s3Destination)
        .where(and(eq(schema.s3Destination.id, id), eq(schema.s3Destination.organizationId, ctx.org.id)));
      if (!dest) throw new UserError("Backup storage not found.");
    }
    if (data.s3DestinationId) {
      const [dest] = await db
        .select({ id: schema.s3Destination.id })
        .from(schema.s3Destination)
        .where(and(eq(schema.s3Destination.id, data.s3DestinationId), eq(schema.s3Destination.organizationId, ctx.org.id)));
      if (!dest) throw new UserError("Backup storage not found.");
    }
    await updateConfigs(service.id, (now) => {
      if (!now[key]) throw new UserError("This backup was removed. Reload the page.");
      const { passphrase, ...rest } = data;
      // Kept encrypted with Serve's key; the browser never gets it back.
      return { ...now, [key]: { ...rest, passphrase: passphrase === undefined ? (now[key].passphrase ?? null) : passphrase ? encrypt(passphrase) : null } };
    });
    return null;
  });
}

/** Stops backing up a database, volume or directory. Backups already taken stay until deleted. */
export async function removeComposeBackup(serviceId: string, key: string) {
  return act(async () => {
    const { ctx, service } = await stack(serviceId, true);
    if (!service.composeBackups?.[key]) return null;
    await updateConfigs(service.id, (now) => Object.fromEntries(Object.entries(now).filter(([k]) => k !== key)));
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "backup.remove",
      targetType: "service",
      targetId: service.id,
      message: `Stopped backing up ${parseBackupKey(key)?.name ?? key} in ${service.name}`,
    });
    return null;
  });
}
