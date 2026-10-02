import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { newId, shortId, slugify } from "@/server/id";
import { randomSecret } from "@/server/crypto";
import { autoDomainFor } from "@/server/proxy/addressing";
import { enqueue } from "@/server/queue";
import { LOCAL_SERVER_ID, type DeploymentTrigger } from "@/server/db/schema";

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
    adopt?: { containerId: string; name: string; mode?: "move" | "copy"; volumes?: { from: string; to: string }[] } | null;
  } = {},
) {
  const id = newId();
  await db.insert(schema.deployment).values({
    id,
    serviceId,
    trigger,
    status: "queued",
    createdBy: opts.userId ?? null,
    rollbackOf: opts.rollbackOf ?? null,
    commitSha: opts.commitSha ?? null,
    commitMessage: opts.commitMessage ?? null,
    branch: opts.branch ?? null,
    adopt: opts.adopt ?? null,
  });
  await enqueue("deploy", { deploymentId: id }, { concurrencyKey: `service:${serviceId}` });
  return id;
}
