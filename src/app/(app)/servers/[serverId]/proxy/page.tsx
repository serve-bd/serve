import { inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { listSiteFiles, proxyStatus, testProxyConfig } from "@/server/proxy/nginx";
import { PROXY_IMAGE } from "@/server/proxy/templates";
import { EmptyState, Card } from "@/components/ui/misc";
import { ProxyView } from "./proxy-view";
import { loadServer, withTimeout } from "../_lib/load";

export const metadata = { title: "Proxy" };

export default async function ProxyPage(props: PageProps<"/servers/[serverId]/proxy">) {
  const { serverId } = await props.params;
  const { row, server } = await loadServer(serverId);
  const data = await withTimeout(
    server().then(async (ctx) => {
      const [status, test, files] = await Promise.all([proxyStatus(ctx), testProxyConfig(ctx), listSiteFiles(ctx)]);
      return { ctx, status, test, files };
    }),
    12_000,
  );
  if (!data) {
    return (
      <Card>
        <EmptyState title="The proxy is not reachable" description={row.isLocal ? "Docker did not answer." : "Validate the server connection on the General page, then come back."} />
      </Card>
    );
  }
  const settings = await getSettings();
  const ids = data.files.flatMap((f) => (f.serviceId ? [f.serviceId] : []));
  const services = ids.length
    ? await db.select({ id: schema.service.id, name: schema.service.name, projectId: schema.service.projectId }).from(schema.service).where(inArray(schema.service.id, ids))
    : [];
  const byId = new Map(services.map((s) => [s.id, s]));

  return (
    <ProxyView
      serverId={serverId}
      status={{
        running: data.status.running,
        exists: data.status.exists,
        image: data.status.image ?? PROXY_IMAGE,
        startedAt: data.status.startedAt,
        container: data.ctx.proxyContainer,
        ports: { http: data.ctx.proxyHttpPort, https: data.ctx.proxyHttpsPort },
      }}
      test={data.test}
      customConfig={settings.proxyCustomConfig ?? ""}
      maxBodySize={settings.proxyMaxBodySize}
      files={data.files.map((f) => {
        const svc = f.serviceId ? byId.get(f.serviceId) : undefined;
        return {
          ...f,
          label:
            f.kind === "dashboard"
              ? `Dashboard${settings.dashboardDomain ? ` · ${settings.dashboardDomain}` : ""}`
              : f.kind === "custom"
                ? "Custom directives"
                : (svc?.name ?? "Removed service"),
          href: svc ? `/projects/${svc.projectId}/services/${svc.id}/domains` : null,
        };
      })}
    />
  );
}
