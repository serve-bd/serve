"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import useSWR from "swr";
import { AlertTriangle, ArrowUpRight, Check, ChevronDown, Copy, Layers3, Plus, Settings } from "lucide-react";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, EmptyState, TimeAgo } from "@/components/ui/misc";
import { StatusLabel } from "@/components/ui/status";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ServiceIcon } from "@/components/service-icon";
import { projectColor } from "@/components/shell/project-color";
import { useAction } from "@/hooks/use-action";
import { createEnvironment } from "@/server/actions/projects";
import type { ServiceCardData } from "@/server/project-data";
import { CloneEnvironmentDialog } from "./clone-environment";
import { ProjectCanvas } from "./project-canvas";
import { ViewToggle } from "@/components/view-toggle";
import { cn } from "@/lib/utils";
import { useCan } from "@/components/permissions";

type Props = {
  project: { id: string; name: string; description: string | null; color: string; groupServices: boolean };
  environments: { id: string; name: string }[];
  environment: { id: string; name: string };
  initialServices: ServiceCardData[];
  view: "grid" | "list" | "canvas";
  /** Saved canvas positions of this environment. */
  positions: Record<string, { x: number; y: number }>;
};

function EnvironmentSwitcher({ project, environments, environment, view }: Pick<Props, "project" | "environments" | "environment" | "view">) {
  const suffix = view === "grid" ? "" : `&view=${view}`;
  const can = useCan();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [cloning, setCloning] = React.useState(false);
  const { run, pending } = useAction((name: string) => createEnvironment(project.id, name), {
    success: "Environment created",
    onSuccess: () => setOpen(false),
  });
  return (
    <>
      <Menu>
        <MenuTrigger className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <span className="size-1.5 rounded-full bg-ok" />
          {environment.name}
          <ChevronDown className="!size-3.5 text-muted" />
        </MenuTrigger>
        <MenuContent align="start">
          <MenuLabel>Environments</MenuLabel>
          {environments.map((e) => (
            <MenuItem key={e.id} onClick={() => router.push(`/projects/${project.id}?env=${e.name}${suffix}`)}>
              <span className="flex-1">{e.name}</span>
              {e.id === environment.id && <Check className="!text-accent" />}
            </MenuItem>
          ))}
          {can("projects.manage") && (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => setOpen(true)}>
                <Plus /> New environment
              </MenuItem>
              <MenuItem onClick={() => setCloning(true)}>
                <Copy /> Clone {environment.name}…
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
      <CloneEnvironmentDialog projectId={project.id} environment={environment} open={cloning} onOpenChange={setCloning} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const name = String(new FormData(e.currentTarget).get("name"));
              const res = await run(name);
              if (res) router.push(`/projects/${project.id}?env=${name.trim().toLowerCase()}${suffix}`);
            }}
          >
            <DialogHeader title="New environment" description="Environments have their own services, variables and domains, like staging and production." />
            <DialogBody>
              <Field label="Name">
                <Input name="name" required autoFocus placeholder="staging" pattern="[a-z0-9][a-z0-9-]*" />
              </Field>
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" size="sm" loading={pending}>
                Create environment
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

const sourceKind = (s: ServiceCardData) => (s.source && s.type === "app" ? (s.source.includes("/") && !s.source.includes(":") ? "git" : "image") : null);

function openDomain(e: React.MouseEvent, s: ServiceCardData) {
  e.preventDefault();
  window.open(`${s.domainHttps ? "https" : "http"}://${s.domain}`, "_blank", "noopener");
}

function ServiceCard({ projectId, s }: { projectId: string; s: ServiceCardData }) {
  const router = useRouter();
  return (
    <Link
      href={`/projects/${projectId}/services/${s.id}`}
      className={cn(
        "group flex h-full flex-col rounded-2xl border bg-surface shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-md",
        s.issues[0]?.tone === "bad"
          ? "border-bad/40 hover:border-bad/60"
          : s.issues[0]?.tone === "warn"
            ? "border-warn/40 hover:border-warn/60"
            : "border-line hover:border-line-strong",
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <ServiceIcon type={s.type} engine={s.engine} icon={s.icon} source={sourceKind(s)} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-fg">{s.name}</span>
          </span>
          <span className="truncate text-xs text-muted">{s.source ?? (s.engine ? s.engine : s.type)}</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 px-4 pb-4">
        {s.domain ? (
          <span role="link" onClick={(e) => openDomain(e, s)} className="inline-flex w-fit max-w-full items-center gap-1 truncate text-[13px] text-accent hover:underline">
            <span className="truncate">{s.domain}</span>
            <ArrowUpRight className="size-3 shrink-0" />
          </span>
        ) : (
          <span className="text-[13px] text-faint">{s.type === "database" ? "Private network only" : "No domain"}</span>
        )}
      </div>
      {s.issues.length > 0 && (
        <span
          role="link"
          title={s.issues.map((i) => i.text).join("\n")}
          onClick={(e) => {
            e.preventDefault();
            router.push(`/projects/${projectId}/services/${s.id}${s.issues[0].tab === "overview" ? "" : `/${s.issues[0].tab}`}`);
          }}
          className={cn(
            "mx-4 mb-3 flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs leading-snug",
            s.issues[0].tone === "bad" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn",
          )}
        >
          <AlertTriangle className="mt-px size-3.5 flex-none" />
          <span className="min-w-0 flex-1 text-fg-2">
            <span className="line-clamp-2">{s.issues[0].text}</span>
            {s.issues.length > 1 && <span className="text-muted"> · {s.issues.length - 1} more</span>}
          </span>
        </span>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
        <StatusLabel status={s.status} className="text-xs" />
        {s.lastDeploy && (
          <span className="truncate text-xs text-faint">
            <TimeAgo date={s.lastDeploy.createdAt} />
          </span>
        )}
      </div>
    </Link>
  );
}

/** One service as a row of the list view. */
function ServiceRow({ projectId, s }: { projectId: string; s: ServiceCardData }) {
  const issue = s.issues[0];
  return (
    <Link href={`/projects/${projectId}/services/${s.id}`} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-fg/[0.025] sm:gap-4">
      <ServiceIcon type={s.type} engine={s.engine} icon={s.icon} source={sourceKind(s)} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-semibold text-fg">{s.name}</span>
          {issue && (
            <span title={s.issues.map((i) => i.text).join("\n")} className={cn("flex-none", issue.tone === "bad" ? "text-bad" : "text-warn")}>
              <AlertTriangle className="size-3.5" />
            </span>
          )}
        </span>
        <span className="truncate text-xs text-muted">{s.source ?? (s.engine ? s.engine : s.type)}</span>
      </span>
      <span className="hidden w-56 min-w-0 md:block">
        {s.domain ? (
          <span role="link" onClick={(e) => openDomain(e, s)} className="inline-flex max-w-full items-center gap-1 text-[13px] text-accent hover:underline">
            <span className="truncate">{s.domain}</span>
            <ArrowUpRight className="size-3 shrink-0" />
          </span>
        ) : (
          <span className="text-[13px] text-faint">{s.type === "database" ? "Private network only" : "No domain"}</span>
        )}
      </span>
      <span className="hidden w-32 truncate text-[13px] text-fg-2 lg:block">{s.serverName}</span>
      <StatusLabel status={s.status} className="w-24 flex-none text-xs" />
      <span className="hidden w-20 flex-none text-right text-xs text-faint sm:block">{s.lastDeploy ? <TimeAgo date={s.lastDeploy.createdAt} /> : null}</span>
    </Link>
  );
}

const GROUPS: { key: string; label: string }[] = [
  { key: "app", label: "Applications" },
  { key: "database", label: "Databases" },
  { key: "compose", label: "Stacks" },
];

/** Services in their groups, in a fixed order; empty groups are left out. */
function groupServices(services: ServiceCardData[]) {
  const known = new Set<string>(GROUPS.map((g) => g.key));
  return GROUPS.map((g) => ({ key: g.key, label: g.label, services: services.filter((s) => s.type === g.key) }))
    .concat([{ key: "other", label: "Other", services: services.filter((s) => !known.has(s.type)) }])
    .filter((g) => g.services.length);
}

const VIEW_KEY = "serve-project-view-v2";

export function ProjectView({ project, environments, environment, initialServices, view, positions }: Props) {
  const can = useCan();
  const router = useRouter();
  const setView = React.useCallback(
    (v: Props["view"]) => {
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {}
      router.replace(`/projects/${project.id}?env=${environment.name}${v === "grid" ? "" : `&view=${v}`}`, { scroll: false });
    },
    [router, project.id, environment.name],
  );
  // Opened without a choice in the URL: use the one from last time.
  const asked = React.useRef(false);
  React.useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(VIEW_KEY);
    } catch {}
    if ((stored === "canvas" || stored === "list") && view === "grid" && !new URLSearchParams(window.location.search).has("view")) setView(stored);
  }, [view, setView]);
  const { data } = useSWR<{ services: ServiceCardData[] }>(`/api/projects/${project.id}/services?env=${environment.id}`, {
    fallbackData: { services: initialServices },
    // Status changes arrive as live events; this only catches containers changing on their own.
    refreshInterval: 15_000,
  });
  const services = data?.services ?? initialServices;
  const newHref = `/projects/${project.id}/new?env=${environment.name}`;
  const groups = project.groupServices ? groupServices(services) : [{ key: "all", label: "", services }];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: project.name }]}
        title={
          <span className="flex items-center gap-2.5">
            <span className="size-3 rounded-[4px]" style={{ background: projectColor(project.color) }} />
            {project.name}
          </span>
        }
        description={project.description ?? undefined}
        actions={
          <>
            {services.length > 0 && <ViewToggle view={view} views={["grid", "list", "canvas"]} onChange={setView} />}
            <EnvironmentSwitcher project={project} environments={environments} environment={environment} view={view} />
            {can("projects.manage") && (
              <Link href={`/projects/${project.id}/settings?env=${environment.name}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                <Settings /> Settings
              </Link>
            )}
            {can("services.manage") && (
              <Link href={newHref} className={buttonVariants({ variant: "primary", size: "sm" })}>
                <Plus /> New service
              </Link>
            )}
          </>
        }
      />
      {view === "canvas" && services.length > 0 ? (
        <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-8 sm:px-8">
          <div className="h-[70dvh] min-h-[380px] overflow-hidden rounded-2xl border border-line bg-sunken sm:h-[calc(100dvh-16rem)] sm:min-h-[460px]">
            <ProjectCanvas key={environment.id} projectId={project.id} environmentId={environment.id} services={services} saved={positions} canManage={can("services.manage")} />
          </div>
        </div>
      ) : (
        <PageBody>
          {services.length ? (
            <div className="flex flex-col gap-8">
              {groups.map((g) => {
                return (
                  <section key={g.key} className="flex flex-col gap-3">
                    {g.label && (
                      <h2 className="flex items-center gap-2 text-[13px] font-semibold text-fg-2">
                        {g.label}
                        <span className="rounded-md bg-surface-2 px-1.5 py-px text-[11px] font-medium text-muted tabular-nums">{g.services.length}</span>
                      </h2>
                    )}
                    {view === "list" ? (
                      <Card className="divide-y divide-line overflow-hidden">
                        {g.services.map((s) => (
                          <ServiceRow key={s.id} projectId={project.id} s={s} />
                        ))}
                      </Card>
                    ) : (
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {g.services.map((s) => (
                          <ServiceCard key={s.id} projectId={project.id} s={s} />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <Card>
              <EmptyState
                icon={<Layers3 />}
                title={`Nothing in ${environment.name} yet`}
                description="Deploy from a Git repository or Docker image, add a database, or start a one-click service."
                action={
                  can("services.manage") && (
                    <Link href={newHref} className={buttonVariants({ variant: "primary", size: "sm" })}>
                      <Plus /> New service
                    </Link>
                  )
                }
              />
            </Card>
          )}
        </PageBody>
      )}
    </>
  );
}
