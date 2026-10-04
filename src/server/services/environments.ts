import { withoutHostAccess, withoutOutsideResources } from "@/server/services/types";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, encrypt, randomPassword } from "@/server/crypto";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { engines, pgDbname } from "@/server/databases/engines";
import { dumpDatabase, restoreDumpFile, runWithInput } from "@/server/backups";
import { databaseCreds } from "@/server/databases/options";
import { enqueue } from "@/server/queue";
import { serverOf } from "@/server/servers/context";
import { generatedHostname, newWebhookSecret, queueDeployment, uniqueServiceSlug } from "./create";
import type { DatabaseConfig } from "./types";
import { rewriteValue } from "./clone-values";

type Service = typeof schema.service.$inferSelect;

/* -------------------------------------------------------------------------- */
/*                             Clone environment                              */
/* -------------------------------------------------------------------------- */

export type CloneOptions = {
  sourceEnvironmentId: string;
  name: string;
  userId?: string | null;
  /** Made by an admin of the Root organization: stacks keep permission for host-level options. */
  hostAccess?: boolean;
  /** Give apps and stacks that had a generated domain a new generated domain. */
  generatedDomains: boolean;
  /** Copy the data of database services (starts the new databases to load it). */
  copyData: boolean;
};

export type CloneSummary = {
  environmentId: string;
  services: { id: string; name: string; type: string; from: string }[];
  variables: number;
  sharedVariables: number;
  domains: number;
  /** Things the copy left out, for the summary. */
  notes: string[];
  copyingData: boolean;
};

/**
 * Copy every service of an environment into a new environment of the same project: settings,
 * variables (references pointed at the copies) and shared variables. Nothing is deployed, custom
 * domains stay with the original, and volumes start empty unless database data is copied.
 */
export async function cloneEnvironment(opts: CloneOptions): Promise<CloneSummary> {
  const [source] = await db.select().from(schema.environment).where(eq(schema.environment.id, opts.sourceEnvironmentId));
  if (!source) throw new Error("Environment not found");
  // Previews belong to their pull request, not to the environment.
  const services = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.environmentId, source.id), isNull(schema.service.parentServiceId)));
  const ids = services.map((s) => s.id);
  const [vars, shared, domains] = await Promise.all([
    ids.length ? db.select().from(schema.envVar).where(inArray(schema.envVar.serviceId, ids)) : [],
    db.select().from(schema.sharedVar).where(eq(schema.sharedVar.environmentId, source.id)),
    ids.length ? db.select().from(schema.domain).where(inArray(schema.domain.serviceId, ids)) : [],
  ]);

  const environmentId = newId();
  const idMap = new Map<string, string>();
  const slugMap = new Map<string, string>();
  const passwordMap = new Map<string, string>();
  const rows: (typeof schema.service.$inferInsert)[] = [];
  const notes = new Set<string>();

  for (const s of services) {
    const id = newId();
    const slug = await uniqueServiceSlug(s.name);
    idMap.set(s.id, id);
    slugMap.set(s.slug, slug);
    let database: DatabaseConfig | null = s.database;
    if (database) {
      const next = randomPassword();
      passwordMap.set(decrypt(database.password), next);
      // Host ports, schedules and the domain belong to the original; the copy gets its own password.
      // Data kept outside Serve (a database moved in) stays with the original: the copy gets its own volume.
      database = {
        ...database,
        password: encrypt(next),
        publicPort: null,
        backupSchedule: null,
        domain: null,
        domainTunnelId: null,
        domainOpened: null,
        dataVolume: null,
        // The copy pools its own connections (its own lookup login), privately; replicas stay with the original.
        pooler: database.pooler ? { ...database.pooler, password: null, public: null } : null,
        replica: null,
      };
      if (s.database?.replica?.enabled) notes.add("Read replicas stay with the original environment: add them to the copy if it needs them.");
      if (s.database?.pooler?.public) notes.add("The connection pooler of the copy is private: its public port and domain stay with the original.");
      if (s.database?.domain) notes.add("Database domains stay with the original environment.");
      if (s.database?.publicPort) notes.add("Public database ports are off in the copy, so they do not clash with the original.");
      if (s.database?.backupSchedule) notes.add("Backup schedules are off in the copy.");
    }
    if (s.runtime.ports.length || s.compose?.ports?.length) notes.add("Published host ports are left out, so they do not clash with the original.");
    if (s.runtime.volumes.some((v) => v.kind === "bind")) notes.add("Bind mounts still point at the same folders on the server as the original.");
    if (s.source?.type === "git" && s.autoDeploy) notes.add("Deploy on push is off in the copy. Turn it on in Settings → Source.");
    rows.push({
      id,
      projectId: s.projectId,
      environmentId,
      serverId: s.serverId,
      name: s.name,
      slug,
      hostname: s.hostname,
      type: s.type,
      icon: s.icon,
      status: "idle",
      source: s.source?.type === "git" ? { ...s.source, webhook: null } : s.source,
      build: s.build ? { ...s.build, noCacheOnce: false } : null,
      runtime: opts.hostAccess ? { ...withoutOutsideResources(s.runtime), ports: [] } : withoutHostAccess(s.runtime),
      database,
      compose: s.compose ? { ...s.compose, subnet: null, ports: [], hostAccess: !!opts.hostAccess && !!s.compose.hostAccess } : null,
      proxy: s.proxy,
      proxyCustom: s.proxyCustom,
      autoDeploy: false,
      previewsEnabled: false,
      webhookSecret: newWebhookSecret(),
    });
  }
  // A preview database setting points at the copied database.
  for (const [i, s] of services.entries()) {
    if (s.previewDatabase && idMap.has(s.previewDatabase.sourceServiceId))
      rows[i].previewDatabase = { ...s.previewDatabase, sourceServiceId: idMap.get(s.previewDatabase.sourceServiceId)! };
  }

  const newVars = vars.map((v) => ({
    id: newId(),
    serviceId: idMap.get(v.serviceId)!,
    key: v.key,
    // A literal value is copied as written: its ${{…}} are text, not references.
    value: v.literal ? v.value : encrypt(rewriteValue(decrypt(v.value), slugMap, passwordMap)),
    buildTime: v.buildTime,
    runtime: v.runtime,
    literal: v.literal,
    multiline: v.multiline,
  }));
  const newShared = shared.map((v) => ({ id: newId(), environmentId, key: v.key, value: encrypt(rewriteValue(decrypt(v.value), slugMap, passwordMap)) }));

  const newDomains: (typeof schema.domain.$inferInsert)[] = [];
  if (opts.generatedDomains) {
    for (const d of domains) {
      if (!d.generated) continue;
      const s = services.find((x) => x.id === d.serviceId)!;
      const host = await generatedHostname(slugMap.get(s.slug)!, s.serverId);
      if (!host || newDomains.some((n) => n.hostname === host.hostname)) continue;
      newDomains.push({
        id: newId(),
        serviceId: idMap.get(s.id)!,
        hostname: host.hostname,
        port: d.port,
        composeService: d.composeService,
        https: host.https,
        forceHttps: host.https,
        generated: true,
      });
    }
  }
  if (domains.some((d) => !d.generated)) notes.add("Custom domains stay with the original environment.");

  await db.transaction(async (tx) => {
    await tx.insert(schema.environment).values({ id: environmentId, projectId: source.projectId, name: opts.name });
    if (rows.length) await tx.insert(schema.service).values(rows);
    if (newVars.length) await tx.insert(schema.envVar).values(newVars);
    if (newShared.length) await tx.insert(schema.sharedVar).values(newShared);
    if (newDomains.length) await tx.insert(schema.domain).values(newDomains).onConflictDoNothing();
  });

  const pairs = opts.copyData ? services.filter((s) => s.type === "database").map((s) => ({ from: s.id, to: idMap.get(s.id)! })) : [];
  if (pairs.length) await enqueue("environment.copy-data", { environmentId, pairs, userId: opts.userId ?? null }, { concurrencyKey: `env-copy:${environmentId}` });
  else if (services.some((s) => s.type === "database")) notes.add("Databases start empty. Volumes are not copied.");

  await logActivity({
    userId: opts.userId ?? null,
    projectId: source.projectId,
    action: "environment.cloned",
    targetType: "environment",
    targetId: environmentId,
    message: `Cloned environment ${source.name} to ${opts.name} (${services.length} service${services.length === 1 ? "" : "s"})`,
  });

  return {
    environmentId,
    services: rows.map((r, i) => ({ id: r.id!, name: r.name, type: r.type, from: services[i].id })),
    variables: newVars.length,
    sharedVariables: newShared.length,
    domains: newDomains.length,
    notes: [...notes],
    copyingData: pairs.length > 0,
  };
}

/* -------------------------------------------------------------------------- */
/*                            Copying database data                           */
/* -------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function serviceRow(id: string) {
  const [row] = await db.select().from(schema.service).where(eq(schema.service.id, id));
  if (!row) throw new Error("The service was deleted.");
  return row;
}

/** Deploy a database service (unless it runs) and wait until it accepts connections. */
async function ensureRunning(service: Service, userId: string | null, log: (line: string) => void) {
  if (service.status !== "running") {
    log(`Starting ${service.name}`);
    const deploymentId = await queueDeployment(service.id, "create", { userId });
    const deadline = Date.now() + 15 * 60_000;
    for (;;) {
      const [d] = await db.select({ status: schema.deployment.status, error: schema.deployment.error }).from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
      if (!d) throw new Error(`The deployment of ${service.name} was removed.`);
      if (d.status === "success") break;
      if (["failed", "cancelled", "superseded"].includes(d.status)) throw new Error(`${service.name} did not start${d.error ? `: ${d.error.slice(0, 300)}` : "."}`);
      if (Date.now() > deadline) throw new Error(`${service.name} did not start within 15 minutes.`);
      await sleep(2000);
    }
  }
  // Deployed is not always ready: wait for the container's health check.
  const { docker } = await serverOf(service);
  for (let i = 0; i < 60; i++) {
    const info = await docker
      .getContainer(service.slug)
      .inspect()
      .catch(() => null);
    const health = info?.State.Health?.Status;
    if (info?.State.Running && (!health || health === "healthy")) return;
    await sleep(2000);
  }
  throw new Error(`${service.name} is not healthy.`);
}

/** Engines whose copies can run a clean-up SQL script, and the client that runs it. */
export function scrubCommand(cfg: DatabaseConfig, password: string): string | null {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const creds = databaseCreds(cfg, password);
  switch (cfg.engine) {
    case "postgres":
      return `PGPASSWORD=${q(creds.password)} psql -X -v ON_ERROR_STOP=1 -q -U ${q(creds.username)} -d ${q(pgDbname(creds.database))}`;
    case "mysql":
      return `MYSQL_PWD=${q(creds.password)} mysql -uroot ${q(creds.database)}`;
    case "mariadb":
      return `MYSQL_PWD=${q(creds.password)} mariadb -uroot ${q(creds.database)}`;
    case "clickhouse":
      return engines.clickhouse.restoreCommand(creds);
    default:
      return null;
  }
}

/**
 * Copy the data of one database service into another of the same engine: dump the source,
 * restore it into the target, then run the optional clean-up SQL on the target.
 */
export async function copyDatabase(fromId: string, toId: string, opts: { userId?: string | null; scrubSql?: string | null; log?: (line: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const from = await serviceRow(fromId);
  let to = await serviceRow(toId);
  if (!from.database || !to.database) throw new Error("Both services must be databases.");
  if (from.database.engine !== to.database.engine) throw new Error(`${from.name} and ${to.name} use different engines.`);
  if (from.status !== "running") throw new Error(`${from.name} is not running, so there is nothing to copy.`);
  await ensureRunning(to, opts.userId ?? null, log);
  to = await serviceRow(toId);

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "serve-copy-"));
  const file = path.join(dir, `copy.${engines[from.database.engine].backupExtension}`);
  try {
    log(`Dumping ${from.name}`);
    const size = await dumpDatabase(from, file);
    log(`Restoring ${Math.round(size / 1024)} KB into ${to.name}`);
    await restoreDumpFile(to, file);
    if (opts.scrubSql?.trim()) {
      const password = decrypt(to.database!.password);
      const command = scrubCommand(to.database!, password);
      if (!command) throw new Error(`Clean-up SQL is not supported for ${engines[to.database!.engine].label}.`);
      log("Running the clean-up SQL");
      const { Readable } = await import("node:stream");
      await runWithInput(to, command, Readable.from([opts.scrubSql]), false, password);
    }
    log("Copy finished");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/** Job: copy the data of the databases of a cloned environment, one after the other. */
export async function copyEnvironmentData(payload: { environmentId: string; pairs: { from: string; to: string }[]; userId?: string | null }) {
  const [env] = await db.select().from(schema.environment).where(eq(schema.environment.id, payload.environmentId));
  if (!env) return;
  const failed: string[] = [];
  for (const pair of payload.pairs) {
    const [target] = await db.select({ name: schema.service.name }).from(schema.service).where(eq(schema.service.id, pair.to));
    if (!target) continue;
    try {
      await copyDatabase(pair.from, pair.to, { userId: payload.userId ?? null });
      await logActivity({
        projectId: env.projectId,
        action: "environment.data-copied",
        targetType: "service",
        targetId: pair.to,
        message: `Copied the data of ${target.name} into ${env.name}`,
      });
    } catch (error) {
      failed.push(target.name);
      await logActivity({
        projectId: env.projectId,
        action: "environment.data-copy-failed",
        targetType: "service",
        targetId: pair.to,
        message: `Could not copy the data of ${target.name} into ${env.name}: ${(error as Error).message.slice(0, 300)}`,
      });
    }
  }
  if (failed.length) throw new Error(`Data copy failed for ${failed.join(", ")}`);
}

/**
 * A data copy that stopped part way (the worker restarted, or it ran past its time limit): every
 * database it had not finished says so in Activity, where the clone dialog points. Its data may be
 * incomplete, and nothing else would tell.
 */
export async function failInterruptedCopy(payload: { environmentId: string; pairs: { from: string; to: string }[] }, why: string) {
  const [env] = await db.select().from(schema.environment).where(eq(schema.environment.id, payload.environmentId));
  if (!env) return;
  const targets = payload.pairs.map((p) => p.to);
  if (!targets.length) return;
  // The targets are new services: any outcome recorded for one belongs to this copy.
  const done = new Set(
    (
      await db
        .select({ targetId: schema.activity.targetId })
        .from(schema.activity)
        .where(and(inArray(schema.activity.action, ["environment.data-copied", "environment.data-copy-failed"]), inArray(schema.activity.targetId, targets)))
    ).map((r) => r.targetId),
  );
  for (const id of targets) {
    if (done.has(id)) continue;
    const [target] = await db.select({ name: schema.service.name }).from(schema.service).where(eq(schema.service.id, id));
    if (!target) continue;
    await logActivity({
      projectId: env.projectId,
      action: "environment.data-copy-failed",
      targetType: "service",
      targetId: id,
      message: `The data copy of ${target.name} into ${env.name} stopped: ${why} It may hold only part of the data.`,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                          Databases for PR previews                          */
/* -------------------------------------------------------------------------- */

/** The database copy that belongs to a preview service. */
export async function previewDatabaseOf(previewId: string) {
  const [row] = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.parentServiceId, previewId), eq(schema.service.type, "database")));
  return row ?? null;
}

/**
 * Create the database copy of a new preview: a temporary database service of the same engine
 * and version as the source, in the same environment and on the preview's server. Its connection
 * URL goes into the preview's variable as a reference. Returns the copy's id.
 */
export async function createPreviewDatabase(preview: Service, parent: Service, prNumber: number) {
  const cfg = parent.previewDatabase;
  if (!cfg) return null;
  const [source] = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.id, cfg.sourceServiceId), eq(schema.service.environmentId, parent.environmentId), eq(schema.service.type, "database")));
  if (!source?.database) return null;
  const id = newId();
  const slug = `${source.slug}-pr${prNumber}`.slice(0, 60);
  await db.insert(schema.service).values({
    id,
    projectId: source.projectId,
    environmentId: source.environmentId,
    // Next to the preview, so it reaches the copy over the private network.
    serverId: preview.serverId,
    name: `${source.name} · PR #${prNumber}`,
    slug: (await db.select({ id: schema.service.id }).from(schema.service).where(eq(schema.service.slug, slug))).length
      ? await uniqueServiceSlug(`${source.name}-pr${prNumber}`)
      : slug,
    type: "database",
    icon: source.icon,
    runtime: { ...withoutOutsideResources(source.runtime), ports: [] },
    database: {
      ...source.database,
      dataVolume: null,
      password: encrypt(randomPassword()),
      publicPort: null,
      backupSchedule: null,
      s3DestinationId: null,
      domain: null,
      domainTunnelId: null,
      domainOpened: null,
      // A preview's database is a plain copy: no pooler or replicas of its own.
      pooler: null,
      replica: null,
    },
    autoDeploy: false,
    webhookSecret: newWebhookSecret(),
    parentServiceId: preview.id,
    previewPr: prNumber,
  });
  const [copy] = await db.select().from(schema.service).where(eq(schema.service.id, id));
  const value = encrypt(`\${{${copy.slug}.DATABASE_URL}}`);
  await db
    .insert(schema.envVar)
    .values({ id: newId(), serviceId: preview.id, key: cfg.variable, value, buildTime: false, runtime: true })
    .onConflictDoUpdate({ target: [schema.envVar.serviceId, schema.envVar.key], set: { value } });
  return id;
}

/**
 * Job: fill a preview's database copy, then deploy the preview. Without clean-up SQL the preview
 * deploys even when the copy fails. With clean-up SQL a failure removes the copy and skips the
 * deployment, so real personal data never sits in a preview that was meant to hide it.
 * `interrupted`: the job was cut off by a worker restart, and is settled like a failed copy.
 */
export async function preparePreviewDatabase(
  payload: {
    previewId: string;
    databaseId: string;
    parentId: string;
    deployment: { commitSha?: string | null; commitMessage?: string | null; branch?: string | null };
  },
  opts: { interrupted?: boolean } = {},
) {
  const [parent] = await db.select().from(schema.service).where(eq(schema.service.id, payload.parentId));
  const [preview] = await db.select().from(schema.service).where(eq(schema.service.id, payload.previewId));
  if (!preview) return;
  const cfg = parent?.previewDatabase;
  try {
    if (!cfg) throw new Error("Preview databases were turned off.");
    // The copy may hold restored data its clean-up SQL never ran on.
    if (opts.interrupted) throw new Error("The worker restarted during the copy.");
    await copyDatabase(cfg.sourceServiceId, payload.databaseId, { scrubSql: cfg.scrubSql });
    await logActivity({
      projectId: preview.projectId,
      action: "preview.database",
      targetType: "service",
      targetId: preview.id,
      message: `Database copy ready for ${preview.name}`,
    });
  } catch (error) {
    const message = (error as Error).message.slice(0, 300);
    if (cfg?.scrubSql?.trim()) {
      const [copy] = await db.select().from(schema.service).where(eq(schema.service.id, payload.databaseId));
      if (copy) {
        const { teardownServices } = await import("./teardown");
        await teardownServices([copy], true);
      }
      await logActivity({
        projectId: preview.projectId,
        action: "preview.database-failed",
        targetType: "service",
        targetId: preview.id,
        message: `${preview.name} was not deployed: preparing its database copy failed (${message}). The copy was removed so no unmasked data stays behind.`,
      });
      return;
    }
    await logActivity({
      projectId: preview.projectId,
      action: "preview.database-failed",
      targetType: "service",
      targetId: preview.id,
      message: `The database copy for ${preview.name} failed: ${message}`,
    });
  }
  await queueDeployment(preview.id, "webhook", payload.deployment);
}
