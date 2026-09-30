"use server";

import { databaseContainer } from "@/server/databases/container";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decrypt, decryptOrNull, encrypt, randomPassword } from "@/server/crypto";
import { logActivity } from "@/server/activity";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { serviceInOrg } from "@/server/services/access";
import { queueDeployment } from "@/server/services/create";
import { referenceName } from "@/lib/refs";
import { serverOf } from "@/server/servers/context";
import { execInContainer } from "@/server/docker/client";
import { volumeName } from "@/server/deploy/containers";
import { databaseConfigIssues, databaseCreds } from "@/server/databases/options";
import { changePasswordCommand, PASSWORD_PATTERN } from "@/server/databases/password";
import type { DatabaseConfig } from "@/server/services/types";

const settingsSchema = z
  .object({
    description: z.string().trim().max(300).nullable(),
    image: z.string().trim().max(255).nullable(),
    initdbArgs: z.string().trim().max(500).nullable(),
    hostAuthMethod: z.enum(["scram-sha-256", "md5", "trust"]).nullable(),
    charset: z.string().trim().max(32).nullable(),
    collation: z.string().trim().max(64).nullable(),
    initScripts: z.array(z.object({ name: z.string().trim().max(90), content: z.string().max(512_000) })).max(30),
    customConfig: z.string().max(64_000).nullable(),
    extraArgs: z.string().trim().max(2000).nullable(),
    dataMountPath: z.string().trim().max(300).nullable(),
    tls: z.object({ enabled: z.boolean(), mode: z.enum(["prefer", "require"]).optional() }).nullable(),
    healthcheck: z
      .object({
        interval: z.number().int().min(1).max(300).nullable(),
        timeout: z.number().int().min(1).max(300).nullable(),
        retries: z.number().int().min(1).max(100).nullable(),
        startPeriod: z.number().int().min(0).max(3600).nullable(),
      })
      .partial()
      .nullable(),
    backupRetentionS3: z.number().int().min(1).max(365).nullable(),
  })
  .partial();

/** Fields that only take effect when the container is recreated. */
const RESTART_FIELDS: (keyof DatabaseConfig)[] = [
  "image",
  "initdbArgs",
  "hostAuthMethod",
  "charset",
  "collation",
  "initScripts",
  "customConfig",
  "extraArgs",
  "dataMountPath",
  "tls",
  "healthcheck",
];

/** Saves database settings. Returns whether the running container must restart to apply them. */
export async function updateDatabaseSettings(serviceId: string, input: z.input<typeof settingsSchema>) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (!service.database) throw new UserError("Not a database.");
    const data = settingsSchema.parse(input);
    const next: DatabaseConfig = { ...service.database, ...data };
    // Empty text fields mean "use the default".
    for (const key of ["description", "image", "initdbArgs", "charset", "collation", "extraArgs", "dataMountPath", "customConfig"] as const) {
      const value = data[key];
      if (value !== undefined) next[key] = value?.trim() ? (key === "customConfig" ? value : value.trim()) : null;
    }
    const issues = databaseConfigIssues(next);
    if (issues.length) throw new UserError(issues[0]);
    await db.update(schema.service).set({ database: next }).where(eq(schema.service.id, serviceId));
    const changed = RESTART_FIELDS.filter((k) => JSON.stringify(next[k] ?? null) !== JSON.stringify(service.database![k] ?? null));
    return { restart: changed.length > 0 && service.status !== "stopped" && service.status !== "idle", changed };
  });
}

/** Services in the same environment whose variables reference this database. */
async function dependentsOf(service: typeof schema.service.$inferSelect) {
  const siblings = await db
    .select({ id: schema.service.id, name: schema.service.name, status: schema.service.status })
    .from(schema.service)
    .where(and(eq(schema.service.environmentId, service.environmentId), ne(schema.service.id, service.id)));
  if (!siblings.length) return [];
  const vars = await db
    .select({ serviceId: schema.envVar.serviceId, value: schema.envVar.value })
    .from(schema.envVar)
    .where(
      inArray(
        schema.envVar.serviceId,
        siblings.map((s) => s.id),
      ),
    );
  const names = [service.slug, service.name, referenceName(service.name)].map((n) => n.toLowerCase());
  const uses = new Set<string>();
  for (const v of vars) {
    const value = (decryptOrNull(v.value) ?? "").toLowerCase();
    if (names.some((n) => value.includes(`\${{${n}.`) || value.includes(`\${{ ${n}.`))) uses.add(v.serviceId);
  }
  return siblings.filter((s) => uses.has(s.id));
}

export async function databaseDependents(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("projects.view");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    return dependentsOf(service);
  });
}

/**
 * Changes the password inside the running database, then stores it and restarts the
 * container so health checks, backups and ${{db.PASSWORD}} references use it.
 */
export async function changeDatabasePassword(serviceId: string, password?: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const cfg = service.database;
    if (!cfg) throw new UserError("Not a database.");
    const next = password?.trim() || randomPassword(32);
    if (!PASSWORD_PATTERN.test(next)) throw new UserError("Use 12 to 128 letters, numbers, dots, dashes, underscores or tildes.");
    const current = databaseCreds(cfg, decrypt(cfg.password));
    if (next === current.password) throw new UserError("That is the current password.");
    const command = changePasswordCommand(cfg, current, next);
    if (command) {
      if (service.status !== "running") throw new UserError("Start the database first. The password is changed inside the running database.");
      const server = await serverOf(service);
      let result: { exitCode: number; output: string };
      try {
        await databaseContainer(server.docker, service);
        result = await execInContainer(service.slug, ["sh", "-c", command], {}, server.docker);
      } catch (e) {
        throw new UserError(`Could not reach the database container: ${(e as Error).message}`);
      }
      if (result.exitCode !== 0) {
        const detail = result.output.replaceAll(current.password, "***").replaceAll(next, "***").trim().split("\n").slice(-3).join(" ");
        throw new UserError(`The database refused the change${detail ? `: ${detail}` : "."}`);
      }
    }
    await db
      .update(schema.service)
      .set({ database: { ...cfg, password: encrypt(next) } })
      .where(eq(schema.service.id, serviceId));
    await queueDeployment(serviceId, "redeploy", { userId: ctx.user.id });
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "database.password",
      targetType: "service",
      targetId: service.id,
      message: `Changed the password of ${service.name}`,
    });
    return { dependents: await dependentsOf(service) };
  });
}

/** Redeploys running services (after a database password change). */
export async function redeployServices(serviceIds: string[]) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    let queued = 0;
    for (const id of serviceIds.slice(0, 50)) {
      const { service } = await serviceInOrg(id, ctx.org.id);
      if (service.status === "stopped" || service.status === "idle") continue;
      await queueDeployment(id, "redeploy", { userId: ctx.user.id });
      queued++;
    }
    return { queued };
  });
}

/** Permanently deletes a Docker volume of the service that is no longer mounted. */
export async function deleteVolumeData(serviceId: string, source: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type === "database" && source === "data") throw new UserError("The data volume holds the database. Delete the service to remove it.");
    if (service.runtime.volumes.some((v) => v.kind === "volume" && v.source === source)) throw new UserError("Remove the mount and redeploy before deleting its data.");
    const server = await serverOf(service);
    const name = volumeName(service.slug, source);
    try {
      await server.docker.getVolume(name).remove();
    } catch (e) {
      const message = (e as Error).message;
      if (/in use/i.test(message)) throw new UserError(`${name} is still used by a container. Redeploy first.`);
      if (/no such volume|404/i.test(message)) throw new UserError(`${name} does not exist.`);
      throw new UserError(message);
    }
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "volume.delete",
      targetType: "service",
      targetId: service.id,
      message: `Deleted volume ${name}`,
    });
    return null;
  });
}

/** True when the host is (or resolves to) a loopback, private or link-local address. */
async function resolvesToPrivate(host: string) {
  const { lookup } = await import("node:dns/promises");
  const { isPrivateAddress } = await import("@/server/net/public-fetch");
  const addrs = await lookup(host.replace(/^\[|\]$/g, ""), { all: true }).catch(() => []);
  return !addrs.length || addrs.some((a) => isPrivateAddress(a.address));
}

const remoteImportSchema = z.union([
  z.object({ kind: z.literal("url"), url: z.url("Enter a valid URL").refine((u) => /^https?:\/\//i.test(u), "Use an http or https URL") }),
  z.object({ kind: z.literal("s3"), destinationId: z.string().min(1), key: z.string().trim().min(1, "Enter the object path").max(1024) }),
]);

/** Imports a dump from a URL or an S3 destination, then restores it. */
export async function importBackupFromRemote(serviceId: string, input: z.input<typeof remoteImportSchema>, backupFirst: boolean) {
  return act(async () => {
    const ctx = await requirePermission("databases.backups");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (!service.database) throw new UserError("Not a database.");
    if (service.status !== "running") throw new UserError("Start the database before importing.");
    const source = remoteImportSchema.parse(input);
    if (source.kind === "s3") {
      const [dest] = await db
        .select({ id: schema.s3Destination.id })
        .from(schema.s3Destination)
        .where(and(eq(schema.s3Destination.id, source.destinationId), eq(schema.s3Destination.organizationId, ctx.org.id)));
      if (!dest) throw new UserError("Backup storage not found.");
    }
    if (source.kind === "url" && (await resolvesToPrivate(new URL(source.url).hostname))) {
      throw new UserError("The URL points at a private address. Use a public URL or upload the file.");
    }
    const { importFilename } = await import("@/server/backups");
    const original = source.kind === "url" ? new URL(source.url).pathname : source.key;
    let filename: string;
    try {
      filename = importFilename(service.database.engine, service.slug, original);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const id = newId();
    await db.insert(schema.backup).values({ id, serviceId, trigger: "import", status: "running", filename });
    await enqueue(
      "backup.import",
      { backupId: id, backupFirst, ...(source.kind === "url" ? { url: source.url } : { s3: { destinationId: source.destinationId, key: source.key } }) },
      { concurrencyKey: `backup:${serviceId}` },
    );
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "backup.import",
      targetType: "service",
      targetId: service.id,
      message: `Importing a backup into ${service.name}`,
    });
    return { id };
  });
}
