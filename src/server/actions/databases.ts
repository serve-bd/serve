"use server";

import { databaseContainer } from "@/server/databases/container";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { ForbiddenError, requirePermission } from "@/server/auth";
import { cannotMessage } from "@/lib/permissions";
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
import { type DatabaseConfig, hasHostAccess } from "@/server/services/types";

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
    // The image, init scripts and server arguments decide what runs (archive_command runs programs);
    // with host mounts or privileged mode that is an admin's decision, as for apps (updateService).
    if (hasHostAccess(service.runtime) && !(ctx.isInstanceAdmin && ctx.isRoot))
      throw new UserError("Changing a database that has host-level access is only available to admins of the Root organization, for its own services.");
    const data = settingsSchema.parse(input);
    const next: DatabaseConfig = { ...service.database, ...data };
    // Empty text fields mean "use the default".
    for (const key of ["description", "image", "initdbArgs", "charset", "collation", "extraArgs", "dataMountPath", "customConfig"] as const) {
      const value = data[key];
      if (value !== undefined) next[key] = value?.trim() ? (key === "customConfig" ? value : value.trim()) : null;
    }
    // Trust lets anyone who reaches the database in without the password: as good as seeing it.
    if (next.hostAuthMethod === "trust" && service.database.hostAuthMethod !== "trust" && !ctx.can("variables.view-secrets"))
      throw new UserError(cannotMessage("variables.view-secrets"));
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
    // A password of one's own choosing is a known password: like seeing the current one.
    if (password?.trim() && !ctx.can("variables.view-secrets")) throw new ForbiddenError(cannotMessage("variables.view-secrets"));
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
    let name = volumeName(service.slug, source);
    if (service.type === "compose" && service.compose) {
      const { readComposeMounts } = await import("@/lib/compose-mounts");
      if (readComposeMounts(service.compose.content).some((s) => s.mounts.some((m) => m.kind === "volume" && m.source === source))) {
        throw new UserError("The compose file still mounts this volume. Remove the mount and redeploy first.");
      }
      // A Docker volume name is taken as is when Compose labelled it as this stack's; else <project>_<volume>.
      const info = await (await serverOf(service)).docker
        .getVolume(source)
        .inspect()
        .catch(() => null);
      name = info?.Labels?.["com.docker.compose.project"] === service.slug ? source : `${service.slug}_${source}`;
    } else if (service.runtime.volumes.some((v) => v.kind === "volume" && v.source === source)) {
      throw new UserError("Remove the mount and redeploy before deleting its data.");
    }
    const server = await serverOf(service);
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
export async function importBackupFromRemote(serviceId: string, input: z.input<typeof remoteImportSchema>, backupFirst: boolean, users = false, passphrase?: string) {
  return act(async () => {
    const ctx = await requirePermission("databases.backups");
    // Importing overwrites live data: admins only, like restoring.
    if (!ctx.isAdmin) throw new UserError("Only organization admins can import backups.");
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
      {
        backupId: id,
        backupFirst,
        users,
        ...(passphrase ? { passphrase: encrypt(passphrase) } : {}),
        ...(source.kind === "url" ? { url: source.url } : { s3: { destinationId: source.destinationId, key: source.key } }),
      },
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

/* -------------------------------------------------------------------------- */
/*                     PostgreSQL: connection pooler and replica               */
/* -------------------------------------------------------------------------- */

async function databaseForAddon(serviceId: string, addon: "pooler" | "replicas") {
  const ctx = await requirePermission("services.manage");
  const { service } = await serviceInOrg(serviceId, ctx.org.id);
  const { replicasSupported } = await import("@/server/services/types");
  if (addon === "pooler" && service.database?.engine !== "postgres") throw new UserError("Connection pooling is for PostgreSQL databases.");
  if (addon === "replicas" && !replicasSupported(service.database?.engine))
    throw new UserError("Read replicas are for PostgreSQL, MySQL, MariaDB, MongoDB, Redis and Valkey databases.");
  if (service.parentServiceId) throw new UserError("Preview databases have no add-ons.");
  if (hasHostAccess(service.runtime) && !(ctx.isInstanceAdmin && ctx.isRoot))
    throw new UserError("Changing a database that has host-level access is only available to admins of the Root organization, for its own services.");
  return { ctx, service, cfg: service.database! };
}

const poolerSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["transaction", "session"]),
  poolSize: z.number().int().min(1).max(500),
  maxClients: z.number().int().min(10).max(10000),
});

/** Turns the PgBouncer of a PostgreSQL database on, off or to new settings. The database keeps running. */
export async function setDatabasePooler(serviceId: string, input: z.input<typeof poolerSchema>) {
  return act(async () => {
    const { ctx, service, cfg } = await databaseForAddon(serviceId, "pooler");
    const data = poolerSchema.parse(input);
    const pooler = { ...data, password: cfg.pooler?.password ?? null };
    await db
      .update(schema.service)
      .set({ database: { ...cfg, pooler } })
      .where(eq(schema.service.id, serviceId));
    const { ensurePooler, removePooler } = await import("@/server/databases/addons");
    const live = service.status === "running";
    if (data.enabled && live) await ensurePooler({ ...service, database: { ...cfg, pooler } });
    else await removePooler(service).catch(() => {});
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.updated",
      targetType: "service",
      targetId: service.id,
      message: data.enabled ? `Connection pooling on for ${service.name} (${data.mode})` : `Connection pooling off for ${service.name}`,
    });
    return { started: data.enabled && live };
  });
}

const replicasSchema = z
  .array(
    z.object({
      id: z
        .string()
        .regex(/^[0-9]{1,3}$/)
        .optional(),
      serverId: z.string().min(1),
    }),
  )
  // Replica ids have up to three digits.
  .max(999);

/**
 * Sets the read replicas of a PostgreSQL database: each on the database's server or on one linked
 * to it privately. New ones are copied from the database, removed ones lose their copy and slot.
 * The database keeps running.
 */
export async function setDatabaseReplicas(serviceId: string, input: z.input<typeof replicasSchema>) {
  return act(async () => {
    const { ctx, service, cfg } = await databaseForAddon(serviceId, "replicas");
    const wanted = replicasSchema.parse(input);
    const { serversForOrg } = await import("@/server/servers/access");
    const { meshMemberIds, privatelyConnected } = await import("@/server/mesh/members");
    const [servers, members] = await Promise.all([serversForOrg(ctx.org.id), meshMemberIds()]);
    for (const r of wanted) {
      const server = servers.find((s) => s.id === r.serverId);
      if (!server) throw new UserError("One of the chosen servers was not found.");
      if (!privatelyConnected(members, service.serverId, r.serverId))
        throw new UserError(`${server.name} shares no private network with the database's server. Link them in Servers → Private network first.`);
    }
    const { replicaInstances } = await import("@/server/services/types");
    const before = replicaInstances(service);
    // Kept replicas keep their id (and copy); new ones take the next free number.
    let next = Math.max(0, ...before.map((r) => Number(r.id) || 0)) + 1;
    const instances = wanted.map((r) => (r.id && before.some((b) => b.id === r.id) ? { id: r.id, serverId: r.serverId } : { id: String(next++), serverId: r.serverId }));
    // Public replicas open their port on every replica server: it must be free on new ones too.
    const pub = instances.length ? (cfg.replica?.public ?? null) : null;
    const beforeServers = [...new Set(before.map((r) => r.serverId))];
    const afterServers = [...new Set(instances.map((r) => r.serverId))];
    if (pub?.port) {
      const { busyPortsFor } = await import("@/server/databases/public-ports");
      for (const serverId of afterServers.filter((id) => !beforeServers.includes(id))) {
        if ((await busyPortsFor(service, serverId, "replicas")).has(pub.port))
          throw new UserError(`Port ${pub.port} (the replicas' public port) is already used on ${servers.find((s) => s.id === serverId)?.name ?? "that server"}.`);
      }
    }
    // MariaDB and MongoDB need a restart to be ready for replicas (a binary log, a replica set):
    // once, the first time; it stays ready after that.
    const restart = instances.length > 0 && (cfg.engine === "mariadb" || cfg.engine === "mongodb") && !cfg.replica?.primed;
    const replica = {
      enabled: instances.length > 0,
      password: cfg.replica?.password ?? null,
      instances,
      public: pub,
      primed: cfg.replica?.primed || restart || undefined,
    };
    await db
      .update(schema.service)
      .set({ database: { ...cfg, replica } })
      .where(eq(schema.service.id, serviceId));
    const { ensureReplicas, removeReplicaInstance } = await import("@/server/databases/addons");
    // A replica moved to another server is a new copy there.
    for (const old of before) {
      const now = instances.find((r) => r.id === old.id);
      if (!now || now.serverId !== old.serverId) await removeReplicaInstance(service, old);
    }
    const live = service.status === "running";
    // The restart deploys the database, and its replicas start after it.
    if (restart && live) await queueDeployment(serviceId, "redeploy", { userId: ctx.user.id });
    else if (live && (instances.length || before.length)) await ensureReplicas({ ...service, database: { ...cfg, replica } });
    // The replicas' domain follows them: A records and certificates on the servers they run on now.
    const domain = cfg.replica?.public?.domain ?? null;
    if (domain) {
      const { syncAddonDomain } = await import("@/server/databases/addon-domains");
      const { retireCertificateFor } = await import("@/server/ssl/certificates");
      const sync = await syncAddonDomain(service, cfg.replica!.public!, pub, afterServers, ctx.org.id).catch(() => null);
      // Servers whose port does not answer from outside stay out of the domain; the page names them.
      if (sync && pub) {
        await db
          .update(schema.service)
          .set({ database: { ...cfg, replica: { ...replica, public: { ...pub, unreachable: sync.unreachable.length ? sync.unreachable : null } } } })
          .where(eq(schema.service.id, serviceId));
      }
      for (const serverId of beforeServers.filter((id) => !afterServers.includes(id))) await retireCertificateFor(domain, serverId, ctx.org.id).catch(() => {});
    }
    // Firewalls of every server a replica left or joined.
    if (cfg.replica?.public?.allow?.length) {
      const { applyDatabaseAllowlists } = await import("@/server/databases/allowlist");
      for (const serverId of new Set([...beforeServers, ...afterServers])) await applyDatabaseAllowlists(serverId).catch(() => {});
    }
    const added = instances.filter((r) => !before.some((b) => b.id === r.id)).length;
    const removed = before.filter((b) => !instances.some((r) => r.id === b.id)).length;
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.updated",
      targetType: "service",
      targetId: service.id,
      message: `Read replicas of ${service.name}: ${instances.length}${added ? `, ${added} added` : ""}${removed ? `, ${removed} removed` : ""}`,
    });
    return { started: instances.length > 0 && live, restarted: restart && live };
  });
}

/** Whether the pooler runs and how the replica is doing. */
export async function databaseAddonStatus(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("projects.view");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const cfg = service.database;
    const { replicasSupported } = await import("@/server/services/types");
    if (!replicasSupported(cfg?.engine)) return { pooler: null, replicas: [] };
    const { poolerName, replicaStatuses } = await import("@/server/databases/addons");
    const server = await serverOf(service);
    const pooler =
      cfg!.engine === "postgres" && cfg!.pooler?.enabled
        ? await server.docker
            .getContainer(poolerName(service))
            .inspect()
            .then((i) => (i.State.Running ? "running" : "stopped"))
            .catch(() => "stopped")
        : null;
    const replicas = await replicaStatuses(service).catch(() => []);
    return { pooler, replicas };
  });
}

/**
 * Makes a read replica the database (its server was lost, or it must move there now). The
 * database deploys on the replica's server with the replica's data; the public side of its pooler
 * and replicas is turned off, as their ports and DNS were on the old servers.
 */
export async function promoteDatabaseReplica(serviceId: string, replicaId: string) {
  return act(async () => {
    const { ctx, service, cfg } = await databaseForAddon(serviceId, "replicas");
    if (!ctx.can("services.deploy")) throw new UserError(cannotMessage("services.deploy"));
    const { replicaInstances } = await import("@/server/services/types");
    const replica = replicaInstances(service).find((r) => r.id === replicaId);
    if (!replica) throw new UserError("That replica is gone.");
    const { syncAddonDomain } = await import("@/server/databases/addon-domains");
    if (cfg.pooler?.public) await syncAddonDomain(service, cfg.pooler.public, null, [service.serverId], ctx.org.id).catch(() => []);
    if (cfg.replica?.public) await syncAddonDomain(service, cfg.replica.public, null, [...new Set(replicaInstances(service).map((r) => r.serverId))], ctx.org.id).catch(() => []);
    const { promoteReplica } = await import("@/server/databases/addons");
    await promoteReplica(
      {
        ...service,
        database: { ...cfg, pooler: cfg.pooler ? { ...cfg.pooler, public: null } : cfg.pooler, replica: cfg.replica ? { ...cfg.replica, public: null } : cfg.replica },
      },
      replicaId,
    );
    await queueDeployment(serviceId, "redeploy", { userId: ctx.user.id });
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.updated",
      targetType: "service",
      targetId: service.id,
      message: `Promoted read replica ${replicaId} to be ${service.name}`,
    });
    return null;
  });
}
