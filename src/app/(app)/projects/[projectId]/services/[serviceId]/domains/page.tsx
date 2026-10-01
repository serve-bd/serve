import { and, asc, eq } from "drizzle-orm";
import { privateHost } from "@/lib/hostname";
import { pickPrimaryDomain } from "@/lib/domains";
import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { getSettings } from "@/server/settings";
import { certificateCovers } from "@/server/ssl/match";
import { composeServiceNames, composeServicePorts } from "@/server/deploy/compose";
import { PageBody } from "@/components/shell/page-header";
import { serverAddressing } from "@/server/proxy/addressing";
import { getServerRow } from "@/server/servers/context";
import { busyHostPorts, listeningPorts, publishedPorts } from "@/server/services/ports";
import { DomainsManager } from "./domains-manager";
import { PortsCard } from "./ports-card";
import { ProxyOptionsCard } from "./proxy-options-card";
import { getTemplate } from "@/server/services/templates";
import { ProxyConfigCard } from "./proxy-config-card";
import { generatedSite } from "@/server/proxy/nginx";
import { getServer } from "@/server/servers/context";
import type { RunningKind } from "@/server/proxy/config";

export const metadata = { title: "Domains & ports" };

export default async function DomainsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/domains">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (service.type === "database") redirect(`/projects/${projectId}/services/${serviceId}`);
  const [domains, certs, cfAccounts, settings, addressing, server, tunnels] = await Promise.all([
    db.select().from(schema.domain).where(eq(schema.domain.serviceId, serviceId)).orderBy(asc(schema.domain.createdAt)),
    db
      .select({ certificate: schema.certificate, serverName: schema.server.name })
      .from(schema.certificate)
      .innerJoin(schema.server, eq(schema.certificate.serverId, schema.server.id))
      .where(eq(schema.certificate.organizationId, ctx.org.id)),
    db.select({ id: schema.cloudflareAccount.id }).from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.organizationId, ctx.org.id)),
    getSettings(),
    serverAddressing(service.serverId),
    getServerRow(service.serverId),
    db
      .select({
        id: schema.cloudflareTunnel.id,
        accountId: schema.cloudflareTunnel.cloudflareAccountId,
        accountName: schema.cloudflareAccount.name,
        status: schema.cloudflareTunnel.status,
        statusMessage: schema.cloudflareTunnel.statusMessage,
      })
      .from(schema.cloudflareTunnel)
      .innerJoin(schema.cloudflareAccount, eq(schema.cloudflareTunnel.cloudflareAccountId, schema.cloudflareAccount.id))
      .where(and(eq(schema.cloudflareTunnel.organizationId, ctx.org.id), eq(schema.cloudflareTunnel.serverId, service.serverId))),
  ]);
  // Never send the password hash to the browser.
  const proxyInitial = service.proxy
    ? (({ basicAuth, ...rest }) => ({ ...rest, basicAuthUser: basicAuth?.username ?? null, basicAuthHasBcrypt: !!basicAuth?.bcryptHash }))(service.proxy)
    : null;
  const hasPorts = service.type === "app" || service.type === "compose";
  const [published, busy, listening] = hasPorts
    ? await Promise.all([publishedPorts(service, server), busyHostPorts(service), listeningPorts(service)])
    : [[], [], {} as Awaited<ReturnType<typeof listeningPorts>>];
  const content = service.compose?.content ?? "";
  // Main compose service first: the one a template exposes, else the file's first.
  const template = service.compose?.template ? await getTemplate(service.compose.template) : null;
  const names = composeServiceNames(content);
  // Otherwise the service a domain already routes to (custom templates, pasted stacks).
  const routed = domains.find((d) => d.composeService && names.includes(d.composeService))?.composeService;
  const main = template?.expose.service && names.includes(template.expose.service) ? template.expose.service : (routed ?? names[0]);
  const composeServices = main ? [main, ...names.filter((n) => n !== main)] : names;
  const composePorts = composeServicePorts(content);
  if (template?.expose && main === template.expose.service && !composePorts[main]?.length) composePorts[main] = [template.expose.port];
  // Ports the domains already route to are known to work; use them where the file lists none.
  for (const d of domains) {
    if (d.composeService && d.port && !composePorts[d.composeService]?.includes(d.port)) composePorts[d.composeService] = [d.port, ...(composePorts[d.composeService] ?? [])];
  }
  const kind = server.proxyKind as RunningKind | "none";
  // The generated site is only shown to Root admins, who may replace it.
  const serverCtx = await getServer(service.serverId).catch(() => null);
  const generated = ctx.isInstanceAdmin && kind !== "none" && domains.length > 0 && serverCtx ? await generatedSite(kind, service.id, serverCtx).catch(() => null) : null;
  const appPort = service.type === "app" ? service.runtime.port : null;
  const primaryDomain = pickPrimaryDomain(domains);
  const here = certs.filter((c) => c.certificate.serverId === service.serverId).map((c) => c.certificate);
  return (
    <PageBody className="flex flex-col gap-6">
      <DomainsManager
        serviceId={service.id}
        proxyKind={server.proxyKind}
        proxyPorts={serverCtx ? { http: serverCtx.proxyHttpPort, https: serverCtx.proxyHttpsPort } : undefined}
        acmeChallenge={server.proxyConfig?.traefik?.acmeChallenge ?? "http"}
        type={service.type}
        defaultPort={service.runtime.port}
        composeServices={names}
        composePorts={composePorts}
        hasCloudflare={cfAccounts.length > 0}
        hasAcme={!!settings.acmeEmail}
        serverIp={addressing.publicIp}
        tunnels={tunnels}
        serverName={server.name}
        canGenerate={!!addressing.wildcardDomain || (addressing.sslipFallback && !!addressing.publicIp)}
        certificates={certs.map(({ certificate: c, serverName }) => ({
          id: c.id,
          name: c.name,
          domains: c.domains,
          status: c.status,
          provider: c.provider,
          serverName,
          // The proxy only serves certificates stored on its own server.
          here: c.serverId === service.serverId,
        }))}
        domains={[...domains]
          .sort((a, b) => Number(b === primaryDomain) - Number(a === primaryDomain))
          .map((d) => {
            const cert = d.https ? (here.find((c) => c.id === d.certificateId) ?? here.find((c) => certificateCovers(c.domains, d.hostname))) : undefined;
            return {
              id: d.id,
              hostname: d.hostname,
              port: d.port,
              composeService: d.composeService,
              https: d.https,
              forceHttps: d.forceHttps,
              redirectTo: d.redirectTo,
              generated: d.generated,
              primary: d === primaryDomain,
              cloudflare: !!d.cloudflareZoneId,
              managedRecord: !!d.cloudflareRecordId,
              tunnel: !!d.tunnelId,
              tunnelId: d.tunnelId,
              wantsTunnel: d.wantsTunnel,
              tunnelError: d.tunnelError,
              cloudflareAccountId: d.cloudflareAccountId,
              certificateId: d.certificateId,
              certificate: cert ? { id: cert.id, status: cert.status, provider: cert.provider, error: cert.lastError, expiresAt: cert.expiresAt?.toISOString() ?? null } : null,
            };
          })}
      />
      {(service.type === "app" || (service.type === "compose" && composeServices.length > 0)) && (
        <PortsCard
          key={JSON.stringify(service.type === "app" ? service.runtime.ports : (service.compose?.ports ?? []))}
          serviceId={service.id}
          kind={service.type === "app" ? "app" : "compose"}
          composeServices={composeServices}
          composePorts={composePorts}
          appPort={service.type === "app" ? service.runtime.port : (composePorts[main ?? ""]?.[0] ?? null)}
          initial={service.type === "app" ? service.runtime.ports : (service.compose?.ports ?? [])}
          published={published}
          isLocalServer={server.isLocal}
          serverName={server.name}
          busy={busy}
          listening={listening}
        />
      )}
      {kind !== "none" && (
        <ProxyOptionsCard
          key={JSON.stringify(service.proxy ?? null)}
          serviceId={service.id}
          initial={proxyInitial}
          isAdmin={ctx.isAdmin}
          isInstanceAdmin={ctx.isInstanceAdmin}
          hasTls={domains.some((d) => d.https)}
          proxyKind={server.proxyKind as "nginx" | "caddy" | "traefik"}
          replicas={service.type === "app" ? Math.max(1, service.runtime.replicas || 1) : 0}
        />
      )}
      {ctx.isInstanceAdmin && kind !== "none" && (
        <ProxyConfigCard
          key={`${kind}:${service.proxyCustom?.[kind] ?? ""}:${generated ?? ""}`}
          serviceId={service.id}
          kind={kind}
          generated={generated}
          custom={service.proxyCustom?.[kind] ?? null}
          otherCustom={(["nginx", "caddy", "traefik"] as const).filter((k) => k !== kind && !!service.proxyCustom?.[k])}
          hasDomains={domains.length > 0}
          alias={appPort ? `${privateHost(service)}:${appPort}` : null}
        />
      )}
    </PageBody>
  );
}
