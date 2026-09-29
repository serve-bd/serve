import { and, eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { CANCEL_CHANNEL, enqueue } from "@/server/queue";

/** Cancel work, delete rows and queue container cleanup for services, their previews and preview databases. */
export async function teardownServices(services: (typeof schema.service.$inferSelect)[], removeVolumes: boolean) {
  const ids = services.map((s) => s.id);
  if (!ids.length) return;
  // Previews, and what belongs to them (their database copies), all the way down.
  const all = [...services];
  let parents = ids;
  while (parents.length) {
    const children = (await db.select().from(schema.service).where(inArray(schema.service.parentServiceId, parents))).filter((c) => !all.some((s) => s.id === c.id));
    all.push(...children);
    parents = children.map((c) => c.id);
  }
  for (const s of all) {
    const active = await db
      .select({ id: schema.deployment.id, status: schema.deployment.status })
      .from(schema.deployment)
      .where(and(eq(schema.deployment.serviceId, s.id), inArray(schema.deployment.status, ["queued", "building", "deploying"])));
    for (const d of active) {
      if (d.status === "queued") await db.update(schema.deployment).set({ status: "cancelled" }).where(eq(schema.deployment.id, d.id));
      else await sql.notify(CANCEL_CHANNEL, d.id);
    }
  }
  // Remove repository webhooks Serve registered (best effort; the provider may be unreachable).
  const { removeRepoWebhook } = await import("@/server/git/repo-webhooks");
  for (const s of services) if (!s.parentServiceId && s.source?.type === "git" && s.source.webhook?.id) await removeRepoWebhook(s.source);
  await db.delete(schema.service).where(
    inArray(
      schema.service.id,
      all.map((s) => s.id),
    ),
  );
  // Same concurrency key as deployments, so cleanup runs after an in-flight deploy stops.
  for (const s of all) {
    await enqueue(
      "service.delete",
      { serviceId: s.id, slug: s.slug, type: s.type, removeVolumes, environmentId: s.environmentId, serverId: s.serverId },
      { concurrencyKey: `service:${s.id}` },
    );
  }
}
