import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSetting } from "@/server/settings";
import { composeSecurityIssues } from "@/server/security";

/** Tab of the service page that fixes the problem. */
export type IssueTab = "overview" | "deployments" | "domains";

/** `onPage`: the service's page shows it already (the image updates strip): the banner leaves it out. */
export type ServiceIssue = { tone: "bad" | "warn"; text: string; tab: IssueTab; onPage?: boolean };

/**
 * Problems a service has right now that its status alone does not show:
 * domains that are offline, failed certificates, a failed last deployment
 * and open incidents. Worst first.
 */
export async function serviceIssues(serviceIds: string[]): Promise<Map<string, ServiceIssue[]>> {
  const out = new Map<string, ServiceIssue[]>(serviceIds.map((id) => [id, []]));
  if (!serviceIds.length) return out;
  const [domains, deployments, incidents, services] = await Promise.all([
    db
      .select({
        serviceId: schema.domain.serviceId,
        hostname: schema.domain.hostname,
        https: schema.domain.https,
        wantsTunnel: schema.domain.wantsTunnel,
        tunnelId: schema.domain.tunnelId,
        tunnelError: schema.domain.tunnelError,
        redirectTo: schema.domain.redirectTo,
        certStatus: schema.certificate.status,
      })
      .from(schema.domain)
      .leftJoin(schema.certificate, eq(schema.domain.certificateId, schema.certificate.id))
      .where(inArray(schema.domain.serviceId, serviceIds)),
    db
      .selectDistinctOn([schema.deployment.serviceId], { serviceId: schema.deployment.serviceId, status: schema.deployment.status })
      .from(schema.deployment)
      .where(inArray(schema.deployment.serviceId, serviceIds))
      .orderBy(schema.deployment.serviceId, desc(schema.deployment.createdAt)),
    db
      .select({ serviceId: schema.incident.serviceId, title: schema.incident.title, detail: schema.incident.detail, severity: schema.incident.severity })
      .from(schema.incident)
      .where(and(inArray(schema.incident.serviceId, serviceIds), isNull(schema.incident.resolvedAt))),
    db
      .select({
        id: schema.service.id,
        status: schema.service.status,
        serverName: schema.server.name,
        proxyStopped: schema.server.proxyStopped,
        proxyError: schema.server.proxyError,
        imageCheck: schema.service.imageCheck,
        compose: schema.service.compose,
        organizationId: schema.project.organizationId,
      })
      .from(schema.service)
      .innerJoin(schema.server, eq(schema.service.serverId, schema.server.id))
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
      .where(inArray(schema.service.id, serviceIds)),
  ]);
  const rootId = await getSetting("rootOrganizationId");
  const add = (id: string | null, issue: ServiceIssue) => id && out.get(id)?.push(issue);

  // A compose file that breaks a rule made after it was saved: say so before the next deploy fails.
  for (const s of services) {
    if (!s.compose?.content || (s.organizationId === rootId && s.compose.hostAccess)) continue;
    const found = composeSecurityIssues(s.compose.content);
    if (found.length) {
      add(s.id, {
        tone: "bad",
        text: `The next deploy will fail: the compose file uses options only admins of the Root organization may set up (${found.slice(0, 2).join("; ")})`,
        tab: "deployments",
      });
    }
  }

  // A stopped proxy takes every domain of its server offline.
  for (const s of services) {
    if (s.proxyStopped && domains.some((d) => d.serviceId === s.id)) {
      add(s.id, { tone: "bad", text: `The proxy on ${s.serverName} is stopped, so no domain answers. Start it in Servers → ${s.serverName} → Proxy`, tab: "domains" });
    } else if (s.proxyError && domains.some((d) => d.serviceId === s.id)) {
      // The server may be shared: a container named in the reason can be another organization's.
      const reason = /\bthe container\b/.test(s.proxyError) ? "another container uses its port" : s.proxyError;
      add(s.id, { tone: "bad", text: `The proxy on ${s.serverName} is not running, so no domain answers: ${reason}`, tab: "domains" });
    }
  }
  // A newer build of a tag it runs: usually security fixes, and updating keeps the same version.
  for (const s of services) {
    const newer = s.imageCheck?.images.filter((i) => i.newerBuild) ?? [];
    if (newer.length)
      add(s.id, {
        tone: "warn",
        text: `A newer build of ${newer.map((i) => i.ref).join(", ")} is out (often security fixes). Update the image on the Overview`,
        tab: "overview",
        onPage: true,
      });
  }
  // With its reason: "is down" alone reads like the deploy broke it, when it may be the check that cannot reach it.
  for (const i of incidents) add(i.serviceId, { tone: i.severity === "warning" ? "warn" : "bad", text: i.detail ? `${i.title}: ${i.detail}` : i.title, tab: "overview" });
  for (const d of domains) {
    if (d.wantsTunnel && !d.tunnelId) add(d.serviceId, { tone: "bad", text: `${d.hostname} is offline: it waits for a Cloudflare Tunnel`, tab: "domains" });
    else if (d.tunnelError) add(d.serviceId, { tone: "bad", text: `${d.hostname}: ${d.tunnelError}`, tab: "domains" });
    else if (d.https && !d.redirectTo && d.certStatus === "failed") add(d.serviceId, { tone: "warn", text: `The certificate for ${d.hostname} failed`, tab: "domains" });
  }
  for (const d of deployments) {
    if (d.status !== "failed") continue;
    const running = services.find((s) => s.id === d.serviceId)?.status === "running";
    add(
      d.serviceId,
      running
        ? { tone: "warn", text: "The last deployment failed; the previous version still runs", tab: "deployments" }
        : { tone: "bad", text: "The last deployment failed", tab: "deployments" },
    );
  }
  for (const list of out.values()) list.sort((a, b) => Number(a.tone === "warn") - Number(b.tone === "warn"));
  return out;
}
