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
import { closestServerPlan } from "@/server/services/closest-server";
import { entryPlan, entryProblem } from "@/server/services/entry-plan";
import { entryDomains, entryServers } from "@/server/services/entry-servers";
import { ensureCertificateFor } from "@/server/ssl/certificates";

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
    if (shared) throw new UserError("Closest server is already on.");
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

    const { createAppTunnel, deleteTunnel, syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
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
    for (const m of plan.move) {
      const d = domains.find((x) => x.id === m.id)!;
      try {
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
    // Only the names that moved stay routed; the tunnels they left forget them.
    await syncTunnelIngress(tunnel.id).catch((e) => warnings.push(`Tunnel routes: ${(e as Error).message}`));
    for (const id of previousTunnels) await syncTunnelIngress(id).catch(() => {});
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
 * Turn Closest server off: the domains go back to the main server, through its own tunnel of the
 * same account or an A record to its public IP, and the shared tunnel is deleted. Refused up front
 * when a domain would have nowhere to go; a domain that fails to move keeps the tunnel running.
 */
export async function disableClosestServer(serviceId: string) {
  return act(async () => {
    const { ctx, service, shared } = await loadApp(serviceId);
    if (!shared) return { warnings: [] as string[] };
    const servers = await entryServers(service, ctx.org.id);
    const main = servers.find((s) => s.main);
    if (!main) throw new UserError("Main server not found.");
    const onTunnel = (await entryDomains(serviceId)).filter((d) => d.tunnelId === shared.id);
    // Planned as if moving to the main server: through its tunnel of the account, or its public IP.
    const plan = entryPlan(
      main,
      onTunnel.map((d) => ({ ...d, sharedTunnel: false })),
    );
    if (plan.blockers.length) throw new UserError(plan.blockers.join(" "));

    const { deleteTunnel, syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
    const rows = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, serviceId));
    const failed: string[] = [];
    const touched = new Set<string>();
    for (const move of plan.moves) {
      const d = rows.find((r) => r.id === move.domainId);
      if (!d?.cloudflareZoneId) continue;
      try {
        if (move.kind === "tunnel") {
          const [target] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, move.tunnelId));
          if (!target) throw new Error("the main server's tunnel is gone");
          // The route first, then the name: no moment where the name leads to a tunnel without it.
          await db.update(schema.domain).set({ tunnelId: target.id, cloudflareAccountId: target.cloudflareAccountId }).where(eq(schema.domain.id, d.id));
          await syncTunnelIngress(target.id);
          touched.add(target.id);
          const cf = await Cloudflare.forAccount(target.cloudflareAccountId);
          const record = await cf.upsertTunnelRecord(d.cloudflareZoneId, d.hostname, target.cfTunnelId).catch(async (e) => {
            await db.update(schema.domain).set({ tunnelId: shared.id, cloudflareAccountId: d.cloudflareAccountId }).where(eq(schema.domain.id, d.id));
            throw e;
          });
          await db.update(schema.domain).set({ cloudflareRecordId: record.id }).where(eq(schema.domain.id, d.id));
        } else if (move.kind === "untunnel" && d.cloudflareAccountId) {
          const cf = await Cloudflare.forAccount(d.cloudflareAccountId);
          // Serve's CNAME to the shared tunnel goes in upsertARecord, which replaces its own records.
          const record = await cf.upsertARecord(d.cloudflareZoneId, d.hostname, move.ip, true);
          const [updated] = await db
            .update(schema.domain)
            .set({ tunnelId: null, wantsTunnel: false, tunnelError: null, https: true, forceHttps: true, cloudflareRecordId: record?.id ?? null })
            .where(eq(schema.domain.id, d.id))
            .returning();
          if (updated) await ensureCertificateFor(updated, ctx.org.id, { requestNow: true }).catch(() => null);
        }
      } catch (e) {
        failed.push(`${d.hostname}: ${(e as Error).message}`);
      }
    }
    await syncServiceProxy(serviceId).catch(() => {});
    if (failed.length) {
      await syncTunnelIngress(shared.id).catch(() => {});
      throw new UserError(`Closest server stays on until every domain has moved back. ${failed.join(" ")}`);
    }
    await deleteTunnel(shared.id);
    for (const id of touched) await syncTunnelIngress(id).catch(() => {});

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
