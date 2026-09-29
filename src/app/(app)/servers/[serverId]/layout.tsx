import { getSettings } from "@/server/settings";
import { serverHealth } from "@/server/system";
import { PageHeader } from "@/components/shell/page-header";
import { SectionNav } from "@/components/shell/section-nav";
import { Tooltip } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/misc";
import { statusText } from "@/components/ui/status";
import { loadServer, withTimeout } from "./_lib/load";

export default async function ServerLayout({ children, params }: LayoutProps<"/servers/[serverId]">) {
  const { serverId } = await params;
  const { row, server } = await loadServer(serverId);
  const settings = await getSettings();
  // A remote server that is not set up yet has no health to report.
  const health = row.isLocal || row.status === "ready" ? await withTimeout(server().then((ctx) => serverHealth(ctx, settings))) : null;
  const issues = health ? health.issues : row.status === "ready" ? ["The server did not answer in time"] : [row.statusMessage ?? statusText(row.status, "server")];
  const ready = issues.length === 0;
  const base = `/servers/${serverId}`;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Servers", href: "/servers" }, { label: row.name }]}
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="truncate">{row.name}</span>
            {row.isLocal && <Badge tone="accent">This server</Badge>}
          </span>
        }
        description={row.isLocal ? "The machine Serve runs on. Reached through the local Docker socket." : `${row.username}@${row.host}${row.port === 22 ? "" : `:${row.port}`}`}
        actions={
          <Tooltip content={ready ? "Docker, the proxy and the worker are running." : issues.join(" · ")}>
            <span className="inline-flex h-7 items-center gap-2 rounded-full bg-surface px-3 text-xs font-medium text-fg ring-1 ring-line">
              <span className={ready ? "size-1.5 rounded-full bg-ok" : row.status === "validating" ? "size-1.5 animate-led rounded-full bg-info" : "size-1.5 animate-led rounded-full bg-warn"} />
              {ready ? "Ready" : row.status === "validating" ? "Validating" : "Attention required"}
            </span>
          </Tooltip>
        }
      />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 pt-4 pb-16 sm:px-8 lg:flex-row lg:gap-10 lg:pt-6">
        <SectionNav
          groups={[
            {
              title: "Server",
              items: [
                { href: base, label: "General", icon: "Settings2", exact: true },
                { href: `${base}/domains`, label: "Domains", icon: "Globe" },
              ],
            },
            {
              title: "Platform",
              items: [
                { href: `${base}/proxy`, label: "Proxy", icon: "Network", warn: !!health && !health.proxy },
                { href: `${base}/resources`, label: "Resources", icon: "Boxes" },
              ],
            },
            {
              title: "Operations",
              items: [
                { href: `${base}/terminal`, label: "Terminal", icon: "SquareTerminal" },
                { href: `${base}/cleanup`, label: "Docker cleanup", icon: "Brush", warn: !!health && health.diskPercent >= settings.cleanupDiskThreshold },
                { href: `${base}/metrics`, label: "Metrics", icon: "Activity" },
              ],
            },
          ]}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </>
  );
}
