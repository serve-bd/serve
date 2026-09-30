"use server";

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

async function stack(serviceId: string) {
  const ctx = await requirePermission("databases.backups");
  const { service } = await serviceInOrg(serviceId, ctx.org.id);
  // Apps get storage backups too; database containers are found only in compose files.
  if (service.type !== "compose" && service.type !== "app") throw new UserError("Backups of volumes and folders are for apps and compose stacks.");
  return { ctx, service, content: service.type === "compose" ? (service.compose?.content ?? "") : "" };
}

export type BackupOption = { key: string; kind: "db" | "volume" | "dir"; name: string; detail: string; containers: string[] };

/**
 * What a stack can back up: its database containers (found by image) and every volume and host
 * directory its containers mount (read from Docker, so the stack must have been started once).
 */
export async function composeBackupOptions(serviceId: string) {
  return act(async () => {
    const { service, content } = await stack(serviceId);
    const databases: BackupOption[] = composeDatabases(content).map((d) => ({ key: `db:${d.service}`, kind: "db", name: d.service, detail: d.image, containers: [d.service] }));
    const { docker } = await serverOf(service);
    const storage: BackupOption[] = (await stackStorage(docker, service.id).catch(() => [])).map((m) => ({
      key: `${m.kind}:${m.source}`,
      kind: m.kind,
      name: m.source,
      detail: m.destinations.join(", "),
      containers: m.containers,
    }));
    return { databases, storage };
  });
}

async function validKey(service: { id: string; slug: string } & Parameters<typeof serverOf>[0], content: string, key: string) {
  const parsed = parseBackupKey(key);
  if (!parsed) throw new UserError("Unknown backup.");
  if (parsed.kind === "db") {
    if (!composeDatabases(content).some((d) => d.service === parsed.name)) throw new UserError(`${parsed.name} is not a database container of this stack.`);
    return parsed;
  }
  const { docker } = await serverOf(service);
  const mounted = await stackStorage(docker, service.id);
  if (!mounted.some((m) => m.kind === parsed.kind && m.source === parsed.name)) throw new UserError(`${parsed.name} is not mounted by this stack. Start the stack first.`);
  return parsed;
}

async function writeConfigs(serviceId: string, next: Record<string, ComposeBackupConfig>) {
  await db
    .update(schema.service)
    .set({ composeBackups: Object.keys(next).length ? next : null })
    .where(eq(schema.service.id, serviceId));
}

/** Adds a database, volume or directory to the stack's backups (manual until a schedule is set). */
export async function addComposeBackup(serviceId: string, key: string) {
  return act(async () => {
    const { ctx, service, content } = await stack(serviceId);
    const current = service.composeBackups ?? {};
    if (current[key]) return { key };
    const parsed = await validKey(service, content, key);
    await writeConfigs(service.id, { ...current, [key]: { schedule: null, retention: 7 } });
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
});

/** Schedule, retention and S3 storage of one backup of a stack. */
export async function saveComposeBackup(serviceId: string, key: string, input: z.infer<typeof configSchema>) {
  return act(async () => {
    const { ctx, service } = await stack(serviceId);
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
    if (data.s3DestinationId) {
      const [dest] = await db
        .select({ id: schema.s3Destination.id })
        .from(schema.s3Destination)
        .where(and(eq(schema.s3Destination.id, data.s3DestinationId), eq(schema.s3Destination.organizationId, ctx.org.id)));
      if (!dest) throw new UserError("Backup storage not found.");
    }
    await writeConfigs(service.id, { ...current, [key]: data });
    return null;
  });
}

/** Stops backing up a database, volume or directory. Backups already taken stay until deleted. */
export async function removeComposeBackup(serviceId: string, key: string) {
  return act(async () => {
    const { ctx, service } = await stack(serviceId);
    const { [key]: removed, ...rest } = service.composeBackups ?? {};
    if (!removed) return null;
    await writeConfigs(service.id, rest);
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
