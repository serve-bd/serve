"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "@/hooks/use-router";
import useSWR from "swr";
import { ArrowUpRight, ChevronDown, Play, Plug, Power, RotateCw, Rocket, Server as ServerIcon, Square } from "lucide-react";
import { Breadcrumbs } from "@/components/shell/page-header";
import { pickPrimaryDomain } from "@/lib/domains";
import { Button } from "@/components/ui/button";
import { StatusLabel } from "@/components/ui/status";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { ServiceIcon } from "@/components/service-icon";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { deployService, serviceControl } from "@/server/actions/services";
import type { ServiceLive } from "@/server/service-data";
import { cn } from "@/lib/utils";

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
};

export function useServiceLive(serviceId: string, fallback?: ServiceLive) {
  return useSWR<ServiceLive>(`/api/services/${serviceId}/live`, {
    fallbackData: fallback,
    refreshInterval: (d) =>
      d && (["building", "deploying", "restarting"].includes(d.status) || d.deployments.some((x) => ["queued", "building", "deploying"].includes(x.status)))
        ? 1500
        : 6000,
  });
}

export function ServiceHeader({ project, environment, service, initialLive, server, ports }: Props) {
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

  const tabs = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/deployments`, label: "Deployments" },
    { href: `${base}/logs`, label: "Logs" },
    { href: `${base}/console`, label: "Console" },
    { href: `${base}/metrics`, label: "Metrics" },
    { href: `${base}/variables`, label: "Variables" },
    ...(service.type !== "database" ? [{ href: `${base}/domains`, label: "Domains & ports" }] : []),
    ...(service.type === "database" ? [{ href: `${base}/backups`, label: "Backups" }] : [{ href: `${base}/tasks`, label: "Tasks" }]),
    { href: `${base}/settings`, label: "Settings" },
  ];

  const primary = pickPrimaryDomain(live.domains);
  const stopped = live.status === "stopped";
  const busy = ["building", "deploying", "restarting"].includes(live.status);

  return (
    <>
      {/* Thin header: breadcrumbs only. Title, actions and tabs belong to the page. */}
      <header className="border-b border-line bg-bg">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-3 sm:px-8">
          <Breadcrumbs
            items={[
              { label: "Projects", href: "/projects" },
              { label: project.name, href: `/projects/${project.id}?env=${environment}` },
              { label: service.name },
            ]}
          />
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
              <MenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-fg shadow-sm hover:bg-hover">
                <Power className="size-3.5" /> Manage <ChevronDown className="size-3.5 text-muted" />
              </MenuTrigger>
              <MenuContent>
                {stopped ? (
                  <MenuItem onClick={() => control.run("start")}>
                    <Play /> Start
                  </MenuItem>
                ) : (
                  <MenuItem onClick={() => control.run("restart")} disabled={busy}>
                    <RotateCw /> Restart
                  </MenuItem>
                )}
                {!stopped && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      danger
                      disabled={busy}
                      onClick={async () => {
                        if (await confirm({ title: `Stop ${service.name}?`, description: "Containers are stopped and traffic gets an unavailable page until you start it again.", confirmLabel: "Stop service", danger: true }))
                          control.run("stop");
                      }}
                    >
                      <Square /> Stop
                    </MenuItem>
                  </>
                )}
              </MenuContent>
            </Menu>
            <Button variant="primary" size="sm" onClick={() => deploy.run()} loading={deploy.pending}>
              <Rocket /> {service.type === "database" ? "Redeploy" : "Deploy"}
            </Button>
          </div>
        </div>
        <nav className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto border-b border-line px-1 sm:mx-0 sm:px-0 [&>a:first-child]:sm:pl-0 [&>a:first-child>span]:sm:left-0">
          {tabs.map((t) => {
            const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                ref={active ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}
                className={cn(
                  "relative px-3 pt-1 pb-3 text-[13px] font-medium whitespace-nowrap transition-colors",
                  active ? "text-fg" : "text-muted hover:text-fg",
                )}
              >
                {t.label}
                {active && <span className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-fg" />}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}
