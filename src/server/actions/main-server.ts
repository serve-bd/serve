"use server";

import { and, eq, inArray } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { logActivity } from "@/server/activity";
import { requirePermission } from "@/server/auth";
import { Cloudflare } from "@/server/cloudflare/api";
import { db, schema } from "@/server/db";
import { balances, normalizeDistribution, runServerIds } from "@/server/deploy/distribution";
import { balanceProblem } from "@/server/services/balance";
import { LABEL } from "@/server/docker/client";
import { requireServers } from "@/server/limits";
import { meshMemberIds, reachesPrivately } from "@/server/mesh/members";
import { syncServiceProxy } from "@/server/proxy/nginx";
import { resolveServerForOrg } from "@/server/servers/access";
import { getServer } from "@/server/servers/context";
import { serviceInOrg } from "@/server/services/access";
import { generatedHostname } from "@/server/services/create";
import { entryPlan, entryProblem, swappedExtras } from "@/server/services/entry-plan";
import { entryDomains, entryServers } from "@/server/services/entry-servers";
import { copyCertificate, ensureCertificateFor } from "@/server/ssl/certificates";
import { certificateCovers } from "@/server/ssl/match";

export type MainServerResult = {
  /** Names whose DNS the user manages: point them at this IP. */
  manual: { hostname: string; ip: string }[];
  warnings: string[];
};

/**
 * Make one of an app's extra servers its main one: visitors enter through it from now on. Nothing
 * is redeployed (it already runs the current version). Its proxy gets the domains, certificates
 * and load balancing, and the old main server becomes an extra server. Serve moves the DNS
 * records and tunnel routes it manages; the user moves the rest (the result says which).
 */
export async function setMainServer(serviceId: string, serverId: string) {
  return act(async (): Promise<MainServerResult> => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type !== "app") throw new UserError("Only apps run on several servers.");
    if (service.parentServiceId) throw new UserError("Preview deployments follow their parent service.");
    if (service.serverId === serverId) return { manual: [], warnings: [] };
    const dist = normalizeDistribution(service.serverId, service.distribution);
    if (!dist.extraServerIds.includes(serverId)) throw new UserError("Tick that server in Servers & registry and deploy first.");
    const target = await resolveServerForOrg(serverId, ctx.org.id);
    await requireServers(ctx.org.id, [target.id]);

    // Nothing may change the app's containers meanwhile: a deploy, a stop or a restart.
    const [busy] = await db
      .select({ id: schema.deployment.id })
      .from(schema.deployment)
      .where(and(eq(schema.deployment.serviceId, serviceId), inArray(schema.deployment.status, ["queued", "building", "deploying"])))
      .limit(1);
    if (busy) throw new UserError("Wait for the running deployment to finish first.");
    const [job] = await db
      .select({ id: schema.job.id })
      .from(schema.job)
      .where(and(eq(schema.job.concurrencyKey, `service:${serviceId}`), inArray(schema.job.status, ["pending", "running"])))
      .limit(1);
    if (job) throw new UserError("Wait for the app's running task (a start, stop or restart) to finish first.");
    if (service.status === "stopped") throw new UserError("Start the app first. A stopped app has nothing for the new main server to serve.");
    if (!service.currentDeploymentId) throw new UserError("Deploy the app first.");

    const servers = await entryServers(service, ctx.org.id);
    const next = servers.find((s) => s.id === serverId);
    const old = servers.find((s) => s.main);
    if (!next || !old) throw new UserError("Server not found.");
    const problem = entryProblem(next);
    if (problem) throw new UserError(problem);
    // Domains whose Cloudflare account was connected again find it first, so their records move too.
    const { domainCloudflare } = await import("@/server/cloudflare/domain-link");
    for (const d of await db.select().from(schema.domain).where(eq(schema.domain.serviceId, serviceId))) {
      if (d.cloudflareZoneId && !d.tunnelId && !d.generated) await domainCloudflare(d, ctx.org.id).catch(() => null);
    }
    const domains = await entryDomains(serviceId);
    const plan = entryPlan(next, domains);
    if (plan.blockers.length) throw new UserError(plan.blockers.join(" "));

    // Checked live: the database can be behind a proxy that crashed or containers that stopped.
    const nextCtx = await getServer(serverId);
    const proxyUp = await nextCtx.docker
      .getContainer(nextCtx.proxyContainer)
      .inspect()
      .then((c) => c.State.Running)
      .catch(() => false);
    if (!proxyUp) throw new UserError(`The proxy on ${next.name} is not running, so it cannot take visitors. Start it in the server's Proxy settings.`);
    const running = await nextCtx.docker
      .listContainers({ filters: { label: [`${LABEL.service}=${serviceId}`, `${LABEL.deployment}=${service.currentDeploymentId}`] } })
      .catch(() => []);
    if (!running.some((c) => c.Labels[LABEL.kind] !== "predeploy")) {
      throw new UserError(`The current version of this app is not running on ${next.name}. Redeploy, then try again.`);
    }

    // Services that reach this one by its private name through the old main server keep doing so.
    const members = await meshMemberIds();
    const runsOn = runServerIds(service.serverId, service.distribution);
    if (members.size) {
      const siblings = await db
        .select({ id: schema.service.id, name: schema.service.name, type: schema.service.type, serverId: schema.service.serverId, distribution: schema.service.distribution })
        .from(schema.service)
        .where(eq(schema.service.environmentId, service.environmentId));
      const lost = siblings.filter((s) => {
        if (s.id === serviceId) return false;
        const from = runServerIds(s.serverId, s.type === "app" ? s.distribution : null);
        return reachesPrivately(members, from, { serverId: service.serverId, servers: runsOn }) && !reachesPrivately(members, from, { serverId, servers: runsOn });
      });
      if (lost.length) {
        throw new UserError(
          `${lost.map((s) => s.name).join(", ")} ${lost.length === 1 ? "reaches" : "reach"} this app by its private name and ${lost.length === 1 ? "has" : "have"} no private network with ${next.name}. Connect the servers first.`,
        );
      }
    }

    // With load balancing, the new main server must reach every other server it will balance over.
    if (balances(service.serverId, service.distribution)) {
      const apart = await balanceProblem(
        serverId,
        runsOn.filter((id) => id !== serverId),
      );
      if (apart) throw new UserError(apart);
    }

    const warnings: string[] = [];
    // HTTPS keeps working at once: the new main server gets the certificates the old one serves.
    // Caddy and Traefik get their own (once DNS points at the server, or through Cloudflare DNS).
    // Domain id → its certificate on the new main server, for domains that picked one.
    const certIds = new Map<string, string>();
    if (next.proxyKind === "nginx") {
      const httpsDomains = await db
        .select()
        .from(schema.domain)
        .where(and(eq(schema.domain.serviceId, serviceId), eq(schema.domain.https, true)));
      const certs = await db
        .select()
        .from(schema.certificate)
        .where(and(eq(schema.certificate.organizationId, ctx.org.id), inArray(schema.certificate.serverId, [old.id, serverId])));
      const there = certs.filter((c) => c.serverId === serverId);
      for (const d of httpsDomains) {
        const have = there.find((c) => c.status === "active" && certificateCovers(c.domains, d.hostname));
        // A picked certificate of the old server is replaced by the one there.
        if (have) {
          if (d.certificateId && d.certificateId !== have.id) certIds.set(d.id, have.id);
          continue;
        }
        const source = certs.find((c) => c.serverId === old.id && c.certPath && (c.id === d.certificateId || certificateCovers(c.domains, d.hostname)) && c.status === "active");
        if (!source) continue;
        try {
          const copy = await copyCertificate(source, serverId);
          there.push(copy);
          if (d.certificateId) certIds.set(d.id, copy.id);
        } catch (e) {
          warnings.push(`The certificate of ${d.hostname} was not copied (${(e as Error).message}). Serve requests a new one.`);
        }
      }
    } else if (domains.some((d) => !d.tunnelId)) {
      warnings.push(`${next.proxyKind === "caddy" ? "Caddy" : "Traefik"} on ${next.name} gets its own certificates. HTTPS can take a minute after DNS points there.`);
    }

    // Up to date before the switch: still up to date after it, unless the ${{server.KEY}} values
    // the app uses differ on the new server (the running replicas have the old server's).
    const { configFingerprint, redeployNeeded } = await import("@/server/services/fingerprint");
    const wasCurrent = (await redeployNeeded(service).catch(() => null)) === false;

    // The switch itself: one update, so every reader sees the old or the new roles.
    const balance = service.balance
      ? { ...service.balance, main: undefined, copies: Object.fromEntries(Object.entries(service.balance.copies ?? {}).filter(([k]) => !k.startsWith(`${serverId}:`))) }
      : service.balance;
    await db.transaction(async (tx) => {
      await tx
        .update(schema.service)
        .set({
          serverId,
          distribution: {
            ...(service.distribution ?? {}),
            extraServerIds: swappedExtras(old.id, serverId, dist.extraServerIds),
            buildServerId: dist.buildServerId === serverId ? null : dist.buildServerId,
          },
          balance,
        })
        .where(eq(schema.service.id, serviceId));
      for (const [domainId, certificateId] of certIds) await tx.update(schema.domain).set({ certificateId }).where(eq(schema.domain.id, domainId));
    });

    if (wasCurrent) {
      const [after] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
      if (after) {
        const [now, running] = await Promise.all([configFingerprint(after), configFingerprint(after, { serverVarsOf: old.id })]);
        if (now === running) await db.update(schema.deployment).set({ configHash: now }).where(eq(schema.deployment.id, service.currentDeploymentId));
        else warnings.push(`Server variables of ${next.name} differ from ${old.name}. Redeploy to use them.`);
      }
    }

    // The private network first: the new main server needs the links to the other servers' copies.
    const { syncMesh } = await import("@/server/mesh");
    await syncMesh({ servers: runsOn, kick: runsOn }).catch((e) => warnings.push(`Private network: ${(e as Error).message}`));

    // Then the names: DNS records and tunnel routes Serve manages.
    const manual: MainServerResult["manual"] = [];
    const { syncTunnelIngress, reattachOnServer } = await import("@/server/cloudflare/tunnels");
    const touchedTunnels = new Set<string>();
    const rows = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, serviceId));
    for (const move of plan.moves) {
      const d = rows.find((r) => r.id === move.domainId);
      if (!d) continue;
      try {
        if (move.kind === "rename") {
          const name = await generatedHostname(service.slug, serverId);
          if (!name || name.hostname === d.hostname) continue;
          const [taken] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, name.hostname));
          if (taken) warnings.push(`${d.hostname} still leads to ${old.name}: ${name.hostname} is taken.`);
          else await db.update(schema.domain).set({ hostname: name.hostname, https: name.https, forceHttps: name.https }).where(eq(schema.domain.id, d.id));
        } else if (move.kind === "manual") {
          manual.push({ hostname: d.hostname, ip: move.ip });
        } else if (move.kind === "record" && d.cloudflareAccountId && d.cloudflareZoneId) {
          const cf = await Cloudflare.forAccount(d.cloudflareAccountId);
          if (d.cloudflareRecordId) {
            const current = (await cf.dnsRecords(d.cloudflareZoneId, { name: d.hostname })).find((r) => r.id === d.cloudflareRecordId);
            const record = await cf.upsertARecord(d.cloudflareZoneId, d.hostname, move.ip, current?.proxied ?? false);
            await db
              .update(schema.domain)
              .set({ cloudflareRecordId: record?.id ?? null })
              .where(eq(schema.domain.id, d.id));
          } else {
            // The user's own record: moved only when it pointed at the old main server.
            const moved = old.publicIp ? await cf.moveARecords(d.cloudflareZoneId, d.hostname, old.publicIp, move.ip) : { result: "untouched" as const, record: null };
            if (moved.result === "untouched") manual.push({ hostname: d.hostname, ip: move.ip });
            else if (moved.result === "created" && moved.record) await db.update(schema.domain).set({ cloudflareRecordId: moved.record.id }).where(eq(schema.domain.id, d.id));
          }
        } else if (move.kind === "tunnel" && d.cloudflareZoneId) {
          const [tunnel] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, move.tunnelId));
          if (!tunnel) continue;
          const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
          const record = await cf.upsertTunnelRecord(d.cloudflareZoneId, d.hostname, tunnel.cfTunnelId);
          if (d.tunnelId) touchedTunnels.add(d.tunnelId);
          touchedTunnels.add(tunnel.id);
          // Cloudflare terminates HTTPS; the tunnel reaches the proxy over plain HTTP.
          await db
            .update(schema.domain)
            .set({
              tunnelId: tunnel.id,
              wantsTunnel: true,
              tunnelError: null,
              https: false,
              forceHttps: false,
              cloudflareAccountId: tunnel.cloudflareAccountId,
              cloudflareRecordId: record.id,
            })
            .where(eq(schema.domain.id, d.id));
        } else if (move.kind === "untunnel" && d.cloudflareAccountId && d.cloudflareZoneId) {
          const cf = await Cloudflare.forAccount(d.cloudflareAccountId);
          // Serve's CNAME to the old tunnel goes in upsertARecord, which replaces its own records.
          const record = await cf.upsertARecord(d.cloudflareZoneId, d.hostname, move.ip, true);
          if (d.tunnelId) touchedTunnels.add(d.tunnelId);
          const [updated] = await db
            .update(schema.domain)
            .set({ tunnelId: null, wantsTunnel: false, tunnelError: null, https: true, forceHttps: true, cloudflareRecordId: record?.id ?? null })
            .where(eq(schema.domain.id, d.id))
            .returning();
          if (updated) await ensureCertificateFor(updated, ctx.org.id, { requestNow: true });
        }
      } catch (e) {
        warnings.push(`${d.hostname}: ${(e as Error).message}`);
        if (move.kind !== "rename") manual.push({ hostname: d.hostname, ip: "ip" in move ? move.ip : `the tunnel of ${next.name}` });
      }
    }
    for (const id of touchedTunnels) await syncTunnelIngress(id).catch(() => {});
    await reattachOnServer(serverId).catch(() => {});

    // Domains with HTTPS and no certificate there yet (none to copy): requested now.
    if (next.proxyKind === "nginx") {
      const httpsDomains = await db
        .select()
        .from(schema.domain)
        .where(and(eq(schema.domain.serviceId, serviceId), eq(schema.domain.https, true)));
      for (const d of httpsDomains) await ensureCertificateFor(d, ctx.org.id, { requestNow: true }).catch(() => null);
    }

    // Every server renders the site again: the new main one with the other servers' copies, the
    // old one with its own replicas only.
    await syncServiceProxy(serviceId).catch((e) => warnings.push(`Proxy not updated: ${(e as Error).message}`));

    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.main-server",
      targetType: "service",
      targetId: serviceId,
      message: `Visitors of ${service.name} now enter through ${next.name} (was ${old.name})`,
    });
    return { manual, warnings };
  });
}
