import { headers } from "next/headers";
import { and, asc, eq } from "drizzle-orm";
import { dashboardVisitorIp } from "@/server/proxy/trusted-proxies";
import { inRanges } from "@/lib/trusted-proxies";
import { certificateCovers } from "@/server/ssl/match";
import { tunnelTargetPort } from "@/lib/database-domains";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { privateHost } from "@/lib/hostname";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { ServiceOverview } from "./overview";
import { loadOverview } from "./overview-data";
import { DatabaseOverview } from "./database-overview";
import { engines } from "@/server/databases/engines";
import { databaseUrl } from "@/server/databases/options";
import { decryptOrNull } from "@/server/crypto";
import { publishedPorts } from "@/server/services/ports";
import { monitorSummary } from "@/server/monitoring/queries";
import { UptimeCard } from "./uptime-card";
import { loadPreviews } from "./previews/data";
import { PreviewsCard } from "./previews/previews-list";

export default async function ServicePage(props: PageProps<"/projects/[projectId]/services/[serviceId]">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);

  if (service.type === "database" && service.database) {
    const cfg = service.database;
    const engine = engines[cfg.engine];
    const [published] = await publishedPorts(service);
    // Roles without secret access get the shape of the URL, never the password.
    const hideSecrets = !ctx.can("variables.view-secrets");
    const creds = { username: cfg.username, password: hideSecrets ? "********" : (decryptOrNull(cfg.password) ?? ""), database: cfg.database };
    const monitoring = await monitorSummary(service.id);
    // The database's own domain, with the certificate it serves for it.
    const hostname = cfg.domain ?? null;
    const domainCert = hostname
      ? (
          await db
            .select({ status: schema.certificate.status, error: schema.certificate.lastError, domains: schema.certificate.domains })
            .from(schema.certificate)
            .where(and(eq(schema.certificate.organizationId, ctx.org.id), eq(schema.certificate.serverId, service.serverId)))
        )
          .filter((c) => certificateCovers(c.domains, hostname))
          .sort((a, b) => Number(b.status === "active") - Number(a.status === "active"))[0]
      : undefined;
    // Tunnels of this server: a domain can go through one instead of a public port (no public IP needed).
    const tunnels = await db
      .select({ id: schema.cloudflareTunnel.id, account: schema.cloudflareAccount.name })
      .from(schema.cloudflareTunnel)
      .innerJoin(schema.cloudflareAccount, eq(schema.cloudflareTunnel.cloudflareAccountId, schema.cloudflareAccount.id))
      .where(and(eq(schema.cloudflareTunnel.serverId, service.serverId), eq(schema.cloudflareAccount.organizationId, ctx.org.id)));
    const localPort = tunnelTargetPort(cfg.engine, engine.port);
    const direct = !!hostname && !cfg.domainTunnelId;
    const domain = service.parentServiceId
      ? undefined
      : {
          supported: !!engine.tlsArgs || tunnels.length > 0,
          directSupported: !!engine.tlsArgs,
          via: cfg.domainTunnelId ? ("tunnel" as const) : ("direct" as const),
          tunnels: tunnels.map((t) => ({ id: t.id, label: `Tunnel of ${t.account}` })),
          tunnelCommand: hostname ? `cloudflared access tcp --hostname ${hostname} --url localhost:${localPort}` : null,
          localUrl: databaseUrl(cfg, creds, "localhost", localPort),
          hostname,
          port: direct ? (cfg.publicPort ?? null) : null,
          url:
            direct && cfg.publicPort ? databaseUrl(cfg, creds, hostname, cfg.publicPort, { public: true, verified: domainCert?.status === "active" && !!cfg.tls?.enabled }) : null,
          // Public access or TLS turned off after the domain was set: the domain does not answer.
          unreachable: direct && (!cfg.publicPort || cfg.publicBind === "127.0.0.1" || !cfg.tls?.enabled),
          certificate: domainCert ? { status: domainCert.status, error: domainCert.error } : null,
          engineLabel: engine.label,
        };
    // Offered for the public port's allowlist (not on a dashboard opened at localhost).
    const viewerIp = await dashboardVisitorIp(await headers());
    const branches = service.parentServiceId
      ? []
      : await db
          .select({ id: schema.databaseBranch.id, name: schema.databaseBranch.name, status: schema.databaseBranch.status, sizeBytes: schema.databaseBranch.sizeBytes })
          .from(schema.databaseBranch)
          .where(eq(schema.databaseBranch.serviceId, service.id))
          .orderBy(asc(schema.databaseBranch.createdAt));
    return (
      <PageBody className="flex flex-col gap-6">
        <DatabaseOverview
          serviceId={service.id}
          projectId={projectId}
          engine={{ label: engine.label, port: engine.port, hasUser: engine.hasUser, hasDatabase: engine.hasDatabase }}
          creds={creds}
          internalUrl={databaseUrl(cfg, creds, privateHost(service), engine.port)}
          publicUrl={published ? databaseUrl(cfg, creds, published.address, published.host, { public: true }) : null}
          host={privateHost(service)}
          publicPort={cfg.publicPort ?? null}
          publicBind={cfg.publicBind ?? "0.0.0.0"}
          publicAllow={cfg.publicAllow ?? []}
          viewerIp={viewerIp && !inRanges(viewerIp, ["127.0.0.0/8", "::1/128"]) ? viewerIp : null}
          publicAddress={published?.label ?? null}
          name={service.name}
          hideSecrets={hideSecrets}
          canManage={ctx.can("services.manage")}
          uptime={<UptimeCard summary={monitoring} settingsHref={`/projects/${projectId}/services/${service.id}/settings/monitoring`} />}
          uptimeInSide={!monitoring.monitor}
          branches={branches}
          domain={domain}
        />
      </PageBody>
    );
  }

  return (
    <PageBody>
      <ServiceOverview
        {...(await loadOverview(service, projectId, ctx.org.id))}
        previewsCard={
          service.type === "app" && service.source?.type === "git" && !service.parentServiceId && service.previewsEnabled ? (
            <PreviewsCard key="previews" projectId={projectId} serviceId={service.id} previews={await loadPreviews(service.id)} />
          ) : null
        }
      />
    </PageBody>
  );
}
