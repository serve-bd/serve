import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { randomSecret } from "@/server/crypto";
import { UserError } from "@/server/action";
import { TAG_NAME_RE } from "@/lib/tags";
import type { DeploymentTrigger } from "@/server/db/schema";

export const newTagSecret = () => randomSecret(24);

/** A tag name as typed, checked. */
export function tagName(name: string) {
  const n = name.trim();
  if (!TAG_NAME_RE.test(n)) throw new UserError(`"${n}" is not a valid tag: use up to 40 letters, numbers, dots, dashes or underscores.`);
  return n;
}

/** The tags of some services, by service id. */
export async function tagsOf(serviceIds: string[]) {
  const out = new Map<string, { id: string; name: string; color: string }[]>();
  if (!serviceIds.length) return out;
  const rows = await db
    .select({ serviceId: schema.serviceTag.serviceId, id: schema.tag.id, name: schema.tag.name, color: schema.tag.color })
    .from(schema.serviceTag)
    .innerJoin(schema.tag, eq(schema.tag.id, schema.serviceTag.tagId))
    .where(inArray(schema.serviceTag.serviceId, serviceIds))
    .orderBy(asc(schema.tag.name));
  for (const r of rows) out.set(r.serviceId, [...(out.get(r.serviceId) ?? []), { id: r.id, name: r.name, color: r.color }]);
  return out;
}

/**
 * Sets a service's tags by name: names the organization has no tag for yet become new tags. Names
 * match without case (Prod is prod).
 */
export async function setServiceTags(serviceId: string, organizationId: string, names: string[]) {
  const wanted = [...new Map(names.map(tagName).map((n) => [n.toLowerCase(), n])).values()];
  await db.transaction(async (tx) => {
    const existing = wanted.length
      ? await tx
          .select()
          .from(schema.tag)
          .where(
            and(
              eq(schema.tag.organizationId, organizationId),
              inArray(
                sql`lower(${schema.tag.name})`,
                wanted.map((n) => n.toLowerCase()),
              ),
            ),
          )
      : [];
    const ids = existing.map((t) => t.id);
    for (const n of wanted) {
      if (existing.some((t) => t.name.toLowerCase() === n.toLowerCase())) continue;
      const [created] = await tx
        .insert(schema.tag)
        .values({ id: newId(), organizationId, name: n, deploySecret: newTagSecret() })
        .onConflictDoNothing()
        .returning({ id: schema.tag.id });
      if (created) ids.push(created.id);
    }
    await tx.delete(schema.serviceTag).where(eq(schema.serviceTag.serviceId, serviceId));
    if (ids.length) await tx.insert(schema.serviceTag).values(ids.map((tagId) => ({ serviceId, tagId })));
  });
}

/** Services of a tag (previews never: they follow their app). */
export async function servicesOfTag(tagId: string) {
  return db
    .select({ service: schema.service })
    .from(schema.serviceTag)
    .innerJoin(schema.service, eq(schema.service.id, schema.serviceTag.serviceId))
    .where(and(eq(schema.serviceTag.tagId, tagId), isNull(schema.service.parentServiceId)))
    .then((rows) => rows.map((r) => r.service));
}

/**
 * Deploys every service of a tag the caller may reach. Apps without a source are left out; each
 * deploy follows its project's rules (a freeze skips it, an approval holds it).
 */
export async function deployTag(tagId: string, opts: { trigger: DeploymentTrigger; userId?: string | null; canAccessProject?: (projectId: string) => boolean }) {
  const { queueDeployment } = await import("@/server/services/create");
  const queued: { serviceId: string; deploymentId: string }[] = [];
  const skipped: { service: string; reason: string }[] = [];
  for (const s of await servicesOfTag(tagId)) {
    if (opts.canAccessProject && !opts.canAccessProject(s.projectId)) continue;
    if (s.type === "app" && !s.source) {
      skipped.push({ service: s.name, reason: "no source" });
      continue;
    }
    try {
      const deploymentId = await queueDeployment(s.id, opts.trigger, { userId: opts.userId ?? null });
      // A hook call (no user) gets a cancelled record when a freeze or a full queue skips it.
      const [d] = await db.select({ status: schema.deployment.status, error: schema.deployment.error }).from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
      if (d?.status === "cancelled") skipped.push({ service: s.name, reason: d.error ?? "skipped" });
      else queued.push({ serviceId: s.id, deploymentId });
    } catch (e) {
      skipped.push({ service: s.name, reason: (e as Error).message });
    }
  }
  return { queued, skipped };
}
