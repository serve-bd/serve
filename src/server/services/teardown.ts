import { and, eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { CANCEL_CHANNEL, enqueue } from "@/server/queue";
import { runServerIds } from "@/server/deploy/distribution";

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
  // Domains go with their services: previews also take their DNS records along (Serve made them for
  // the preview), and tunnels stop routing the removed hostnames.
  const domains = await db
    .select()
    .from(schema.domain)
    .where(
      inArray(
        schema.domain.serviceId,
        all.map((s) => s.id),
      ),
    );
  const previewIds = new Set(all.filter((s) => s.previewPr !== null).map((s) => s.id));
  if (domains.some((d) => previewIds.has(d.serviceId) && d.cloudflareRecordId)) {
    const { Cloudflare } = await import("@/server/cloudflare/api");
    for (const d of domains) {
      if (!previewIds.has(d.serviceId) || !d.cloudflareAccountId || !d.cloudflareZoneId || !d.cloudflareRecordId) continue;
      await Cloudflare.forAccount(d.cloudflareAccountId)
        .then((cf) => cf.deleteDnsRecord(d.cloudflareZoneId!, d.cloudflareRecordId!))
        .catch(() => {});
    }
  }
  await db.delete(schema.service).where(
    inArray(
      schema.service.id,
      all.map((s) => s.id),
    ),
  );
  const tunnels = [...new Set(domains.map((d) => d.tunnelId).filter((id): id is string => !!id))];
  if (tunnels.length) {
    const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
    for (const id of tunnels) await syncTunnelIngress(id).catch(() => {});
  }
  // Same concurrency key as deployments, so cleanup runs after an in-flight deploy stops.
  for (const s of all) {
    await enqueue(
      "service.delete",
      { serviceId: s.id, slug: s.slug, type: s.type, removeVolumes, environmentId: s.environmentId, serverId: s.serverId },
      { concurrencyKey: `service:${s.id}` },
    );
    // Extra servers (build once, run on many) have their own containers, sites and volumes.
    for (const serverId of runServerIds(s.serverId, s.distribution).slice(1)) {
      await enqueue(
        "service.delete",
        { serviceId: s.id, slug: s.slug, type: s.type, removeVolumes, environmentId: s.environmentId, serverId, keepFiles: true },
        { concurrencyKey: `service:${s.id}` },
      );
    }
  }
}
