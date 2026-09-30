"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "@/hooks/use-router";
import useSWR from "swr";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  Construction,
  FolderInput,
  Layers,
  Play,
  Plug,
  Power,
  RotateCw,
  Rocket,
  Server as ServerIcon,
  Square,
} from "lucide-react";
import { Breadcrumbs } from "@/components/shell/page-header";
import { ServiceSwitcher, type SiblingService } from "./service-switcher";
import { MoveServicesDialog } from "@/components/move-services-dialog";
import { pickPrimaryDomain } from "@/lib/domains";
import { Button, buttonVariants } from "@/components/ui/button";
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
  /** Services of the same environment, for the breadcrumb switcher. */
  siblings: SiblingService[];
  environment: string;
  service: {
    id: string;
    name: string;
    type: string;
    icon: string | null;
    engine: string | null;
    sourceType: "git" | "image" | null;
    sourceLabel: string;
    environmentId: string;
    isPreview: boolean;
    /** Open previews, for an app that can have them (the Previews tab); null for other services. */
    previews: number | null;
    /** The app a preview belongs to. */
    parent: { id: string; name: string; pr: number } | null;
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
    // Status changes arrive as live events; this only catches containers changing on their own.
    refreshInterval: 15_000,
  });
}

export function ServiceHeader({ project, environment, service, initialLive, server, ports, maintenance, issues, siblings }: Props) {
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
  // `href` names the tab (and its issues); `to` is where it links when that differs.
  const tabs: { href: string; to?: string; label: string; count?: number; exact?: boolean }[] = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/deployments`, label: "Deployments" },
    ...(can("logs.view") ? [{ href: `${base}/logs`, label: "Logs" }] : []),
    ...(can("console.access") ? [{ href: `${base}/console`, label: "Console" }] : []),
    { href: `${base}/metrics`, label: "Metrics" },
    { href: `${base}/variables`, label: "Variables" },
    ...(service.previews !== null ? [{ href: `${base}/previews`, label: "Previews", count: service.previews }] : []),
    ...(service.type !== "database" ? [{ href: `${base}/domains`, label: "Domains & ports" }] : []),
    ...(service.type !== "database" ? [{ href: `${base}/tasks`, label: "Tasks" }] : []),
    ...(can("databases.backups") && ["database", "compose", "app"].includes(service.type) ? [{ href: `${base}/backups`, label: "Backups" }] : []),
    ...(can("services.manage") ? [{ href: `${base}/settings`, to: `${base}/settings/general`, label: "Settings" }] : []),
  ];

  // Brings the active tab into view on phones, only when it changes: live refreshes re-render the header.
  const activeTab = tabs.find((t) => (t.exact ? pathname === t.href : pathname.startsWith(t.href)))?.href;
  const nav = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (activeTab) nav.current?.querySelector(`a[data-tab="${activeTab}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

  /** Worst issue tone for a tab (the Overview tab only marks incidents). */
  const tabIssue = (href: string) => {
    const hit = issues.filter((i) => tabHref(i.tab) === href);
    return hit.length ? (hit.some((i) => i.tone === "bad") ? "bad" : "warn") : null;
  };
  const primary = pickPrimaryDomain(live.domains);
  const stopped = live.status === "stopped";
  const [moving, setMoving] = React.useState(false);
  // Never deployed: nothing runs yet, so there is nothing to restart or stop.
  const notDeployed = live.status === "idle";
  const busy = ["building", "deploying", "restarting"].includes(live.status);
  const preview = service.parent?.pr ?? null;
  const parentMe = service.parent ? (siblings.find((s) => s.id === service.parent!.id) ?? null) : null;
  const me: SiblingService = {
    id: service.id,
    name: service.name,
    type: service.type,
    icon: service.icon,
    engine: service.engine,
    sourceType: service.sourceType,
    status: live.status,
  };

  return (
    <>
      {/* Thin header: breadcrumbs only. Title, actions and tabs belong to the page. */}
      <header className="border-b border-line bg-bg">
        <div className="w-full px-4 py-3 sm:px-8">
          <Breadcrumbs
            items={[
              { label: "Projects", href: "/projects" },
              { label: project.name, href: `/projects/${project.id}?env=${environment}` },
              {
                label: (
                  <ServiceSwitcher
                    projectId={project.id}
                    current={parentMe ?? me}
                    services={siblings.some((s) => s.id === (parentMe ?? me).id) ? siblings : [...siblings, parentMe ?? me]}
                  />
                ),
              },
              // A preview is part of its app: shown as a step below it, not as a service of its own.
              ...(service.parent && preview ? [{ label: `PR #${preview}`, href: `/projects/${project.id}/services/${service.parent.id}/previews` }] : []),
            ]}
          />
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-4 pt-7 sm:px-8">
        {service.parent && (
          <Link
            href={`/projects/${project.id}/services/${service.parent.id}`}
            className="-mb-1 inline-flex w-fit items-center gap-1.5 rounded-lg text-[13px] font-medium text-muted transition-colors hover:text-fg"
          >
            <ArrowLeft className="size-4" /> Back to {service.parent.name}
          </Link>
        )}
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3.5 sm:flex-[1_1_20rem] sm:items-center">
            <ServiceIcon type={service.type} engine={service.engine} icon={service.icon} source={service.sourceType} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className={cn("flex min-w-0 items-center gap-3", preview && "flex-wrap gap-y-1.5")}>
                <h1 className="truncate text-[22px] leading-tight font-semibold">{service.parent?.name ?? service.name}</h1>
                {preview && <span className="shrink-0 rounded-full bg-info-soft px-2.5 py-0.5 text-xs font-semibold text-info">Preview · PR #{preview}</span>}
                <StatusLabel status={live.status} className="shrink-0 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs ring-1 ring-line" />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
                {service.sourceLabel && <span className="max-w-full truncate font-mono text-[12px]">{service.sourceLabel}</span>}
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
                <span className="inline-flex items-center gap-1 text-[12px]" title="Environment">
                  <Layers className="size-3 shrink-0 text-faint" />
                  {environment}
                </span>
                {server && (
                  <Link href={`/servers/${server.id}`} title="Server" className="inline-flex max-w-full items-center gap-1 text-[12px] hover:text-fg">
                    <ServerIcon className="size-3 shrink-0 text-faint" />
                    <span className="truncate">{server.name}</span>
                  </Link>
                )}
              </div>
            </div>
          </div>
          {/* Roles that cannot deploy only look: no Manage or Deploy buttons. */}
          {can("services.deploy") && (
            <div className="grid grid-cols-2 gap-2 sm:ml-auto sm:flex sm:flex-none sm:items-center">
              <Menu>
                <MenuTrigger
                  disabled={!can("services.deploy")}
                  title={cannot("services.deploy")}
                  className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "h-9 gap-1.5 sm:h-8 disabled:cursor-not-allowed")}
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
                  {!service.isPreview && can("services.manage") && (
                    <>
                      <MenuSeparator />
                      <MenuItem onClick={() => setMoving(true)}>
                        <FolderInput /> Move to project…
                      </MenuItem>
                    </>
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
              <MoveServicesDialog serviceIds={[service.id]} environmentId={service.environmentId} open={moving} onOpenChange={setMoving} />
              <Button
                variant="primary"
                size="sm"
                className="h-9 sm:h-8"
                onClick={() => deploy.run()}
                loading={deploy.pending}
                disabled={!can("services.deploy")}
                title={cannot("services.deploy")}
              >
                <Rocket /> {live.status === "idle" || live.status === "stopped" ? "Deploy" : "Redeploy"}
              </Button>
            </div>
          )}
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
            {(can("services.manage") || can("services.deploy")) && (
              <div className="flex flex-none items-center gap-2">
                {can("services.manage") && (
                  <Link href={`${base}/settings/maintenance`} className="text-[13px] font-medium text-fg-2 hover:text-fg">
                    Edit page
                  </Link>
                )}
                {can("services.deploy") && (
                  <Button size="sm" onClick={() => toggleMaintenance.run(false)} loading={toggleMaintenance.pending}>
                    Turn off
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        {/* Phones: tabs scroll sideways; the fade shows there are more. */}
        <div className="-mx-4 border-b border-line sm:mx-0">
          <nav
            ref={nav}
            className="scrollbar-none flex gap-1 overflow-x-auto px-1 pr-8 [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] sm:px-0 sm:pr-0 sm:[mask-image:none] [&>a:first-child]:sm:pl-0 [&>a:first-child>span]:sm:left-0"
          >
            {tabs.map((t) => {
              const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
              return (
                <Link
                  key={t.href}
                  href={t.to ?? t.href}
                  data-tab={t.href}
                  className={cn("relative px-3 pt-1 pb-3 text-[13px] font-medium whitespace-nowrap transition-colors", active ? "text-fg" : "text-muted hover:text-fg")}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {t.label}
                    {!!t.count && (
                      <span className="min-w-[18px] rounded-full bg-fg/[0.08] px-1.5 py-px text-center text-[11px] leading-4 font-semibold text-fg-2 tabular-nums">{t.count}</span>
                    )}
                    {tabIssue(t.href) && <AlertTriangle className={cn("size-3.5", tabIssue(t.href) === "bad" ? "text-bad" : "text-warn")} aria-label="Needs attention" />}
                  </span>
                  {active && <span className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-fg" />}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </>
  );
}
