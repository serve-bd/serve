import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";

/** Tab of the service page that fixes the problem. */
export type IssueTab = "overview" | "deployments" | "domains";

export type ServiceIssue = { tone: "bad" | "warn"; text: string; tab: IssueTab };

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
      .select({ serviceId: schema.incident.serviceId, title: schema.incident.title, severity: schema.incident.severity })
      .from(schema.incident)
      .where(and(inArray(schema.incident.serviceId, serviceIds), isNull(schema.incident.resolvedAt))),
    db
      .select({ id: schema.service.id, status: schema.service.status, serverName: schema.server.name, proxyStopped: schema.server.proxyStopped })
      .from(schema.service)
      .innerJoin(schema.server, eq(schema.service.serverId, schema.server.id))
      .where(inArray(schema.service.id, serviceIds)),
  ]);
  const add = (id: string | null, issue: ServiceIssue) => id && out.get(id)?.push(issue);

  // A stopped proxy takes every domain of its server offline.
  for (const s of services) {
    if (s.proxyStopped && domains.some((d) => d.serviceId === s.id)) {
      add(s.id, { tone: "bad", text: `The proxy on ${s.serverName} is stopped, so no domain answers. Start it in Servers → ${s.serverName} → Proxy`, tab: "domains" });
    }
  }
  for (const i of incidents) add(i.serviceId, { tone: i.severity === "warning" ? "warn" : "bad", text: i.title, tab: "overview" });
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
