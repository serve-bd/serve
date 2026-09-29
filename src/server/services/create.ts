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
  opts: { userId?: string | null; rollbackOf?: string | null; commitSha?: string | null; commitMessage?: string | null; branch?: string | null } = {},
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
  });
  await enqueue("deploy", { deploymentId: id }, { concurrencyKey: `service:${serviceId}` });
  return id;
}
