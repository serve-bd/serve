import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { getSettings } from "@/server/settings";
import { serverHealth } from "@/server/system";
import { securityChecks } from "@/server/security-checks";
import { PageHeader } from "@/components/shell/page-header";
import { Tooltip } from "@/components/ui/tooltip";
import { ServerNav } from "./_components/server-nav";

export default async function ServerLayout({ children }: LayoutProps<"/server">) {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) redirect("/");
  const settings = await getSettings();
  const health = await serverHealth(settings);
  const ready = health.issues.length === 0;
  const security = (await securityChecks(settings)).some((c) => c.status === "warn");

  return (
    <>
      <PageHeader
        title={settings.instanceName === "Serve" ? "Server" : settings.instanceName}
        description="This server's settings, proxy and resources, shared by every organization."
        actions={
          <Tooltip content={ready ? "Docker, the proxy and the worker are running." : health.issues.join(" · ")}>
            <span className="inline-flex h-7 items-center gap-2 rounded-full bg-surface px-3 text-xs font-medium text-fg ring-1 ring-line">
              <span className={ready ? "size-1.5 rounded-full bg-ok" : "size-1.5 animate-led rounded-full bg-warn"} />
              {ready ? "Ready" : "Attention required"}
            </span>
          </Tooltip>
        }
      />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 pt-4 pb-16 sm:px-8 lg:flex-row lg:gap-10 lg:pt-6">
        <ServerNav warnings={{ proxy: !health.proxy, disk: health.diskPercent >= settings.cleanupDiskThreshold, security }} />
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </>
  );
}
