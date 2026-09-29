import { inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import { getSettings } from "@/server/settings";
import { listSiteFiles, proxyStatus, testProxyConfig } from "@/server/proxy/nginx";
import { PROXY_IMAGE } from "@/server/proxy/templates";
import { ProxyView } from "./proxy-view";

export const metadata = { title: "Proxy" };

export default async function ProxyPage() {
  const [status, test, files, settings] = await Promise.all([proxyStatus(), testProxyConfig(), listSiteFiles(), getSettings()]);
  const ids = files.flatMap((f) => (f.serviceId ? [f.serviceId] : []));
  const services = ids.length
    ? await db
        .select({ id: schema.service.id, name: schema.service.name, projectId: schema.service.projectId })
        .from(schema.service)
        .where(inArray(schema.service.id, ids))
    : [];
  const byId = new Map(services.map((s) => [s.id, s]));

  return (
    <ProxyView
      status={{
        running: status.running,
        exists: status.exists,
        image: status.image ?? PROXY_IMAGE,
        startedAt: status.startedAt,
        container: env.proxyContainer,
        ports: { http: env.proxyHttpPort, https: env.proxyHttpsPort },
      }}
      test={test}
      customConfig={settings.proxyCustomConfig ?? ""}
      maxBodySize={settings.proxyMaxBodySize}
      files={files.map((f) => {
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
