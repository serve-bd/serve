"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpCircle, ArrowUpRight, ChevronDown, Container, Globe, RefreshCw, RotateCw, Server as ServerIcon, Trash2, Waypoints } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { CopyButton, Skeleton, TimeAgo } from "@/components/ui/misc";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { disableTunnel, restartTunnelConnector, tunnelDetails, tunnelImpact, updateTunnelConnector } from "@/server/actions/integrations";
import type { TunnelDetails } from "@/server/cloudflare/tunnels";
import { cn } from "@/lib/utils";

export type TunnelDomain = { hostname: string; service: { name: string; href: string } | null };
export type TunnelInfo = {
  id: string;
  accountId: string;
  serverId: string;
  name: string;
  cfTunnelId: string;
  status: string;
  statusMessage: string | null;
  createdAt: string;
  updatedAt: string;
  domains: TunnelDomain[];
};

export const tunnelTone: Record<string, { color: string; label: string }> = {
  healthy: { color: "var(--ok)", label: "Connected" },
  degraded: { color: "var(--warn)", label: "Degraded" },
  down: { color: "var(--bad)", label: "Down" },
  error: { color: "var(--bad)", label: "Error" },
  pending: { color: "var(--warn)", label: "Connecting…" },
};

/** One server's tunnel: a summary row that opens into connections, connector, domains and actions. */
export function TunnelRow({
  tunnel,
  server,
  cfAccountId,
  isAdmin,
  defaultOpen,
}: {
  tunnel: TunnelInfo;
  server: { id: string; name: string; isLocal: boolean };
  cfAccountId: string | null;
  isAdmin: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [details, setDetails] = React.useState<TunnelDetails | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const router = useRouter();
  const confirm = useConfirm();
  const tone = tunnelTone[tunnel.status] ?? tunnelTone.pending;
  const panelId = `tunnel-${tunnel.id}`;

  const load = React.useCallback(async () => {
    setLoading(true);
    const res = await tunnelDetails(tunnel.id);
    setLoading(false);
    if (res.ok) {
      setDetails(res.data);
      setLoadError(null);
    } else setLoadError(res.error);
    router.refresh();
  }, [tunnel.id, router]);

  // Load live details the first time the row opens.
  const loaded = React.useRef(false);
  React.useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    void load();
  }, [open, load]);

  const restart = useAction(restartTunnelConnector, {
    success: "Connector restarted",
    onSuccess: () => setTimeout(() => void load(), 4000),
  });
  const update = useAction(updateTunnelConnector, {
    success: "Connector updated. The tunnel stayed online.",
    onSuccess: () => setTimeout(() => void load(), 4000),
  });
  const remove = useAction(disableTunnel, { success: "Tunnel removed" });

  const cf = details?.cloudflare;
  const connector = details?.connector;
  const connections = cf?.ok ? cf.connections : [];
  const colos = [...new Set(connections.map((c) => c.colo))];
  const version = connections.find((c) => c.version)?.version ?? null;
  const updateInfo = connector?.ok && connector.exists ? connector.update : null;
  const latest = updateInfo?.latestVersion?.replace(/^v/, "") ?? null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-hover/40"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2 text-[13px]">
            <ServerIcon className="size-3.5 flex-none text-muted" />
            <span className="truncate font-medium text-fg">{server.name}</span>
            {server.isLocal && <span className="flex-none text-xs text-faint">this server</span>}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 pl-5.5 text-xs text-muted">
            <span className="size-1.5 flex-none rounded-full" style={{ background: tone.color }} />
            <span className="flex-none text-fg-2">{tone.label}</span>
            <span className="flex-none">
              · {tunnel.domains.length} domain{tunnel.domains.length === 1 ? "" : "s"}
            </span>
            {tunnel.statusMessage && <span className="hidden truncate sm:inline">· {tunnel.statusMessage}</span>}
          </span>
        </span>
        <ChevronDown className={cn("size-4 flex-none text-faint transition-transform duration-200", open && "rotate-180")} />
      </button>

      {open && (
        <div id={panelId} className="flex flex-col gap-4 px-5 pt-1 pb-5">
          {tunnel.status === "error" && tunnel.statusMessage && (
            <p className="rounded-xl border border-bad/20 bg-bad-soft px-3.5 py-2.5 text-[13px] text-fg-2">{tunnel.statusMessage}</p>
          )}
          {loadError && <p className="rounded-xl border border-bad/20 bg-bad-soft px-3.5 py-2.5 text-[13px] text-fg-2">{loadError}</p>}

          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-3">
            {/* Tunnel */}
            <Tile icon={<Waypoints />} title="Tunnel">
              <p className="truncate text-[13px] font-medium text-fg">{tunnel.name}</p>
              <span className="flex min-w-0 items-center gap-1">
                <code className="min-w-0 truncate font-mono text-[11.5px] text-muted">{tunnel.cfTunnelId}</code>
                <CopyButton value={tunnel.cfTunnelId} label="Copy tunnel ID" className="size-6 flex-none" />
              </span>
              <p className="text-xs text-faint">
                Created <TimeAgo date={tunnel.createdAt} />
              </p>
            </Tile>

            {/* Cloudflare side */}
            <Tile icon={<Globe />} title="Cloudflare edge">
              {!details ? (
                <TileSkeleton />
              ) : cf?.ok ? (
                <>
                  <p className="text-[13px] font-medium text-fg">
                    {connections.length ? `${connections.length} connection${connections.length === 1 ? "" : "s"}` : "No connections"}
                  </p>
                  {colos.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {colos.map((c) => (
                        <span key={c} className="rounded-md bg-fg/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-fg-2 uppercase">
                          {c}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <p className="text-xs text-muted">
                      {cf.inactiveAt ? (
                        <>
                          Last connected <TimeAgo date={cf.inactiveAt} />
                        </>
                      ) : (
                        "The connector has not connected yet."
                      )}
                    </p>
                  )}
                  {cf.activeAt && connections.length > 0 && (
                    <p className="text-xs text-faint">
                      Up since <TimeAgo date={cf.activeAt} />
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-bad">{cf?.error}</p>
              )}
            </Tile>

            {/* Connector container */}
            <Tile icon={<Container />} title="Connector">
              {!details ? (
                <TileSkeleton />
              ) : connector?.ok ? (
                connector.exists ? (
                  <>
                    <p className={cn("flex items-center gap-1.5 text-[13px] font-medium", connector.running ? "text-fg" : "text-bad")}>
                      <span className={cn("size-1.5 rounded-full", connector.running ? "bg-ok" : "bg-bad")} />
                      {connector.running ? "Running" : connector.state === "restarting" ? "Restarting" : "Stopped"}
                    </p>
                    <p className="truncate font-mono text-[11.5px] text-muted">{connector.image}</p>
                    <p className="text-xs text-faint">
                      {connector.startedAt ? (
                        <>
                          Started <TimeAgo date={connector.startedAt} />
                        </>
                      ) : (
                        (connector.error ?? "Not running")
                      )}
                      {connector.restarts > 0 && ` · ${connector.restarts} restart${connector.restarts === 1 ? "" : "s"}`}
                      {version && ` · v${version}`}
                    </p>
                    {updateInfo?.available ? (
                      <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-accent">
                        <ArrowUpCircle className="size-3.5" />
                        {latest && latest !== version ? `Update available: v${latest}` : "Update available"}
                      </p>
                    ) : updateInfo && !updateInfo.error ? (
                      <p className="mt-1 text-xs text-faint">Up to date</p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p className="text-[13px] font-medium text-bad">Missing</p>
                    <p className="text-xs text-muted">Serve starts it again within a minute, or restart it now.</p>
                  </>
                )
              ) : (
                <p className="text-xs text-bad">{connector?.error}</p>
              )}
            </Tile>
          </div>

          {/* Connections */}
          {connections.length > 0 && (
            <Section title="Connections">
              {connections.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-3.5 py-2 text-[13px]">
                  <span className={cn("size-1.5 flex-none rounded-full", c.pending ? "bg-warn" : "bg-ok")} />
                  <span className="w-12 flex-none font-mono text-[12px] text-fg uppercase">{c.colo}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{c.originIp ?? "—"}</span>
                  <span className="hidden flex-none text-xs text-faint sm:inline">{c.pending ? "Reconnecting" : c.openedAt ? <TimeAgo date={c.openedAt} /> : null}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Domains */}
          <Section title="Domains through this tunnel">
            {tunnel.domains.length === 0 ? (
              <p className="px-3.5 py-3 text-[13px] text-muted">No domains yet. Add a domain to a service on {server.name} and choose this tunnel.</p>
            ) : (
              tunnel.domains.map((d) => (
                <div key={d.hostname} className="flex items-center gap-3 px-3.5 py-2 text-[13px]">
                  <a
                    href={`https://${d.hostname}`}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex min-w-0 flex-1 items-center gap-1 font-mono text-[12.5px] text-fg hover:text-accent"
                  >
                    <span className="truncate">{d.hostname}</span>
                    <ArrowUpRight className="size-3 flex-none text-faint group-hover:text-accent" />
                  </a>
                  {d.service ? (
                    <Link href={d.service.href} className="max-w-[45%] flex-none truncate text-xs text-muted hover:text-fg">
                      {d.service.name}
                    </Link>
                  ) : (
                    <span className="flex-none text-xs text-muted">Dashboard</span>
                  )}
                </div>
              ))
            )}
          </Section>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => void load()} loading={loading}>
              <RefreshCw /> Refresh
            </Button>
            {isAdmin && updateInfo?.available && (
              <Button size="sm" onClick={() => update.run(tunnel.id)} loading={update.pending} disabled={restart.pending}>
                <ArrowUpCircle /> {update.pending ? "Updating, tunnel stays online…" : "Update connector"}
              </Button>
            )}
            {isAdmin && (
              <Button size="sm" variant="secondary" onClick={() => restart.run(tunnel.id)} loading={restart.pending} disabled={update.pending}>
                <RotateCw /> Restart connector
              </Button>
            )}
            {cfAccountId && (
              <a
                href={`https://one.dash.cloudflare.com/${cfAccountId}/networks/tunnels`}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ size: "sm", variant: "ghost" })}
              >
                Open in Cloudflare <ArrowUpRight />
              </a>
            )}
            {isAdmin && (
              <Button
                size="sm"
                variant="danger-ghost"
                className="sm:ml-auto"
                loading={remove.pending}
                onClick={async () => {
                  const impact = await tunnelImpact(tunnel.id);
                  const offline = impact.ok ? impact.data : [];
                  if (
                    !(await confirm({
                      title: `Remove the tunnel from ${server.name}?`,
                      description: offline.length
                        ? "The connector stops and the tunnel is deleted in Cloudflare. These domains stop working until a tunnel runs on this server again; Serve then reconnects them automatically."
                        : "The connector stops and the tunnel is deleted in Cloudflare.",
                      confirmLabel: offline.length ? "Remove tunnel anyway" : "Remove tunnel",
                      danger: true,
                      children: offline.length ? (
                        <ul className="flex flex-col gap-0.5 rounded-xl border border-bad/25 bg-bad-soft px-3.5 py-3 font-mono text-[12.5px] text-fg-2">
                          {offline.map((h) => (
                            <li key={h}>{h}</li>
                          ))}
                        </ul>
                      ) : undefined,
                    }))
                  )
                    return;
                  await remove.run(tunnel.id);
                }}
              >
                <Trash2 /> Remove tunnel
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 bg-surface px-4 py-3.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-faint uppercase [&_svg]:size-3.5">
        {icon}
        {title}
      </p>
      {children}
    </div>
  );
}

function TileSkeleton() {
  return (
    <>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-3 w-32" />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-medium tracking-wide text-faint uppercase">{title}</p>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">{children}</div>
    </div>
  );
}
