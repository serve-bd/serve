import { and, asc, eq } from "drizzle-orm";
import { certificateCovers } from "@/server/ssl/match";
import { DOMAIN_ROUTES, domainUrl } from "@/lib/database-domains";
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
import { routerPorts } from "@/server/databases/router";
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
    // The database's own domain, with the certificate the router uses for it.
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
    const routes = DOMAIN_ROUTES[cfg.engine];
    // Tunnels of this server: a domain can go through one instead of the router (no public IP needed).
    const tunnels = await db
      .select({ id: schema.cloudflareTunnel.id, account: schema.cloudflareAccount.name })
      .from(schema.cloudflareTunnel)
      .innerJoin(schema.cloudflareAccount, eq(schema.cloudflareTunnel.cloudflareAccountId, schema.cloudflareAccount.id))
      .where(and(eq(schema.cloudflareTunnel.serverId, service.serverId), eq(schema.cloudflareAccount.organizationId, ctx.org.id)));
    const localPort = routes?.[0]?.target ?? engine.port;
    // Ports the router could not take: another program on the server already listens there.
    const routerBound = hostname && routes && !cfg.domainTunnelId && domainCert?.status === "active" ? await routerPorts(service.serverId) : null;
    const blockedPorts = routerBound ? routes!.map((r) => r.port).filter((p) => !routerBound.has(p)) : [];
    const domain = service.parentServiceId
      ? undefined
      : {
          supported: !!routes || tunnels.length > 0,
          routerSupported: !!routes,
          via: cfg.domainTunnelId ? ("tunnel" as const) : ("router" as const),
          tunnels: tunnels.map((t) => ({ id: t.id, label: `Tunnel of ${t.account}` })),
          tunnelCommand: hostname ? `cloudflared access tcp --hostname ${hostname} --url localhost:${localPort}` : null,
          localUrl: databaseUrl(cfg, creds, "localhost", localPort),
          hostname,
          url: hostname ? domainUrl(cfg.engine, creds, hostname) : null,
          ports: (routes ?? []).map((r) => ({ port: r.port, label: r.label })),
          certificate: domainCert ? { status: domainCert.status, error: domainCert.error } : null,
          engineLabel: engine.label,
          blockedPorts,
        };
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
          publicUrl={published ? databaseUrl(cfg, creds, published.address, published.host) : null}
          host={privateHost(service)}
          publicPort={cfg.publicPort ?? null}
          publicBind={cfg.publicBind ?? "0.0.0.0"}
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
