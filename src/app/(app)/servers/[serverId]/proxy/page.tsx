import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { listSiteFiles, proxyDefinition, proxyStatus, testProxyConfig } from "@/server/proxy/nginx";
import { DEFAULT_MAX_BODY_SIZE, defaultsOf, proxyImages, type ProxyKind, type RunningKind } from "@/server/proxy/config";
import { EmptyState, Card } from "@/components/ui/misc";
import { ProxyView } from "./proxy-view";
import { ProxyPortsCard } from "./proxy-ports";
import { loadServer, withTimeout } from "../_lib/load";

export const metadata = { title: "Proxy" };

export default async function ProxyPage(props: PageProps<"/servers/[serverId]/proxy">) {
  const { serverId } = await props.params;
  const { row, server } = await loadServer(serverId);
  const data = await withTimeout(
    server().then(async (ctx) => {
      const [status, test, files, definition] = await Promise.all([proxyStatus(ctx), testProxyConfig(ctx), listSiteFiles(ctx), proxyDefinition(ctx).catch(() => null)]);
      return { ctx, status, test, files, definition };
    }),
    12_000,
  );
  if (!data) {
    return (
      <Card>
        <EmptyState
          title="The proxy is not reachable"
          description={row.isLocal ? "Docker did not answer." : "Validate the server connection on the General page, then come back."}
        />
      </Card>
    );
  }
  const settings = await getSettings();
  const kind = row.proxyKind as ProxyKind;
  const cfg = row.proxyConfig ?? {};
  // Accounts of the server's owner (Root for instance servers).
  const accountOrg = row.ownerOrganizationId ?? settings.rootOrganizationId;
  const cloudflareAccounts = accountOrg
    ? await db
        .select({ id: schema.cloudflareAccount.id, name: schema.cloudflareAccount.name })
        .from(schema.cloudflareAccount)
        .innerJoin(schema.cloudflareCredential, eq(schema.cloudflareAccount.credentialId, schema.cloudflareCredential.id))
        // Traefik keeps the token, so only pasted API tokens (they do not expire).
        .where(and(eq(schema.cloudflareAccount.organizationId, accountOrg), eq(schema.cloudflareCredential.authType, "token")))
    : [];
  const ids = data.files.flatMap((f) => (f.serviceId ? [f.serviceId] : []));
  const services = ids.length
    ? await db.select({ id: schema.service.id, name: schema.service.name, projectId: schema.service.projectId }).from(schema.service).where(inArray(schema.service.id, ids))
    : [];
  const byId = new Map(services.map((s) => [s.id, s]));
  const running: RunningKind = kind === "none" ? "nginx" : kind;
  const own = cfg[running] ?? {};
  // Container env values are stored encrypted and never reach the browser (`container` below masks them).
  const noContainer = <T extends { container?: unknown }>({ container: _container, ...rest }: T) => rest;
  const mainLabels: Record<string, string> = {
    "main/nginx.conf": "Main configuration",
    "main/proxy_params.conf": "Proxy headers",
    "main/caddy/Caddyfile": "Caddyfile",
    "_serve.yml": "Shared routers and error pages",
  };

  return (
    <ProxyView
      serverId={serverId}
      trustedProxies={row.trustedProxies ?? null}
      portsCard={<ProxyPortsCard serverId={serverId} isLocal={row.isLocal} ports={{ proxyHttpPort: data.ctx.proxyHttpPort, proxyHttpsPort: data.ctx.proxyHttpsPort }} />}
      status={{
        running: data.status.running,
        exists: data.status.exists,
        image: data.status.image ?? own.container?.image ?? proxyImages[running],
        kind: data.status.kind,
        startedAt: data.status.startedAt,
        container: data.ctx.proxyContainer,
        ports: { http: data.ctx.proxyHttpPort, https: data.ctx.proxyHttpsPort },
      }}
      test={data.test}
      kind={kind}
      stopped={row.proxyStopped}
      switchState={row.proxySwitch ?? null}
      acmeEmail={settings.acmeEmail}
      cloudflareAccounts={cloudflareAccounts}
      settings={{
        nginx: noContainer(cfg.nginx ?? {}),
        caddy: noContainer(cfg.caddy ?? {}),
        traefik: {
          ...noContainer(cfg.traefik ?? {}),
          // The password hash never reaches the browser.
          dashboard: cfg.traefik?.dashboard
            ? { enabled: cfg.traefik.dashboard.enabled, hostname: cfg.traefik.dashboard.hostname, username: cfg.traefik.dashboard.username, hasPassword: true }
            : null,
        },
      }}
      // Root's instance-wide directives: not applied to (or shown on) an organization's own server.
      customConfig={row.ownerOrganizationId ? null : (settings.proxyCustomConfig ?? "")}
      customFiles={own.files ?? []}
      defaults={defaultsOf(own.defaults)}
      container={{
        image: own.container?.image ?? "",
        args: own.container?.args ?? [],
        env: (own.container?.env ?? []).map((e) => ({ name: e.name, hasValue: !!e.value })),
        volumes: own.container?.volumes ?? [],
        ports: own.container?.ports ?? [],
        customized: !!own.container,
      }}
      defaultImage={proxyImages[running]}
      definition={data.definition}
      maxBodySize={DEFAULT_MAX_BODY_SIZE}
      files={data.files.map((f) => {
        const svc = f.serviceId ? byId.get(f.serviceId) : undefined;
        return {
          ...f,
          label:
            mainLabels[f.file] ??
            (f.kind === "dashboard"
              ? `Dashboard${settings.dashboardDomain ? ` · ${settings.dashboardDomain}` : ""}`
              : f.kind === "custom"
                ? "Shared nginx directives (all servers)"
                : f.kind === "other"
                  ? f.file
                  : (svc?.name ?? "Removed service")),
          href: svc ? `/projects/${svc.projectId}/services/${svc.id}/domains` : null,
        };
      })}
    />
  );
}
