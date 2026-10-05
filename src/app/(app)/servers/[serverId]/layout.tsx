import { and, eq, isNull } from "drizzle-orm";
import { HiddenIp } from "@/components/ui/hidden-ip";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { serverHealth } from "@/server/system";
import { PageHeader } from "@/components/shell/page-header";
import { SectionNav } from "@/components/shell/section-nav";
import { Tooltip } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/misc";
import { statusText } from "@/components/ui/status";
import { loadServerView, withTimeout } from "./_lib/load";
import { serversForOrg } from "@/server/servers/access";
import { MakeDefaultButton } from "./default-button";

export default async function ServerLayout({ children, params }: LayoutProps<"/servers/[serverId]">) {
  const { serverId } = await params;
  const { row, server, manage, ctx: viewer } = await loadServerView(serverId);
  const settings = await getSettings();
  // A remote server that is not set up yet has no health to report.
  const health = row.isLocal || row.status === "ready" ? await withTimeout(server().then((ctx) => serverHealth(ctx, settings))) : null;
  const issues = health ? health.issues : row.status === "ready" ? ["The server did not answer in time"] : [row.statusMessage ?? statusText(row.status, "server")];
  const ready = issues.length === 0;
  const base = `/servers/${serverId}`;
  // New services go to the organization's default server unless someone picks another.
  const choices = await serversForOrg(viewer.org.id);
  const isDefault = choices.some((s) => s.id === serverId && s.isDefault);
  const canMakeDefault = viewer.isAdmin && !isDefault && choices.some((s) => s.id === serverId) && (row.isLocal || row.status === "ready");
  const openAlerts = await db
    .select({ id: schema.incident.id })
    .from(schema.incident)
    .where(and(eq(schema.incident.serverId, serverId), isNull(schema.incident.resolvedAt)));

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Servers", href: "/servers" }, { label: row.name }]}
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="truncate">{row.name}</span>
            {row.isLocal && <Badge tone="accent">This server</Badge>}
            {isDefault && (
              <Tooltip content="New services go to this server unless you pick another" delay={0}>
                <span className="inline-flex">
                  <Badge tone="ok">Default</Badge>
                </span>
              </Tooltip>
            )}
          </span>
        }
        description={
          !manage ? (
            row.ownerOrganizationId === viewer.org.id || (viewer.isRoot && !row.ownerOrganizationId) ? (
              "View only. Admins of this organization manage the server."
            ) : (
              "Shared with your organization. You deploy services here; its owner manages the server."
            )
          ) : row.isLocal ? (
            "The machine this dashboard runs on. Reached through the local Docker socket."
          ) : (
            <HiddenIp
              text={
                row.tailscale?.tailnetId && row.tailscale.address
                  ? `${row.username}@${row.tailscale.address}${row.port === 22 ? "" : `:${row.port}`} · through Tailscale`
                  : row.tunnel
                    ? `${row.username}@${row.host} · no public IP, connects out through a tunnel`
                    : `${row.username}@${row.host}${row.port === 22 ? "" : `:${row.port}`}`
              }
            />
          )
        }
        actions={
          <span className="flex items-center gap-2">
            {canMakeDefault && <MakeDefaultButton serverId={serverId} />}
            <Tooltip content={ready ? "Docker, the proxy and the worker are running." : issues.join(" · ")}>
              <span className="inline-flex h-7 items-center gap-2 rounded-full bg-surface px-3 text-xs font-medium text-fg ring-1 ring-line">
                <span
                  className={
                    ready ? "size-1.5 rounded-full bg-ok" : row.status === "validating" ? "size-1.5 animate-led rounded-full bg-info" : "size-1.5 animate-led rounded-full bg-warn"
                  }
                />
                {ready ? "Ready" : row.status === "validating" ? "Validating" : "Attention required"}
              </span>
            </Tooltip>
          </span>
        }
      />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 pt-4 pb-16 sm:px-8 lg:flex-row lg:gap-10 lg:pt-6">
        <SectionNav
          groups={
            !manage
              ? [
                  {
                    title: "Server",
                    items: [
                      { href: base, label: "General", icon: "Settings2", exact: true },
                      { href: `${base}/services`, label: "Services", icon: "Layers3" },
                      { href: `${base}/metrics`, label: "Metrics", icon: "Activity" },
                    ],
                  },
                ]
              : [
                  {
                    title: "Server",
                    items: [
                      { href: base, label: "General", icon: "Settings2", exact: true },
                      { href: `${base}/services`, label: "Services", icon: "Layers3" },
                      { href: `${base}/domains`, label: "Domains", icon: "Globe" },
                      { href: `${base}/network`, label: "Private network", icon: "Waypoints", warn: row.mesh?.enabled === true && row.mesh.state === "error" },
                      { href: `${base}/sharing`, label: "Sharing", icon: "Users" },
                    ],
                  },
                  {
                    title: "Platform",
                    items: [
                      { href: `${base}/proxy`, label: "Proxy", icon: "Network", warn: !!health && !health.proxy },
                      { href: `${base}/resources`, label: "Resources", icon: "Boxes" },
                      { href: `${base}/builds`, label: "Builds & deploys", icon: "Hammer" },
                    ],
                  },
                  {
                    title: "Operations",
                    items: [
                      { href: `${base}/terminal`, label: "Terminal", icon: "SquareTerminal" },
                      { href: `${base}/cleanup`, label: "Docker cleanup", icon: "Brush", warn: !!health && health.diskPercent >= settings.cleanupDiskThreshold },
                      { href: `${base}/updates`, label: "OS updates", icon: "Download", warn: row.osUpdates?.run?.state === "failed" },
                      { href: `${base}/metrics`, label: "Metrics", icon: "Activity" },
                      { href: `${base}/alerts`, label: "Alerts", icon: "BellRing", warn: openAlerts.length > 0 },
                    ],
                  },
                  // This machine runs Serve itself: it cannot be removed.
                  ...(row.isLocal ? [] : [{ title: "Settings", items: [{ href: `${base}/danger`, label: "Danger zone", icon: "TriangleAlert" as const, danger: true }] }]),
                ]
          }
        />
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </>
  );
}
