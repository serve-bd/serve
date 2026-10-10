"use server";

import { and, eq } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { logActivity } from "@/server/activity";
import { requirePermission } from "@/server/auth";
import { Cloudflare } from "@/server/cloudflare/api";
import { db, schema } from "@/server/db";
import { normalizeDistribution } from "@/server/deploy/distribution";
import { syncServiceProxy } from "@/server/proxy/nginx";
import { getServer } from "@/server/servers/context";
import { serviceInOrg } from "@/server/services/access";
import { type ClosestRestore, closestServerPlan, type DomainBefore, restorePlan } from "@/server/services/closest-server";
import { entryPlan, entryProblem } from "@/server/services/entry-plan";
import { entryDomains, entryServers } from "@/server/services/entry-servers";
import { ensureCertificateFor } from "@/server/ssl/certificates";
import { enqueue } from "@/server/queue";

async function loadApp(serviceId: string) {
  const ctx = await requirePermission("services.manage");
  // Tunnels and DNS records are admin work, as for a domain's route.
  if (!ctx.isAdmin) throw new UserError("Only organization admins can change how visitors reach an app.");
  const { service } = await serviceInOrg(serviceId, ctx.org.id);
  if (service.type !== "app") throw new UserError("Only apps run on several servers.");
  if (service.parentServiceId) throw new UserError("Preview deployments follow their parent service.");
  const [shared] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.serviceId, serviceId));
  return { ctx, service, shared: shared ?? null };
}

/**
 * Turn Closest server on: one Cloudflare Tunnel with a connector on every server of the app, and
 * the app's domains in `accountId`'s zones pointed at it. Load balancing goes off: each server
 * serves its own visitors. Domains outside the account keep going to the main server.
 */
export async function enableClosestServer(serviceId: string, accountId: string) {
  return act(async () => {
    const { ctx, service, shared } = await loadApp(serviceId);
    if (shared) {
      // Turned off a moment ago, it still serves while Cloudflare moves the names: it can go now.
      const [used] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.tunnelId, shared.id)).limit(1);
      if (used) throw new UserError("Closest server is already on.");
      const { deleteTunnel } = await import("@/server/cloudflare/tunnels");
      await deleteTunnel(shared.id);
    }
    if (!normalizeDistribution(service.serverId, service.distribution).extraServerIds.length)
      throw new UserError("Run the app on another server first: tick one in Servers and deploy.");
    const [account] = await db
      .select({ id: schema.cloudflareAccount.id, name: schema.cloudflareAccount.name })
      .from(schema.cloudflareAccount)
      .where(and(eq(schema.cloudflareAccount.id, accountId), eq(schema.cloudflareAccount.organizationId, ctx.org.id)));
    if (!account) throw new UserError("Cloudflare account not found.");

    // Every server's proxy serves the visitors that reach it, under the one name the tunnel uses.
    const servers = await entryServers(service, ctx.org.id);
    for (const s of servers) {
      const problem = entryProblem({ ...s, sharedTunnel: true });
      if (problem) throw new UserError(problem);
      const server = await getServer(s.id);
      if (server.proxyContainer !== "serve-proxy")
        throw new UserError(`The proxy on ${s.name} is named ${server.proxyContainer}, not serve-proxy, so the shared tunnel cannot reach it.`);
    }

    const cf = await Cloudflare.forAccount(account.id);
    const zones = await cf.zones().catch((e: Error) => {
      throw new UserError(`Could not read the zones of ${account.name}: ${e.message}`);
    });
    const domains = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, serviceId));
    const plan = closestServerPlan(domains, zones);
    if (!plan.move.length)
      throw new UserError(
        domains.length
          ? `No domain of this app can go through ${account.name}: ${plan.stay.map((d) => `${d.hostname} is ${d.reason}`).join("; ")}.`
          : "Add a domain to the app first.",
      );

    const { createAppTunnel, deleteTunnel, syncTunnelIngress, TUNNEL_SETTLE_MS } = await import("@/server/cloudflare/tunnels");
    let tunnel: Awaited<ReturnType<typeof createAppTunnel>>;
    try {
      tunnel = await createAppTunnel({ organizationId: ctx.org.id, cloudflareAccountId: account.id, service, hostnames: plan.move.map((d) => d.hostname) });
    } catch (e) {
      throw new UserError((e as Error).message);
    }

    // The connectors run and the routes are set: now the names move, one by one.
    const moved: string[] = [];
    const failed: string[] = [];
    const previousTunnels = new Set<string>();
    // How each domain was reached, so turning Closest server off goes back to exactly that.
    const before: ClosestRestore = { loadBalance: typeof service.distribution?.loadBalance === "boolean" ? service.distribution.loadBalance : null, domains: {} };
    for (const m of plan.move) {
      const d = domains.find((x) => x.id === m.id)!;
      try {
        const a = d.tunnelId ? undefined : (await cf.dnsRecords(m.zoneId, { name: d.hostname })).find((x) => x.type === "A");
        const was: DomainBefore = {
          record: d.tunnelId ? "tunnel" : a ? "a" : "none",
          tunnelId: d.tunnelId,
          proxied: a?.proxied ?? true,
          https: d.https,
          forceHttps: d.forceHttps,
          certificateId: d.certificateId,
          wantsTunnel: d.wantsTunnel,
        };
        // Saved before the name moves: a request cut off mid-way still knows how to go back.
        before.domains[d.id] = was;
        await db.update(schema.cloudflareTunnel).set({ restore: before }).where(eq(schema.cloudflareTunnel.id, tunnel.id));
        const record = await cf.upsertTunnelRecord(m.zoneId, d.hostname, tunnel.cfTunnelId);
        if (d.tunnelId) previousTunnels.add(d.tunnelId);
        // Cloudflare ends HTTPS; the tunnel reaches each server's proxy over plain HTTP.
        await db
          .update(schema.domain)
          .set({
            tunnelId: tunnel.id,
            wantsTunnel: true,
            tunnelError: null,
            https: false,
            forceHttps: false,
            cloudflareAccountId: account.id,
            cloudflareZoneId: m.zoneId,
            cloudflareRecordId: record.id,
          })
          .where(eq(schema.domain.id, d.id));
        moved.push(d.hostname);
      } catch (e) {
        failed.push(`${d.hostname}: ${(e as Error).message}`);
      }
    }
    if (!moved.length) {
      await deleteTunnel(tunnel.id).catch(() => {});
      throw new UserError(`No domain moved to the shared tunnel. ${failed.join(" ")}`);
    }

    // Each server serves its own visitors now: the main server stops sending them to the others.
    await db
      .update(schema.service)
      .set({ distribution: { ...(service.distribution ?? {}), loadBalance: false }, balance: null })
      .where(eq(schema.service.id, serviceId));
    const warnings: string[] = [...failed];
    // Only the names that moved stay routed. The tunnels they left keep their route a few minutes:
    // Cloudflare's offices take that long to send the names to the new tunnel.
    await syncTunnelIngress(tunnel.id).catch((e) => warnings.push(`Tunnel routes: ${(e as Error).message}`));
    if (previousTunnels.size) await enqueue("cloudflare-tunnel.settle", { sync: [...previousTunnels] }, { runAt: new Date(Date.now() + TUNNEL_SETTLE_MS) });
    await syncServiceProxy(serviceId).catch((e) => warnings.push(`Proxy not updated: ${(e as Error).message}`));

    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.closest-server",
      targetType: "service",
      targetId: serviceId,
      message: `Visitors of ${service.name} now reach their closest server through ${account.name} (${moved.join(", ")})`,
    });
    return { moved, stay: plan.stay.map((d) => `${d.hostname} stays on the main server: it is ${d.reason}.`), warnings };
  });
}

/**
 * Turn Closest server off: every domain goes back to how it was reached before it was turned on
 * (its server tunnel, its A record, now to the main server's IP, or no record), and load balancing
 * to what it was. A domain added meanwhile, or whose tunnel is gone, goes to the main server the
 * usual way: its own tunnel of the account, or its public IP. Refused up front when a domain would
 * have nowhere to go; one that fails to move keeps the shared tunnel running.
 */
export async function disableClosestServer(serviceId: string) {
  return act(async () => {
    const { ctx, service, shared } = await loadApp(serviceId);
    if (!shared) return { warnings: [] as string[] };
    const [used] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.tunnelId, shared.id)).limit(1);
    // Already off: it only serves until Cloudflare has moved the names.
    if (!used) return { warnings: [] as string[] };
    const servers = await entryServers(service, ctx.org.id);
    const main = servers.find((s) => s.main);
    if (!main) throw new UserError("Main server not found.");
    const onTunnel = (await entryDomains(serviceId)).filter((d) => d.tunnelId === shared.id);
    const restore = restorePlan(onTunnel, shared.restore ?? null, { name: main.name, publicIp: main.publicIp, tunnelIds: main.tunnels.map((t) => t.id) });
    // The rest as if moving to the main server: through its tunnel of the account, or its public IP.
    const plan = entryPlan(
      main,
      onTunnel.filter((d) => restore.fallback.includes(d.id)).map((d) => ({ ...d, sharedTunnel: false })),
    );
    const blockers = [...restore.blockers, ...plan.blockers];
    if (blockers.length) throw new UserError(blockers.join(" "));

    const { syncTunnelIngress, TUNNEL_SETTLE_MS } = await import("@/server/cloudflare/tunnels");
    const rows = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, serviceId));
    const failed: string[] = [];
    const toTunnel = async (d: (typeof rows)[number], tunnelId: string, set: Partial<typeof schema.domain.$inferInsert> = {}) => {
      const [target] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, tunnelId));
      if (!target) throw new Error("the main server's tunnel is gone");
      // The route first, then the name: no moment where the name leads to a tunnel without it.
      await db.update(schema.domain).set({ tunnelId: target.id, cloudflareAccountId: target.cloudflareAccountId }).where(eq(schema.domain.id, d.id));
      await syncTunnelIngress(target.id);
      const cf = await Cloudflare.forAccount(target.cloudflareAccountId);
      const record = await cf.upsertTunnelRecord(d.cloudflareZoneId!, d.hostname, target.cfTunnelId).catch(async (e) => {
        await db.update(schema.domain).set({ tunnelId: shared.id, cloudflareAccountId: d.cloudflareAccountId }).where(eq(schema.domain.id, d.id));
        throw e;
      });
      await db
        .update(schema.domain)
        .set({ ...set, wantsTunnel: true, tunnelError: null, https: false, forceHttps: false, cloudflareRecordId: record.id })
        .where(eq(schema.domain.id, d.id));
    };
    const toRecord = async (d: (typeof rows)[number], ip: string, proxied: boolean, set: Partial<typeof schema.domain.$inferInsert>) => {
      const cf = await Cloudflare.forAccount(d.cloudflareAccountId!);
      // Serve's CNAME to the shared tunnel goes in upsertARecord, which replaces its own records.
      const record = await cf.upsertARecord(d.cloudflareZoneId!, d.hostname, ip, proxied);
      const [updated] = await db
        .update(schema.domain)
        .set({ ...set, tunnelId: null, wantsTunnel: false, tunnelError: null, cloudflareRecordId: record?.id ?? null })
        .where(eq(schema.domain.id, d.id))
        .returning();
      if (updated?.https) await ensureCertificateFor(updated, ctx.org.id, { requestNow: true }).catch(() => null);
    };
    for (const move of restore.moves) {
      const d = rows.find((r) => r.id === move.id);
      if (!d?.cloudflareZoneId || !d.cloudflareAccountId) continue;
      const b = move.before;
      try {
        if (move.kind === "tunnel") await toTunnel(d, move.tunnelId, { certificateId: b.certificateId });
        else if (move.kind === "a") await toRecord(d, move.ip, b.proxied, { https: b.https, forceHttps: b.forceHttps, certificateId: b.certificateId });
        else {
          // It had no record: Serve's CNAME to the shared tunnel goes, and the name leads nowhere again.
          const cf = await Cloudflare.forAccount(d.cloudflareAccountId);
          if (d.cloudflareRecordId) await cf.removeDnsRecord(d.cloudflareZoneId, d.cloudflareRecordId);
          await db
            .update(schema.domain)
            .set({
              tunnelId: null,
              wantsTunnel: b.wantsTunnel,
              tunnelError: null,
              https: b.https,
              forceHttps: b.forceHttps,
              certificateId: b.certificateId,
              cloudflareRecordId: null,
            })
            .where(eq(schema.domain.id, d.id));
        }
      } catch (e) {
        failed.push(`${d.hostname}: ${(e as Error).message}`);
      }
    }
    for (const move of plan.moves) {
      const d = rows.find((r) => r.id === move.domainId);
      if (!d?.cloudflareZoneId) continue;
      try {
        if (move.kind === "tunnel") await toTunnel(d, move.tunnelId);
        else if (move.kind === "untunnel" && d.cloudflareAccountId) await toRecord(d, move.ip, true, { https: true, forceHttps: true });
      } catch (e) {
        failed.push(`${d.hostname}: ${(e as Error).message}`);
      }
    }
    await syncServiceProxy(serviceId).catch(() => {});
    if (failed.length) {
      // The names that did move leave its routes once Cloudflare has caught up, not now.
      await enqueue("cloudflare-tunnel.settle", { sync: [shared.id] }, { runAt: new Date(Date.now() + TUNNEL_SETTLE_MS) });
      throw new UserError(`Closest server stays on until every domain has moved back. ${failed.join(" ")}`);
    }
    // Load balancing as it was before.
    if (shared.restore && shared.restore.loadBalance !== null) {
      const [now] = await db.select({ distribution: schema.service.distribution }).from(schema.service).where(eq(schema.service.id, serviceId));
      await db
        .update(schema.service)
        .set({ distribution: { ...(now?.distribution ?? {}), loadBalance: shared.restore.loadBalance } })
        .where(eq(schema.service.id, serviceId));
      await syncServiceProxy(serviceId).catch(() => {});
    }
    // Off means gone, once Cloudflare stops sending the names to it (until then it still serves them):
    // its connectors and the tunnel on Cloudflare go in a few minutes. Pages no longer show it.
    await enqueue("cloudflare-tunnel.settle", { sync: [], remove: [shared.id] }, { runAt: new Date(Date.now() + TUNNEL_SETTLE_MS) });

    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.closest-server",
      targetType: "service",
      targetId: serviceId,
      message: `Visitors of ${service.name} enter through ${main.name} again`,
    });
    return { warnings: [] as string[] };
  });
}
