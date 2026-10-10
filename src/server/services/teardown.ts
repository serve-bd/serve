import { replicaInstances } from "@/server/services/types";
import { removePreviewBranches } from "@/server/databases/branches";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { CANCEL_CHANNEL, enqueue } from "@/server/queue";
import { runServerIds } from "@/server/deploy/distribution";
import { leftover, recordLeftovers } from "./leftovers";

/** Cancel work, delete rows and queue container cleanup for services, their previews and preview databases. */
/**
 * `leaveRunning`: Serve only forgets the services (a server removed with its services kept): their
 * containers, the DNS records and certificates they use stay as they are on the machine.
 * `inline`: their containers are removed now, not by a job (the server row goes right after).
 */
export async function teardownServices(
  services: (typeof schema.service.$inferSelect)[],
  removeVolumes: boolean,
  opts: { leaveRunning?: boolean; inline?: boolean; userId?: string | null } = {},
): Promise<string | null> {
  if (!services.length) return null;
  const leftovers: string[] = [];
  await teardown(services, removeVolumes, opts, leftovers);
  // Returns the warning for whoever asked; the activity log keeps it for everyone else.
  return recordLeftovers(leftovers, { projectId: services[0].projectId, userId: opts.userId });
}

async function teardown(services: (typeof schema.service.$inferSelect)[], removeVolumes: boolean, opts: { leaveRunning?: boolean; inline?: boolean }, leftovers: string[]) {
  const ids = services.map((s) => s.id);
  // Previews, and what belongs to them (their database copies), all the way down.
  const all = [...services];
  let parents = ids;
  while (parents.length) {
    const children = (await db.select().from(schema.service).where(inArray(schema.service.parentServiceId, parents))).filter((c) => !all.some((s) => s.id === c.id));
    all.push(...children);
    parents = children.map((c) => c.id);
  }
  // Branches made for these previews live in another database's container: drop them there.
  await removePreviewBranches(all.map((s) => s.id));
  for (const s of all) {
    const active = await db
      .select({ id: schema.deployment.id, status: schema.deployment.status })
      .from(schema.deployment)
      .where(and(eq(schema.deployment.serviceId, s.id), inArray(schema.deployment.status, ["queued", "building", "deploying"])));
    for (const d of active) {
      if (d.status === "queued")
        await db
          .update(schema.deployment)
          .set({ status: "cancelled", finishedAt: new Date() })
          .where(and(eq(schema.deployment.id, d.id), eq(schema.deployment.status, "queued")));
      else await sql.notify(CANCEL_CHANNEL, d.id);
    }
  }
  // Remove repository webhooks Serve registered (best effort; the provider may be unreachable).
  const { removeRepoWebhook } = await import("@/server/git/repo-webhooks");
  for (const s of services) if (!s.parentServiceId && s.source?.type === "git" && s.source.webhook?.id) await removeRepoWebhook(s.source);
  // Domains go with their services, and so do the DNS records Serve made for them; tunnels stop
  // routing the removed hostnames.
  const domains = await db
    .select()
    .from(schema.domain)
    .where(
      inArray(
        schema.domain.serviceId,
        all.map((s) => s.id),
      ),
    );
  if (!opts.leaveRunning && domains.some((d) => d.cloudflareRecordId)) {
    const { Cloudflare } = await import("@/server/cloudflare/api");
    for (const d of domains) {
      if (!d.cloudflareAccountId || !d.cloudflareZoneId || !d.cloudflareRecordId) continue;
      await Cloudflare.forAccount(d.cloudflareAccountId)
        .then((cf) => cf.removeDnsRecord(d.cloudflareZoneId!, d.cloudflareRecordId!))
        .catch(leftover(leftovers, `DNS record of ${d.hostname}`));
    }
  }
  // Read replicas on other servers than the database's: the delete job there only covers its own server.
  for (const s of opts.leaveRunning ? [] : all) {
    for (const r of replicaInstances(s).filter((r) => r.serverId !== s.serverId)) {
      const { removeReplicaInstance } = await import("@/server/databases/addons");
      await removeReplicaInstance(s, r).catch(leftover(leftovers, `Read replica ${r.id} of ${s.name}`));
    }
  }
  const retire: Retire[] = [];
  if (!opts.leaveRunning) await removeDatabaseDomainRecords(all, retire, leftovers);
  // Databases deleted with their data kept: remembered, so a new database can start from it.
  // One never deployed has no data to keep.
  if (!removeVolumes) await keepDatabases(services.filter((s) => s.type === "database" && s.database && !s.parentServiceId && s.currentDeploymentId));
  // Apps' and stacks' volumes too, shown on the canvas until someone deletes them. A server removed
  // with its services kept keeps everything as it is: nothing is recorded then.
  if (!removeVolumes && !opts.leaveRunning)
    await keepVolumes(
      services.filter((s) => (s.type === "app" || s.type === "compose") && !s.parentServiceId && s.currentDeploymentId),
      leftovers,
    );
  // Apps' shared tunnels ("closest server"): their connectors and the tunnel on Cloudflare go with them
  // (deleting the rows below would only forget them). Their domains' records went above.
  if (!opts.leaveRunning) {
    const shared = await db
      .select({ id: schema.cloudflareTunnel.id })
      .from(schema.cloudflareTunnel)
      .where(
        inArray(
          schema.cloudflareTunnel.serviceId,
          all.map((s) => s.id),
        ),
      );
    if (shared.length) {
      const { deleteTunnel } = await import("@/server/cloudflare/tunnels");
      for (const t of shared) await deleteTunnel(t.id).catch(leftover(leftovers, "Cloudflare Tunnel of the closest server"));
    }
  }
  await db.delete(schema.service).where(
    inArray(
      schema.service.id,
      all.map((s) => s.id),
    ),
  );
  // The certificates Serve got for the names given up go too, once nothing else uses them (checked
  // when the job runs, so after the rows above are gone).
  if (retire.length) {
    const { retireCertificateFor } = await import("@/server/ssl/certificates");
    for (const r of retire) await retireCertificateFor(r.hostname, r.serverId, r.organizationId).catch(leftover(leftovers, `Certificate for ${r.hostname}`));
  }
  const tunnels = [
    ...new Set(
      [...domains.map((d) => d.tunnelId), ...all.map((s) => s.database?.domainTunnelId), ...all.map((s) => s.database?.pooler?.public?.tunnelId)].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  if (tunnels.length) {
    const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
    for (const id of tunnels) await syncTunnelIngress(id).catch(leftover(leftovers, "Cloudflare Tunnel routes"));
  }
  if (opts.leaveRunning) return;
  // Same concurrency key as deployments, so cleanup runs after an in-flight deploy stops.
  for (const s of all) {
    if (opts.inline) {
      const { destroyService } = await import("@/server/services/lifecycle");
      await destroyService({
        serviceId: s.id,
        slug: s.slug,
        type: s.type,
        removeVolumes,
        environmentId: s.environmentId,
        serverId: s.serverId,
        volumes: s.database?.dataVolume && s.database.dataVolumeOwned && !s.database.dataVolume.startsWith("/") ? [s.database.dataVolume] : [],
      }).catch(leftover(leftovers, `Containers of ${s.name}`));
    } else
      await enqueue(
        "service.delete",
        {
          serviceId: s.id,
          slug: s.slug,
          type: s.type,
          removeVolumes,
          environmentId: s.environmentId,
          serverId: s.serverId,
          volumes: s.database?.dataVolume && s.database.dataVolumeOwned && !s.database.dataVolume.startsWith("/") ? [s.database.dataVolume] : [],
        },
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

type Retire = { hostname: string; serverId: string; organizationId: string };

async function keepDatabases(services: (typeof schema.service.$inferSelect)[]) {
  if (!services.length) return;
  const { volumeName } = await import("@/server/deploy/containers");
  const { newId } = await import("@/server/id");
  const projects = await db
    .select({ id: schema.project.id, organizationId: schema.project.organizationId })
    .from(schema.project)
    .where(inArray(schema.project.id, [...new Set(services.map((s) => s.projectId))]));
  const orgOf = new Map(projects.map((p) => [p.id, p.organizationId]));
  const rows = services.flatMap((s) => {
    const cfg = s.database!;
    const organizationId = orgOf.get(s.projectId);
    if (!organizationId) return [];
    return [
      {
        id: newId(),
        organizationId,
        serverId: s.serverId,
        name: s.name,
        engine: cfg.engine,
        version: cfg.version,
        image: cfg.image ?? null,
        username: cfg.username,
        password: cfg.password,
        database: cfg.database,
        volume: cfg.dataVolume || volumeName(s.slug, "data"),
        owned: !cfg.dataVolume || !!cfg.dataVolumeOwned,
        dataMountPath: cfg.dataMountPath ?? null,
        pgdata: cfg.pgdata ?? null,
        projectId: s.projectId,
        environmentId: s.environmentId,
      },
    ];
  });
  if (rows.length) await db.insert(schema.keptDatabase).values(rows);
}

/** How long a server gets to list a stack's volumes before the delete goes on without them. */
const LIST_VOLUMES_MS = 15_000;

/**
 * The named volumes apps and stacks leave behind. Volumes made outside Serve are not Serve's to
 * show or delete: left out. A stack's volumes are the ones compose labelled with its project (the slug).
 */
async function keepVolumes(services: (typeof schema.service.$inferSelect)[], leftovers: string[]) {
  if (!services.length) return;
  const { volumeName } = await import("@/server/deploy/containers");
  const { newId } = await import("@/server/id");
  const projects = await db
    .select({ id: schema.project.id, organizationId: schema.project.organizationId })
    .from(schema.project)
    .where(inArray(schema.project.id, [...new Set(services.map((s) => s.projectId))]));
  const orgOf = new Map(projects.map((p) => [p.id, p.organizationId]));
  const rows: (typeof schema.keptVolume.$inferInsert)[] = [];
  for (const s of services) {
    const organizationId = orgOf.get(s.projectId);
    if (!organizationId) continue;
    const base = { organizationId, projectId: s.projectId, environmentId: s.environmentId, serviceName: s.name, owned: true };
    if (s.type === "app") {
      // Each server the app ran on has its own copy of its volumes.
      for (const serverId of runServerIds(s.serverId, s.distribution))
        for (const v of s.runtime.volumes.filter((v) => v.kind === "volume" && !v.external))
          rows.push({ ...base, id: newId(), serverId, serviceType: "app", volume: volumeName(s.slug, v.source), mountPath: v.mountPath });
      continue;
    }
    try {
      const { getServer } = await import("@/server/servers/context");
      const { withTimeout } = await import("@/server/monitoring/containers");
      const { docker } = await getServer(s.serverId);
      const list = await withTimeout(docker.listVolumes({ filters: { label: [`com.docker.compose.project=${s.slug}`] } }), LIST_VOLUMES_MS);
      for (const v of list.Volumes ?? []) rows.push({ ...base, id: newId(), serverId: s.serverId, serviceType: "compose", volume: v.Name, mountPath: null });
    } catch (e) {
      leftover(leftovers, `Volumes of ${s.name} stay on its server but could not be listed in Serve`)(e);
    }
  }
  if (rows.length) await db.insert(schema.keptVolume).values(rows);
}

/** The DNS records Serve made for databases' own domains (marked by their comment), never anyone else's. */
async function removeDatabaseDomainRecords(services: (typeof schema.service.$inferSelect)[], retire: Retire[], leftovers: string[]) {
  // Each database's own domain, its pooler's and its replicas' (on every server they run on).
  const names = services
    .filter((s) => !s.parentServiceId && s.database)
    .flatMap((s) => {
      const cfg = s.database!;
      const out: { service: typeof s; hostname: string; servers: string[]; own: boolean }[] = [];
      if (cfg.domain) out.push({ service: s, hostname: cfg.domain, servers: [s.serverId], own: true });
      if (cfg.pooler?.public?.domain) out.push({ service: s, hostname: cfg.pooler.public.domain, servers: [s.serverId], own: false });
      if (cfg.replica?.public?.domain) out.push({ service: s, hostname: cfg.replica.public.domain, servers: [...new Set(replicaInstances(s).map((r) => r.serverId))], own: false });
      return out;
    });
  if (!names.length) return;
  const { cloudflareAccountFor } = await import("@/server/ssl/certificates");
  const { Cloudflare } = await import("@/server/cloudflare/api");
  const { DATABASE_DNS_COMMENT } = await import("@/lib/database-domains");
  const removed = new Set(services.map((s) => s.id));
  for (const { service: s, hostname, servers, own } of names) {
    try {
      // Another database still on this name (a copy made before copies dropped the domain) keeps the record.
      if (own) {
        const others = await db.select({ id: schema.service.id }).from(schema.service).where(dsql`lower(${schema.service.database}->>'domain') = ${hostname.toLowerCase()}`);
        if (others.some((o) => !removed.has(o.id))) continue;
      }
      const [project] = await db.select({ organizationId: schema.project.organizationId }).from(schema.project).where(eq(schema.project.id, s.projectId));
      if (project) for (const serverId of servers) retire.push({ hostname, serverId, organizationId: project.organizationId });
      const accountId = project ? await cloudflareAccountFor([hostname], project.organizationId) : null;
      if (!accountId) continue;
      const cf = await Cloudflare.forAccount(accountId);
      const zone = await cf.zoneFor(hostname);
      if (!zone) continue;
      for (const r of await cf.dnsRecords(zone.id, { name: hostname })) if (r.comment === DATABASE_DNS_COMMENT) await cf.deleteDnsRecord(zone.id, r.id);
    } catch (e) {
      // The account or Cloudflare may be unreachable: the hostname is free in Serve either way, and the record is reported.
      leftover(leftovers, `DNS record of ${hostname}`)(e);
    }
  }
}
