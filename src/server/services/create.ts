import { and, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { newId, shortId, slugify } from "@/server/id";
import { randomSecret } from "@/server/crypto";
import { autoDomainFor } from "@/server/proxy/addressing";
import { enqueue } from "@/server/queue";
import { LOCAL_SERVER_ID, type DeploymentTrigger, type DeploymentUpload } from "@/server/db/schema";
import { UserError } from "@/server/action";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function uniqueServiceSlug(name: string) {
  const base = slugify(name, 28);
  for (let i = 0; i < 10; i++) {
    const slug = `${base}-${shortId()}`;
    const [taken] = await db.select({ id: schema.service.id }).from(schema.service).where(eq(schema.service.slug, slug));
    if (!taken) return slug;
  }
  return `${base}-${newId()}`;
}

/** Whether another service in the environment already answers to this name in references. */
export async function serviceNameTaken(environmentId: string, name: string, exceptId?: string) {
  const { referenceName } = await import("@/lib/refs");
  const want = referenceName(name);
  const rows = await db.select({ id: schema.service.id, name: schema.service.name }).from(schema.service).where(eq(schema.service.environmentId, environmentId));
  return rows.some((r) => r.id !== exceptId && referenceName(r.name) === want);
}

/**
 * A name no other service of the environment uses, so ${{name.KEY}} references stay unambiguous:
 * "postgresql", then "postgresql-2", "postgresql-3"…
 */
export async function uniqueServiceName(environmentId: string, name: string) {
  if (!(await serviceNameTaken(environmentId, name))) return name;
  for (let i = 2; i < 100; i++) {
    const next = `${name}-${i}`;
    if (!(await serviceNameTaken(environmentId, next))) return next;
  }
  return `${name}-${shortId()}`;
}

export function newWebhookSecret() {
  return randomSecret(24);
}

/** Automatic domain (wildcard or sslip.io) for a service, using the addressing of its server. */
export function generatedHostname(slug: string, serverId: string = LOCAL_SERVER_ID) {
  return autoDomainFor(slug, serverId);
}

export async function queueDeployment(
  serviceId: string,
  trigger: DeploymentTrigger,
  opts: {
    userId?: string | null;
    rollbackOf?: string | null;
    commitSha?: string | null;
    commitMessage?: string | null;
    branch?: string | null;
    /** A container made outside Serve that this deployment takes over. */
    adopt?: import("@/server/adopt/handoff").Handoff | null;
    /** Files uploaded by the CLI to build instead of the source. */
    upload?: DeploymentUpload | null;
    /** The id to use (an upload names its archive after the deployment before it is queued). */
    id?: string;
  } = {},
) {
  const id = opts.id ?? newId();
  if (!opts.upload && !opts.rollbackOf) {
    // An app deployed from the CLI builds its newest upload again; without one there is nothing to build.
    const last = await lastUploadOf(serviceId);
    if (last === "none") return recordSkipped(serviceId, trigger, NO_UPLOAD, opts);
    if (last) opts = { ...opts, upload: last.upload, commitSha: last.commitSha, commitMessage: last.commitMessage, branch: last.branch };
  }
  // The project's deploy rules: a freeze stops it, an approval holds it.
  const { deployGate, supersedeWaiting } = await import("@/server/deploy-rules");
  const gate = await deployGate(serviceId, trigger, opts.userId);
  if (gate.kind === "frozen") {
    // Someone deploying gets the answer; a push or hook leaves a record of what was skipped.
    if (opts.userId) throw new UserError(gate.message);
    return recordSkipped(serviceId, trigger, gate.message, opts);
  }
  // The server's queue limit: a full queue refuses someone deploying and records a skipped push or hook.
  // A rollback (urgent) and a new service's first deploy always get in.
  const full = await db.transaction(async (tx) => {
    const reason = trigger === "rollback" || trigger === "create" ? null : await queueFull(tx, serviceId);
    if (reason) return reason;
    await tx.insert(schema.deployment).values({
      id,
      serviceId,
      trigger,
      status: gate.kind === "approve" ? "waiting" : "queued",
      createdBy: opts.userId ?? null,
      rollbackOf: opts.rollbackOf ?? null,
      commitSha: opts.commitSha ?? null,
      commitMessage: opts.commitMessage ?? null,
      branch: opts.branch ?? null,
      adopt: opts.adopt ?? null,
      upload: opts.upload ?? null,
    });
    return null;
  });
  if (full) {
    if (opts.userId) throw new UserError(full);
    return recordSkipped(serviceId, trigger, full, opts);
  }
  if (gate.kind === "approve") {
    await supersedeWaiting(serviceId, id);
    await notifyWaiting(serviceId, id);
    return id;
  }
  await enqueue("deploy", { deploymentId: id }, { concurrencyKey: `service:${serviceId}` });
  return id;
}

export const NO_UPLOAD = "This app is deployed from the CLI and has no uploaded files yet: run serve deploy in the project folder.";

/**
 * For an app deployed from the CLI: its newest upload deployment whose files are still kept, or
 * "none" when there is none. Null for other services (they build from their source).
 */
export async function lastUploadOf(serviceId: string) {
  const [service] = await db.select({ source: schema.service.source }).from(schema.service).where(eq(schema.service.id, serviceId));
  if (service?.source?.type !== "upload") return null;
  const { uploadExists } = await import("@/server/deploy/uploads");
  const rows = await db
    .select({ upload: schema.deployment.upload, commitSha: schema.deployment.commitSha, commitMessage: schema.deployment.commitMessage, branch: schema.deployment.branch })
    .from(schema.deployment)
    .where(and(eq(schema.deployment.serviceId, serviceId), isNotNull(schema.deployment.upload)))
    .orderBy(desc(schema.deployment.createdAt))
    .limit(10);
  for (const r of rows) if (r.upload && (await uploadExists(r.upload.archive))) return { ...r, upload: r.upload };
  return "none" as const;
}

/**
 * Why a deploy started by someone would be refused right now (a freeze, a full queue), or null.
 * Asked before a large upload is stored; queueDeployment checks again when it queues.
 */
export async function deployRefusal(serviceId: string, trigger: DeploymentTrigger, userId: string) {
  const { deployGate } = await import("@/server/deploy-rules");
  const gate = await deployGate(serviceId, trigger, userId);
  if (gate.kind === "frozen") return gate.message;
  if (gate.kind === "approve") return null;
  return db.transaction((tx) => queueFull(tx, serviceId));
}

/**
 * Why a new deployment cannot wait in its server's queue (the server's limit is reached), or null.
 * Holds the server's queue lock until the transaction ends: deploys queued at the same moment
 * (a burst of pushes, a tag hook) count one after another, so none gets past the limit.
 */
async function queueFull(tx: Tx, serviceId: string) {
  const [row] = await tx
    .select({ serverId: schema.service.serverId, limit: schema.server.deployQueueLimit, name: schema.server.name })
    .from(schema.service)
    .innerJoin(schema.server, eq(schema.server.id, schema.service.serverId))
    .where(eq(schema.service.id, serviceId));
  if (!row?.limit) return null;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`deploy-queue:${row.serverId}`}))`);
  const [{ n }] = await tx
    .select({ n: count() })
    .from(schema.deployment)
    .innerJoin(schema.service, eq(schema.service.id, schema.deployment.serviceId))
    .where(and(eq(schema.service.serverId, row.serverId), eq(schema.deployment.status, "queued")));
  return n >= row.limit ? `The deploy queue of ${row.name} is full (${n} waiting, its limit is ${row.limit}). Try again when some have run.` : null;
}

/** A deployment that never ran, kept in the deployments list with the reason it was skipped. */
export async function recordSkipped(
  serviceId: string,
  trigger: DeploymentTrigger,
  reason: string,
  commit: { commitSha?: string | null; commitMessage?: string | null; branch?: string | null; upload?: DeploymentUpload | null } = {},
) {
  const id = newId();
  await db.insert(schema.deployment).values({
    id,
    serviceId,
    trigger,
    status: "cancelled",
    error: reason,
    logs: `Skipped: ${reason}\n`,
    commitSha: commit.commitSha ?? null,
    commitMessage: commit.commitMessage ?? null,
    branch: commit.branch ?? null,
    upload: commit.upload ?? null,
    finishedAt: new Date(),
  });
  return id;
}

/** Tells the organization's channels that a deploy waits for someone to approve it. */
async function notifyWaiting(serviceId: string, deploymentId: string) {
  const { notify, orgOfService } = await import("@/server/notify");
  const [row] = await db
    .select({ name: schema.service.name, projectId: schema.service.projectId, commitMessage: schema.deployment.commitMessage, branch: schema.deployment.branch })
    .from(schema.deployment)
    .innerJoin(schema.service, eq(schema.deployment.serviceId, schema.service.id))
    .where(eq(schema.deployment.id, deploymentId));
  if (!row) return;
  void notify(await orgOfService(serviceId), "deploy.waiting", {
    ok: false,
    title: `${row.name} is waiting for approval`,
    body: row.commitMessage ? `${row.commitMessage.split("\n")[0].slice(0, 200)}${row.branch ? ` (${row.branch})` : ""}` : "A deployment waits for someone to approve it.",
    url: `/projects/${row.projectId}/services/${serviceId}/deployments/${deploymentId}`,
    status: "waiting",
    serviceId,
    deploymentId,
  });
}
