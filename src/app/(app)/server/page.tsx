import { redirect } from "next/navigation";
import { asc, sql } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { dockerDiskUsage, systemStatus } from "@/server/system";
import { env } from "@/server/env";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { ServerSettingsView } from "./server-settings";

export const metadata = { title: "Server settings" };

export default async function ServerPage() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) redirect("/");
  const [settings, status, orgs, disk] = await Promise.all([
    getSettings(),
    systemStatus(),
    db
      .select({ id: schema.organization.id, name: schema.organization.name, createdAt: schema.organization.createdAt, members: sql<number>`(select count(*)::int from member m where m.organization_id = "organization"."id")` })
      .from(schema.organization)
      .orderBy(asc(schema.organization.createdAt)),
    dockerDiskUsage(),
  ]);
  return (
    <>
      <PageHeader title="Server settings" description="Settings for this server, shared by every organization." />
      <PageBody className="max-w-4xl">
        <ServerSettingsView
          settings={{
            instanceName: settings.instanceName,
            serverIp: settings.serverIp ?? "",
            wildcardDomain: settings.wildcardDomain ?? "",
            sslipFallback: settings.sslipFallback,
            dashboardDomain: settings.dashboardDomain ?? "",
            dashboardHttps: settings.dashboardHttps,
            acmeEmail: settings.acmeEmail ?? "",
            acmeStaging: settings.acmeStaging,
            imageRetention: settings.imageRetention,
            metricsRetentionHours: settings.metricsRetentionHours,
            buildConcurrency: settings.buildConcurrency,
            proxyMaxBodySize: settings.proxyMaxBodySize,
            allowOrganizationCreation: settings.allowOrganizationCreation,
          }}
          status={{
            docker: status.dockerVersion,
            dockerError: status.dockerError,
            proxy: status.proxy,
            nixpacks: status.nixpacks,
            hostname: status.hostname,
            platform: status.platform,
            arch: status.arch,
            cpus: status.cpus,
            memory: status.memory,
            dataDir: env.dataDir,
            proxyPorts: `${env.proxyHttpPort} / ${env.proxyHttpsPort}`,
          }}
          disk={disk}
          organizations={orgs.map((o) => ({ ...o, createdAt: o.createdAt.toISOString(), isRoot: o.id === settings.rootOrganizationId }))}
        />
      </PageBody>
    </>
  );
}
