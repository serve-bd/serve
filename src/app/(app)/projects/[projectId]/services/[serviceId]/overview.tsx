"use client";

import { counterRate } from "@/lib/counter-rate";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import useSWR from "swr";
import {
  ArrowUpRight,
  Box,
  ChevronRight,
  Cpu,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Laptop,
  Lock,
  LockOpen,
  MemoryStick,
  Network,
  Rocket,
  ScrollText,
  Server,
  Timer,
  Waypoints,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge, Card, CardHeader, CopyField, EmptyState, TimeAgo } from "@/components/ui/misc";
import { StatusLabel } from "@/components/ui/status";
import { Tooltip } from "@/components/ui/tooltip";
import { AreaChart } from "@/components/charts/area-chart";
import { useAction } from "@/hooks/use-action";
import { deployService } from "@/server/actions/services";
import { cn, formatBytes } from "@/lib/utils";
import { useCan, useCannot } from "@/components/permissions";
import type { OverviewData } from "./overview-data";
import { UptimeCard } from "./uptime-card";
import { ContainerDialog } from "./container-dialog";

type Series = { t: number; cpu: number; memory: number; memoryLimit: number; netRx: number | null; netTx: number | null }[];
type Req = { series: { t: number; requests: number; avgMs: number; s5xx: number }[]; totals: { requests: number; errors: number; bytes: number; avgMs: number } };
type Live = { status: string; containers: { id: string; name: string; state: string; status: string; deployment: string | null; composeService: string | null }[] };
type Deployment = OverviewData["recent"][number];

const triggerLabel: Record<string, string> = {
  manual: "Manual",
  push: "Git push",
  webhook: "Webhook",
  api: "API",
  rollback: "Rollback",
  redeploy: "Redeploy",
  create: "Initial deploy",
  "deploy-hook": "Deploy hook",
  preview: "Preview",
};

function duration(d: Deployment) {
  if (!d.startedAt || !d.finishedAt) return null;
  const ms = new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime();
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function compact(n: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-2.5 text-[13px]">
      <span className="flex-none text-muted">{label}</span>
      <span className={cn("min-w-0 truncate text-right text-fg-2", mono && "font-mono text-[12px]")}>{children}</span>
    </div>
  );
}

function Stat({ icon, label, value, sub, children }: { icon: React.ReactNode; label: string; value: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-surface px-4 pt-3.5 pb-2">
      <span className="flex items-center gap-1.5 text-xs text-muted [&_svg]:size-3.5">
        {icon}
        {label}
      </span>
      <span className="text-[18px] font-semibold tabular-nums text-fg">{value}</span>
      {/* The line is always there, so every tile's chart starts at the same height. */}
      <span className="truncate text-[11px] text-faint">{sub || "\u00a0"}</span>
      <div className="mt-auto pt-1">{children}</div>
    </div>
  );
}

export function ServiceOverview(data: OverviewData) {
  const { service, current } = data;
  const router = useRouter();
  const base = `/projects/${data.projectId}/services/${service.id}`;
  const can = useCan();
  const cannot = useCannot();
  const { data: live } = useSWR<Live>(`/api/services/${service.id}/live`, { refreshInterval: 5000 });
  const { data: metrics } = useSWR<{ series: Series }>(`/api/metrics?scope=${service.id}&hours=6`, { refreshInterval: 15000 });
  const { data: req } = useSWR<Req>(data.domains.length ? `/api/services/${service.id}/requests?hours=24` : null, { refreshInterval: 30000 });
  const deploy = useAction(() => deployService(service.id), { success: "Deployment queued", onSuccess: (d) => router.push(`${base}/deployments/${d.id}`) });

  const series = metrics?.series ?? [];
  const last = series.at(-1);
  const running = (live?.containers ?? []).filter((c) => c.state === "running" && (!current || !c.deployment || c.deployment === current.id || service.type === "compose"));
  const expected = service.type === "compose" ? Math.max(1, service.source?.kind === "compose" ? service.source.services.length : 1) : service.replicas;
  const memLimit = service.memoryLimit ? service.memoryLimit * 1024 * 1024 : last?.memoryLimit || null;
  const [openContainer, setOpenContainer] = React.useState<string | null>(null);
  const rx = counterRate(series, "netRx").map((p) => ({ t: p.t, v: p.v ?? 0 }));
  const lastRx = counterRate(series.slice(-2), "netRx")[0]?.v ?? null;
  const lastTx = counterRate(series.slice(-2), "netTx")[0]?.v ?? null;
  const primary = data.domains.find((d) => d.primary) ?? data.domains[0];

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <ContainerDialog serviceId={service.id} base={base} containerId={openContainer} onOpenChange={(o) => !o && setOpenContainer(null)} />
      <div className="flex min-w-0 flex-col gap-6">
        {/* Current deployment */}
        <Card>
          <CardHeader
            title="Current deployment"
            description={
              current ? (
                <>
                  Live since <TimeAgo date={current.finishedAt ?? current.createdAt} />
                </>
              ) : (
                "Nothing is running yet."
              )
            }
            actions={
              <div className="flex gap-2">
                {current && (
                  <Link href={`${base}/deployments/${current.id}`} className={buttonVariants({ size: "sm" })}>
                    <ScrollText /> Build log
                  </Link>
                )}
                <Button size="sm" variant="primary" onClick={() => deploy.run()} loading={deploy.pending} disabled={!can("services.deploy")} title={cannot("services.deploy")}>
                  <Rocket /> {current ? "Redeploy" : "Deploy"}
                </Button>
              </div>
            }
          />
          {current ? (
            <div className="flex flex-col gap-3 px-5 py-4">
              <div className="flex min-w-0 items-center gap-3.5">
                <span className="flex size-10 flex-none items-center justify-center rounded-xl bg-surface-2 text-fg-2">
                  {current.commitSha ? <GitCommitHorizontal className="size-[18px]" /> : <Box className="size-[18px]" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <p className="truncate text-[15px] font-medium text-fg">
                      {current.commitMessage ||
                        (service.source?.kind === "image"
                          ? service.source.image
                          : service.source?.kind === "compose"
                            ? (service.source.template ?? "Compose stack")
                            : (triggerLabel[current.trigger] ?? "Deployment"))}
                    </p>
                    <StatusLabel status={current.status} kind="deployment" className="flex-none rounded-full bg-surface-2 px-2 py-0.5 text-xs" />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
                    {current.commitSha && (
                      <>
                        {current.commitUrl ? (
                          <a href={current.commitUrl} target="_blank" rel="noreferrer" className="font-mono hover:text-accent">
                            {current.commitSha.slice(0, 7)}
                          </a>
                        ) : (
                          <span className="font-mono">{current.commitSha.slice(0, 7)}</span>
                        )}
                        <span className="text-faint">·</span>
                      </>
                    )}
                    {current.branch && (
                      <>
                        <span className="inline-flex items-center gap-1">
                          <GitBranch className="size-3.5" />
                          {current.branch}
                        </span>
                        <span className="text-faint">·</span>
                      </>
                    )}
                    <span>{triggerLabel[current.trigger] ?? current.trigger}</span>
                    {(current.commitAuthor || current.userName) && (
                      <>
                        <span className="text-faint">·</span>
                        <span>by {current.commitAuthor ?? current.userName}</span>
                      </>
                    )}
                    {duration(current) && (
                      <>
                        <span className="text-faint">·</span>
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          <Timer className="size-3.5" />
                          Built in {duration(current)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              {data.latest && (
                <Link
                  href={`${base}/deployments/${data.latest.id}`}
                  className={cn(
                    "flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] transition-colors",
                    data.latest.status === "failed" ? "bg-bad-soft text-fg hover:bg-bad-soft/80" : "bg-surface-2 text-fg-2 hover:bg-hover",
                  )}
                >
                  <StatusLabel status={data.latest.status} kind="deployment" className="flex-none text-xs" />
                  <span className="min-w-0 flex-1 truncate">
                    Newer deployment {data.latest.status === "failed" ? "failed" : "in progress"}: {data.latest.commitMessage || triggerLabel[data.latest.trigger] || "Deployment"}
                  </span>
                  <ChevronRight className="size-4 flex-none text-faint" />
                </Link>
              )}
            </div>
          ) : (
            <EmptyState icon={<Rocket />} title="Not deployed yet" description="Deploy to build and start this service." />
          )}
        </Card>

        {/* Resources */}
        <Card>
          <CardHeader
            title="Resources"
            description={`${running.length} of ${expected} ${service.type === "compose" ? "containers" : `replica${expected === 1 ? "" : "s"}`} running · last 6 hours`}
            actions={
              <Link href={`${base}/metrics`} className={buttonVariants({ size: "sm", variant: "ghost" })}>
                Metrics <ChevronRight />
              </Link>
            }
          />
          <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-3">
            <Stat icon={<Cpu />} label="CPU" value={last ? `${last.cpu.toFixed(1)}%` : "—"} sub={service.cpuLimit ? `Limit ${service.cpuLimit} cores` : "No limit"}>
              <AreaChart data={series.map((p) => ({ t: p.t, v: p.cpu }))} format={(v) => `${v.toFixed(1)}%`} height={44} />
            </Stat>
            <Stat icon={<MemoryStick />} label="Memory" value={last ? formatBytes(last.memory) : "—"} sub={memLimit ? `of ${formatBytes(memLimit)}` : "No limit"}>
              <AreaChart data={series.map((p) => ({ t: p.t, v: p.memory }))} color="var(--info)" max={memLimit ?? undefined} format={(v) => formatBytes(v)} height={44} />
            </Stat>
            <Stat icon={<Network />} label="Network in" value={lastRx != null ? `${formatBytes(lastRx)}/s` : "—"} sub={lastTx != null ? `Out ${formatBytes(lastTx)}/s` : undefined}>
              <AreaChart data={rx} color="var(--ok)" format={(v) => `${formatBytes(v)}/s`} height={44} />
            </Stat>
          </div>
          {(live?.containers.length ?? 0) > 0 && (
            <div className="divide-y divide-line border-t border-line">
              {live!.containers.slice(0, 6).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setOpenContainer(c.id)}
                  className="group flex w-full items-center gap-3 px-5 py-2.5 text-left text-[13px] transition-colors hover:bg-hover"
                >
                  <span className={cn("size-1.5 flex-none rounded-full", c.state === "running" ? "bg-ok" : c.state === "restarting" ? "bg-warn" : "bg-idle")} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2">{c.composeService ?? c.name}</span>
                  <span className="flex-none text-xs text-muted">{c.status}</span>
                  <ChevronRight className="size-3.5 flex-none text-faint transition-colors group-hover:text-muted" />
                </button>
              ))}
            </div>
          )}
        </Card>

        {data.monitoring.monitor && <UptimeCard summary={data.monitoring} settingsHref={`${base}/settings/monitoring`} />}

        {/* Traffic */}
        {data.domains.length > 0 && (
          <Card>
            <CardHeader title="Traffic" description="Requests through the proxy in the last 24 hours." />
            <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-3">
              <Stat icon={<Globe />} label="Requests" value={req ? compact(req.totals.requests) : "—"} sub={req ? `${formatBytes(req.totals.bytes)} sent` : undefined}>
                <AreaChart data={(req?.series ?? []).map((p) => ({ t: p.t, v: p.requests }))} format={(v) => compact(v)} height={44} />
              </Stat>
              <Stat
                icon={<Timer />}
                label="Avg response"
                value={req?.totals.requests ? `${Math.round(req.totals.avgMs)} ms` : "—"}
                sub={req?.totals.requests ? "Average time per request" : "No requests yet"}
              >
                <AreaChart data={(req?.series ?? []).map((p) => ({ t: p.t, v: p.avgMs }))} color="var(--accent)" format={(v) => `${Math.round(v)} ms`} height={44} />
              </Stat>
              <Stat
                icon={<Box />}
                label="Server errors"
                value={req ? compact(req.totals.errors) : "—"}
                sub={req?.totals.requests ? `${((req.totals.errors / req.totals.requests) * 100).toFixed(2)}% of requests` : "5xx answers from the app"}
              >
                <AreaChart data={(req?.series ?? []).map((p) => ({ t: p.t, v: p.s5xx }))} color="var(--bad)" format={(v) => compact(v)} height={44} />
              </Stat>
            </div>
          </Card>
        )}

        {/* Recent deployments */}
        <Card>
          <CardHeader
            title="Recent deployments"
            description={data.successRate !== null ? `${data.deploymentCount} in total · ${Math.round(data.successRate * 100)}% succeeded` : `${data.deploymentCount} in total`}
            actions={
              <Link href={`${base}/deployments`} className={buttonVariants({ size: "sm", variant: "ghost" })}>
                View all <ChevronRight />
              </Link>
            }
          />
          {data.recent.length === 0 ? (
            <p className="px-5 py-4 text-[13px] text-muted">No deployments yet.</p>
          ) : (
            <div className="divide-y divide-line">
              {data.recent.map((d) => (
                <Link key={d.id} href={`${base}/deployments/${d.id}`} className="flex items-center gap-3 px-5 py-2.5 text-[13px] transition-colors hover:bg-hover/50">
                  <StatusLabel status={d.status} kind="deployment" className="w-24 flex-none text-xs" />
                  <span className="min-w-0 flex-1 truncate text-fg-2">{d.commitMessage || triggerLabel[d.trigger] || "Deployment"}</span>
                  {d.id === current?.id && <Badge tone="ok">Current</Badge>}
                  <span className="hidden flex-none text-xs text-muted sm:inline">{duration(d)}</span>
                  <span className="flex-none text-xs text-faint">
                    <TimeAgo date={d.createdAt} />
                  </span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        {!data.monitoring.monitor && <UptimeCard summary={data.monitoring} settingsHref={`${base}/settings/monitoring`} />}
        {/* Access */}
        <Card>
          <CardHeader
            title="Access"
            actions={
              <Link href={`${base}/domains`} className={buttonVariants({ size: "sm", variant: "ghost" })}>
                Manage <ChevronRight />
              </Link>
            }
          />
          <div className="flex flex-col gap-3 px-5 py-4">
            {data.domains.length === 0 && data.published.length === 0 && <p className="text-[13px] text-muted">No public address yet. Add a domain or a localhost port.</p>}
            {data.domains.map((d) => (
              <a key={d.id} href={`${d.secure ? "https" : "http"}://${d.hostname}`} target="_blank" rel="noreferrer" className="group flex min-w-0 items-center gap-2 text-[13px]">
                {d.tunnel ? (
                  <Waypoints className="size-3.5 flex-none text-[#f38020]" />
                ) : d.secure ? (
                  <Lock className="size-3.5 flex-none text-ok" />
                ) : (
                  <LockOpen className="size-3.5 flex-none text-muted" />
                )}
                <span className={cn("min-w-0 truncate group-hover:text-accent", d === primary ? "font-medium text-fg" : "text-fg-2")}>{d.hostname}</span>
                <ArrowUpRight className="size-3.5 flex-none text-faint" />
              </a>
            ))}
            {data.published.map((p) => (
              <a key={`${p.host}/${p.protocol}`} href={p.url ?? undefined} target="_blank" rel="noreferrer" className="group flex items-center gap-2 text-[13px]">
                <Laptop className="size-3.5 flex-none text-muted" />
                <span className="font-mono text-[12.5px] text-fg-2 group-hover:text-accent">{p.label}</span>
                <span className="text-xs text-faint">
                  → {p.container}/{p.protocol}
                </span>
              </a>
            ))}
            {data.redirects > 0 && (
              <p className="text-xs text-muted">
                {data.redirects} redirect{data.redirects === 1 ? "" : "s"} to other URLs
              </p>
            )}
            <div className="border-t border-line pt-3">
              <p className="mb-1.5 text-xs text-muted">Private address · for services in {data.environment}</p>
              <CopyField value={service.port ? `${service.slug}:${service.port}` : service.slug} />
            </div>
          </div>
        </Card>

        {/* Details */}
        <Card>
          <CardHeader title="Details" />
          <div className="flex flex-col divide-y divide-line">
            <Row label="Status">
              <StatusLabel status={live?.status ?? service.status} className="text-xs" />
            </Row>
            <Row label="Server">
              <Link href={`/servers/${data.server.id}`} className="inline-flex items-center gap-1.5 hover:text-accent">
                <Server className="size-3.5" />
                {data.server.name}
              </Link>
            </Row>
            <Row label="Environment">{data.environment}</Row>
            {service.source?.kind === "git" && (
              <>
                <Row label="Repository" mono>
                  <a href={service.source.repository.replace(/\.git$/, "")} target="_blank" rel="noreferrer" className="hover:text-accent">
                    {service.source.repository.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "")}
                  </a>
                </Row>
                <Row label="Branch" mono>
                  {service.source.branch}
                </Row>
                <Row label="Builder">
                  {service.builder === "auto"
                    ? "Auto detect"
                    : service.builder === "dockerfile"
                      ? "Dockerfile"
                      : service.builder === "nixpacks"
                        ? "Nixpacks"
                        : service.builder === "static"
                          ? "Static site"
                          : "—"}
                  {service.rootDir && service.rootDir !== "." && service.rootDir !== "/" ? ` · ${service.rootDir}` : ""}
                </Row>
                <Row label="Deploy on push">{service.autoDeploy ? "On" : "Off"}</Row>
                <Row label="PR previews">{service.previewsEnabled ? "On" : "Off"}</Row>
              </>
            )}
            {service.source?.kind === "image" && (
              <Row label="Image" mono>
                {service.source.image}
              </Row>
            )}
            {service.source?.kind === "compose" && (
              <>
                <Row label="Stack">{service.source.template ?? (service.source.mode === "git" ? service.source.path : "Inline compose file")}</Row>
                <Row label="Services">{service.source.services.join(", ") || "—"}</Row>
              </>
            )}
            {service.type === "app" && (
              <>
                <Row label="Port" mono>
                  {service.port ?? "Auto"}
                </Row>
                <Row label="Replicas">{service.replicas}</Row>
                <Row label="Health check" mono>
                  {service.healthcheckPath ?? "Container running"}
                </Row>
                <Row label="Restart">{service.restartPolicy}</Row>
                <Row label="Limits">
                  {service.cpuLimit || service.memoryLimit
                    ? `${service.cpuLimit ? `${service.cpuLimit} CPU` : ""}${service.cpuLimit && service.memoryLimit ? " · " : ""}${service.memoryLimit ? `${service.memoryLimit} MB` : ""}`
                    : "None"}
                </Row>
              </>
            )}
            <Row label="Created">
              <TimeAgo date={service.createdAt} />
            </Row>
          </div>
        </Card>

        {/* Configuration */}
        <Card>
          <CardHeader title="Configuration" />
          <div className="grid grid-cols-2 gap-px border-t-0 bg-line">
            {[
              { label: "Variables", value: data.counts.variables, sub: data.counts.shared ? `+ ${data.counts.shared} shared` : "Encrypted", href: `${base}/variables` },
              {
                label: "Domains",
                value: data.domains.length,
                sub: data.published.length ? `+ ${data.published.length} port${data.published.length === 1 ? "" : "s"}` : "Routed by the proxy",
                href: `${base}/domains`,
              },
              { label: "Volumes", value: service.volumes, sub: service.volumes ? "Kept across deploys" : "No persistent data", href: `${base}/settings/storage` },
              { label: "Tasks", value: data.counts.tasks, sub: "Scheduled commands", href: `${base}/tasks` },
            ].map((c) => (
              <Tooltip key={c.label} content={`Open ${c.label.toLowerCase()}`}>
                <Link href={c.href} className="flex flex-col gap-0.5 bg-surface px-4 py-3 transition-colors hover:bg-hover/60">
                  <span className="text-xs text-muted">{c.label}</span>
                  <span className="text-[18px] font-semibold tabular-nums text-fg">{c.value}</span>
                  <span className="truncate text-[11px] text-faint">{c.sub}</span>
                </Link>
              </Tooltip>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
