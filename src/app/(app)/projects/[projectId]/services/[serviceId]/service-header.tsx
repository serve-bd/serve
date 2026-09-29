"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "@/hooks/use-router";
import useSWR from "swr";
import { AlertTriangle, ArrowUpRight, ChevronDown, Construction, Play, Plug, Power, RotateCw, Rocket, Server as ServerIcon, Square } from "lucide-react";
import { Breadcrumbs } from "@/components/shell/page-header";
import { pickPrimaryDomain } from "@/lib/domains";
import { Button } from "@/components/ui/button";
import { StatusLabel } from "@/components/ui/status";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { ServiceIcon } from "@/components/service-icon";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { deployService, serviceControl } from "@/server/actions/services";
import { setMaintenance } from "@/server/actions/maintenance";
import { TimeAgo } from "@/components/ui/misc";
import type { ServiceLive } from "@/server/service-data";
import type { ServiceIssue } from "@/server/services/issues";
import { cn } from "@/lib/utils";
import { useCan, useCannot } from "@/components/permissions";

type Props = {
  project: { id: string; name: string };
  environment: string;
  service: {
    id: string;
    name: string;
    type: string;
    icon: string | null;
    engine: string | null;
    sourceType: "git" | "image" | null;
    sourceLabel: string;
  };
  initialLive: ServiceLive;
  server: { id: string; name: string } | null;
  ports: { label: string; url: string | null; protocol: "tcp" | "udp" }[];
  /** Maintenance mode, for services with domains. */
  maintenance: { enabled: boolean; since: string | null } | null;
  /** Problems that need attention (see serviceIssues), worst first. */
  issues: ServiceIssue[];
};

export function useServiceLive(serviceId: string, fallback?: ServiceLive) {
  return useSWR<ServiceLive>(`/api/services/${serviceId}/live`, {
    fallbackData: fallback,
    refreshInterval: (d) =>
      d && (["building", "deploying", "restarting"].includes(d.status) || d.deployments.some((x) => ["queued", "building", "deploying"].includes(x.status))) ? 1500 : 6000,
  });
}

export function ServiceHeader({ project, environment, service, initialLive, server, ports, maintenance, issues }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const confirm = useConfirm();
  const { data, mutate } = useServiceLive(service.id, initialLive);
  const live = data ?? initialLive;
  const base = `/projects/${project.id}/services/${service.id}`;

  const deploy = useAction(() => deployService(service.id), {
    success: "Deployment queued",
    onSuccess: (d) => {
      void mutate();
      router.push(`${base}/deployments/${d.id}`);
    },
  });
  const control = useAction((cmd: "stop" | "start" | "restart") => serviceControl(service.id, cmd), {
    onSuccess: () => void mutate(),
  });
  const toggleMaintenance = useAction((enabled: boolean) => setMaintenance(service.id, { enabled }), {
    success: (d) => (d.enabled ? "Maintenance mode is on" : "Maintenance mode is off"),
  });
  const turnOnMaintenance = async () => {
    if (
      await confirm({
        title: `Put ${service.name} in maintenance?`,
        description: "Every domain of this service answers with the maintenance page (HTTP 503) until you turn it off. The app keeps running.",
        confirmLabel: "Turn on maintenance",
      })
    )
      toggleMaintenance.run(true);
  };

  const can = useCan();
  const cannot = useCannot();
  const tabHref = (tab: ServiceIssue["tab"]) => (tab === "overview" ? base : `${base}/${tab}`);
  const tabs: { href: string; label: string; exact?: boolean }[] = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/deployments`, label: "Deployments" },
    ...(can("logs.view") ? [{ href: `${base}/logs`, label: "Logs" }] : []),
    ...(can("console.access") ? [{ href: `${base}/console`, label: "Console" }] : []),
    { href: `${base}/metrics`, label: "Metrics" },
    { href: `${base}/variables`, label: "Variables" },
    ...(service.type !== "database" ? [{ href: `${base}/domains`, label: "Domains & ports" }] : []),
    ...(service.type === "database" ? [{ href: `${base}/backups`, label: "Backups" }] : [{ href: `${base}/tasks`, label: "Tasks" }]),
    ...(can("services.manage") ? [{ href: `${base}/settings`, label: "Settings" }] : []),
  ];

  /** Worst issue tone for a tab (the Overview tab only marks incidents). */
  const tabIssue = (href: string) => {
    const hit = issues.filter((i) => tabHref(i.tab) === href);
    return hit.length ? (hit.some((i) => i.tone === "bad") ? "bad" : "warn") : null;
  };
  const primary = pickPrimaryDomain(live.domains);
  const stopped = live.status === "stopped";
  // Never deployed: nothing runs yet, so there is nothing to restart or stop.
  const notDeployed = live.status === "idle";
  const busy = ["building", "deploying", "restarting"].includes(live.status);

  return (
    <>
      {/* Thin header: breadcrumbs only. Title, actions and tabs belong to the page. */}
      <header className="border-b border-line bg-bg">
        <div className="w-full px-4 py-3 sm:px-8">
          <Breadcrumbs items={[{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${project.id}?env=${environment}` }, { label: service.name }]} />
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-4 pt-7 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-[1_1_20rem] items-start gap-3.5 sm:items-center">
            <ServiceIcon type={service.type} engine={service.engine} icon={service.icon} source={service.sourceType} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-3">
                <h1 className="truncate text-[22px] leading-tight font-semibold">{service.name}</h1>
                <StatusLabel status={live.status} className="shrink-0 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs ring-1 ring-line" />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
                <span className="max-w-full truncate font-mono text-[12px]">{service.sourceLabel}</span>
                {primary && (
                  <a
                    href={`${primary.https ? "https" : "http"}://${primary.hostname}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-w-0 max-w-full items-center gap-0.5 text-accent hover:underline"
                  >
                    <span className="truncate">{primary.hostname}</span>
                    <ArrowUpRight className="size-3 shrink-0" />
                  </a>
                )}
                {ports.map((p) =>
                  p.url ? (
                    <a
                      key={p.label}
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      title="Published port"
                      className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-[12px] text-fg-2 hover:text-accent"
                    >
                      <Plug className="size-3 shrink-0 text-faint" />
                      <span className="truncate">{p.label}</span>
                    </a>
                  ) : (
                    <span key={p.label} title="Published UDP port" className="inline-flex min-w-0 items-center gap-1 font-mono text-[12px] text-fg-2">
                      <Plug className="size-3 shrink-0 text-faint" />
                      <span className="truncate">{p.label}/udp</span>
                    </span>
                  ),
                )}
                <span className="rounded bg-sunken px-1.5 py-px text-[11px] text-muted">{environment}</span>
                {server && (
                  <Link href={`/servers/${server.id}`} className="inline-flex max-w-full items-center gap-1 rounded bg-sunken px-1.5 py-px text-[11px] text-muted hover:text-fg">
                    <ServerIcon className="size-3 shrink-0" />
                    <span className="truncate">{server.name}</span>
                  </Link>
                )}
              </div>
            </div>
          </div>
          <div className="ml-auto flex flex-none items-center gap-2">
            <Menu>
              <MenuTrigger
                disabled={!can("services.deploy")}
                title={cannot("services.deploy")}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-fg shadow-sm hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Power className="size-3.5" /> Manage <ChevronDown className="size-3.5 text-muted" />
              </MenuTrigger>
              <MenuContent>
                {notDeployed ? (
                  <MenuItem disabled>
                    <Rocket /> Deploy first to start it
                  </MenuItem>
                ) : stopped ? (
                  <MenuItem onClick={() => control.run("start")}>
                    <Play /> Start
                  </MenuItem>
                ) : (
                  <MenuItem onClick={() => control.run("restart")} disabled={busy}>
                    <RotateCw /> Restart
                  </MenuItem>
                )}
                {maintenance && (
                  <>
                    <MenuSeparator />
                    <MenuItem onClick={() => (maintenance.enabled ? toggleMaintenance.run(false) : turnOnMaintenance())} disabled={toggleMaintenance.pending}>
                      <Construction /> {maintenance.enabled ? "Turn off maintenance mode" : "Maintenance mode…"}
                    </MenuItem>
                  </>
                )}
                {!stopped && !notDeployed && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      danger
                      disabled={busy}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Stop ${service.name}?`,
                            description: "Containers are stopped and traffic gets an unavailable page until you start it again.",
                            confirmLabel: "Stop service",
                            danger: true,
                          })
                        )
                          control.run("stop");
                      }}
                    >
                      <Square /> Stop
                    </MenuItem>
                  </>
                )}
              </MenuContent>
            </Menu>
            <Button variant="primary" size="sm" onClick={() => deploy.run()} loading={deploy.pending} disabled={!can("services.deploy")} title={cannot("services.deploy")}>
              <Rocket /> {service.type === "database" && live.status !== "idle" ? "Redeploy" : "Deploy"}
            </Button>
          </div>
        </div>
        {issues.length > 0 && (
          <div
            className={cn("flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px]", issues[0].tone === "bad" ? "border-bad/30 bg-bad-soft" : "border-warn/30 bg-warn-soft")}
          >
            <AlertTriangle className={cn("mt-0.5 size-4 flex-none", issues[0].tone === "bad" ? "text-bad" : "text-warn")} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="font-medium text-fg">{issues.length === 1 ? "This service needs attention" : `${issues.length} problems need attention`}</p>
              <ul className="flex flex-col gap-0.5">
                {issues.map((i) => (
                  <li key={`${i.tab}:${i.text}`} className="flex flex-wrap items-baseline gap-x-2 text-fg-2">
                    <span className="min-w-0">{i.text}</span>
                    {!(i.tab === "overview" ? pathname === base : pathname.startsWith(tabHref(i.tab))) && (
                      <Link href={tabHref(i.tab)} className="font-medium whitespace-nowrap text-accent hover:underline">
                        {i.tab === "domains" ? "Open Domains & ports" : i.tab === "deployments" ? "See deployments" : "Open overview"}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {maintenance?.enabled && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[13px]">
            <Construction className="size-4 flex-none text-warn" />
            <p className="min-w-0 flex-[1_1_16rem] text-fg-2">
              <span className="font-medium text-fg">Maintenance mode is on.</span> Visitors see the maintenance page on every domain
              {maintenance.since ? (
                <>
                  {" "}
                  since <TimeAgo date={maintenance.since} />
                </>
              ) : null}
              .
            </p>
            <div className="flex flex-none items-center gap-2">
              <Link href={`${base}/settings/maintenance`} className="text-[13px] font-medium text-fg-2 hover:text-fg">
                Edit page
              </Link>
              <Button size="sm" onClick={() => toggleMaintenance.run(false)} loading={toggleMaintenance.pending}>
                Turn off
              </Button>
            </div>
          </div>
        )}
        <nav className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto border-b border-line px-1 sm:mx-0 sm:px-0 [&>a:first-child]:sm:pl-0 [&>a:first-child>span]:sm:left-0">
          {tabs.map((t) => {
            const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                ref={active ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}
                className={cn("relative px-3 pt-1 pb-3 text-[13px] font-medium whitespace-nowrap transition-colors", active ? "text-fg" : "text-muted hover:text-fg")}
              >
                <span className="inline-flex items-center gap-1.5">
                  {t.label}
                  {tabIssue(t.href) && <AlertTriangle className={cn("size-3.5", tabIssue(t.href) === "bad" ? "text-bad" : "text-warn")} aria-label="Needs attention" />}
                </span>
                {active && <span className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-fg" />}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}
