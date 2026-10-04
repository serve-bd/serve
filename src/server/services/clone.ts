import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { encrypt, randomPassword } from "@/server/crypto";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { HOSTNAME_RE } from "@/lib/hostname";
import { withoutHostAccess, withoutOutsideResources, type DatabaseConfig } from "./types";
import { generatedHostname, newWebhookSecret, uniqueServiceName, uniqueServiceSlug } from "./create";

type Service = typeof schema.service.$inferSelect;

export type CloneServiceOptions = {
  environmentId: string;
  serverId: string;
  name?: string | null;
  userId?: string | null;
  /** Made by an admin of the Root organization: host-level options come along. */
  hostAccess?: boolean;
  /** Databases: copy the data too (the copy starts to load it). */
  copyData?: boolean;
};

export type CloneServiceResult = { id: string; name: string; notes: string[]; copyingData: boolean };

/** The service's private name in the target environment, unless another service answers to it there. */
async function freeHostname(environmentId: string, wanted: string | null) {
  if (!wanted || !HOSTNAME_RE.test(wanted)) return null;
  const [taken] = await db
    .select({ id: schema.service.id })
    .from(schema.service)
    .where(and(eq(schema.service.environmentId, environmentId), eq(schema.service.hostname, wanted)));
  return taken ? null : wanted;
}

/**
 * A copy of one service in any environment and on any server: settings, variables, scheduled tasks
 * (turned off) and a generated domain when it had one. Nothing is deployed. Custom domains, host
 * ports, backup schedules and database domains stay with the original; volumes start empty unless
 * a database's data is copied.
 */
export async function cloneService(source: Service, opts: CloneServiceOptions): Promise<CloneServiceResult> {
  if (source.parentServiceId) throw new Error("Previews cannot be cloned.");
  const notes = new Set<string>();
  const id = newId();
  const name = await uniqueServiceName(opts.environmentId, opts.name?.trim() || source.name);
  const slug = await uniqueServiceSlug(name);
  const sameServer = opts.serverId === source.serverId;

  let database: DatabaseConfig | null = source.database;
  if (database) {
    database = {
      ...database,
      password: encrypt(randomPassword()),
      publicPort: null,
      backupSchedule: null,
      domain: null,
      domainTunnelId: null,
      domainOpened: null,
      dataVolume: null,
      pooler: database.pooler ? { ...database.pooler, password: null, public: null } : null,
      replica: null,
    };
    if (source.database?.replica?.enabled) notes.add("Read replicas stay with the original.");
    if (source.database?.domain) notes.add("The database domain stays with the original.");
    if (source.database?.publicPort) notes.add("The public port is off in the copy, so it does not clash with the original.");
    if (source.database?.backupSchedule) notes.add("The backup schedule is off in the copy.");
  }
  if (source.runtime.ports.length || source.compose?.ports?.length) notes.add("Published host ports are left out, so they do not clash with the original.");
  if (source.runtime.volumes.some((v) => v.kind === "bind")) notes.add("Bind mounts still point at the same folders on the server.");
  if (source.source?.type === "git" && source.autoDeploy) notes.add("Deploy on push is off in the copy. Turn it on in Settings → Source.");
  const extra = source.type === "app" ? (source.distribution?.extraServerIds ?? []) : [];
  if (!sameServer && extra.length) notes.add("Extra servers stay with the original: the copy runs on its own server only.");

  const [vars, tasks, domains] = await Promise.all([
    db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, source.id)),
    db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.serviceId, source.id)),
    db.select().from(schema.domain).where(eq(schema.domain.serviceId, source.id)),
  ]);
  const hostname = await freeHostname(opts.environmentId, source.hostname);
  // A preview database in another environment is not the copy's to use.
  const previewDatabase = source.previewDatabase && opts.environmentId === source.environmentId ? source.previewDatabase : null;

  const [env] = await db
    .select({ projectId: schema.environment.projectId, name: schema.environment.name })
    .from(schema.environment)
    .where(eq(schema.environment.id, opts.environmentId));
  if (!env) throw new Error("Environment not found");

  let domain: typeof schema.domain.$inferInsert | null = null;
  const generated = domains.find((d) => d.generated);
  if (generated) {
    const host = await generatedHostname(slug, opts.serverId);
    if (host)
      domain = {
        id: newId(),
        serviceId: id,
        hostname: host.hostname,
        port: generated.port,
        composeService: generated.composeService,
        https: host.https,
        forceHttps: host.https,
        generated: true,
      };
  }
  if (domains.some((d) => !d.generated)) notes.add("Custom domains stay with the original.");
  if (tasks.length) notes.add("Scheduled tasks are copied turned off: turn them on once the copy runs.");

  await db.transaction(async (tx) => {
    await tx.insert(schema.service).values({
      id,
      projectId: env.projectId,
      environmentId: opts.environmentId,
      serverId: opts.serverId,
      name,
      slug,
      hostname,
      type: source.type,
      icon: source.icon,
      status: "idle",
      source: source.source?.type === "git" ? { ...source.source, webhook: null } : source.source,
      build: source.build ? { ...source.build, noCacheOnce: false } : null,
      runtime: opts.hostAccess ? { ...withoutOutsideResources(source.runtime), ports: [] } : withoutHostAccess(source.runtime),
      database,
      compose: source.compose ? { ...source.compose, subnet: null, ports: [], hostAccess: !!opts.hostAccess && !!source.compose.hostAccess } : null,
      proxy: source.proxy,
      proxyCustom: source.proxyCustom,
      distribution: source.distribution && sameServer ? source.distribution : null,
      replicaVars: source.replicaVars,
      previewVars: source.previewVars,
      previewDatabase,
      autoDeploy: false,
      previewsEnabled: false,
      webhookSecret: newWebhookSecret(),
    });
    if (vars.length)
      await tx
        .insert(schema.envVar)
        .values(
          vars.map((v) => ({ id: newId(), serviceId: id, key: v.key, value: v.value, buildTime: v.buildTime, runtime: v.runtime, literal: v.literal, multiline: v.multiline })),
        );
    if (tasks.length)
      await tx
        .insert(schema.scheduledTask)
        .values(
          tasks.map((t) => ({
            id: newId(),
            serviceId: id,
            name: t.name,
            schedule: t.schedule,
            command: t.command,
            composeService: t.composeService,
            enabled: false,
            timeoutSeconds: t.timeoutSeconds,
          })),
        );
    if (domain) await tx.insert(schema.domain).values(domain).onConflictDoNothing();
  });

  const copyingData = !!opts.copyData && source.type === "database";
  if (copyingData)
    await enqueue(
      "environment.copy-data",
      { environmentId: opts.environmentId, pairs: [{ from: source.id, to: id }], userId: opts.userId ?? null },
      { concurrencyKey: `env-copy:${opts.environmentId}` },
    );
  else if (source.type === "database") notes.add("The copy starts empty: its data is not copied.");

  await logActivity({
    userId: opts.userId ?? null,
    projectId: env.projectId,
    action: "service.created",
    targetType: "service",
    targetId: id,
    message: `Cloned ${source.name} to ${name} in ${env.name}`,
  });
  return { id, name, notes: [...notes], copyingData };
}

/** An environment of the organization, with its project. */
export async function environmentInOrg(environmentId: string, organizationId: string) {
  const [row] = await db
    .select({ id: schema.environment.id, projectId: schema.environment.projectId })
    .from(schema.environment)
    .innerJoin(schema.project, eq(schema.project.id, schema.environment.projectId))
    .where(and(eq(schema.environment.id, environmentId), eq(schema.project.organizationId, organizationId)));
  return row ?? null;
}
