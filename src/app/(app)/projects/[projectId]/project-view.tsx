"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import useSWR from "swr";
import { AlertTriangle, ArrowUpRight, Check, FolderInput, SquareCheck, ChevronDown, Copy, Layers3, Plus, Settings } from "lucide-react";
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
import { MoveServicesDialog } from "@/components/move-services-dialog";
import { cn } from "@/lib/utils";
import { useCan } from "@/components/permissions";

type Props = {
  project: { id: string; name: string; description: string | null; color: string };
  environments: { id: string; name: string }[];
  environment: { id: string; name: string };
  initialServices: ServiceCardData[];
};

function EnvironmentSwitcher({ project, environments, environment }: Omit<Props, "initialServices">) {
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
            <MenuItem key={e.id} onClick={() => router.push(`/projects/${project.id}?env=${e.name}`)}>
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
              if (res) router.push(`/projects/${project.id}?env=${name.trim().toLowerCase()}`);
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

function ServiceCard({ projectId, s }: { projectId: string; s: ServiceCardData }) {
  const router = useRouter();
  const sourceKind = s.source && s.type === "app" ? (s.source.includes("/") && !s.source.includes(":") ? "git" : "image") : null;
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
        <ServiceIcon type={s.type} engine={s.engine} icon={s.icon} source={sourceKind} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-fg">{s.name}</span>
            {s.previewPr !== null && <span className="shrink-0 rounded-full bg-info-soft px-1.5 text-[10px] font-semibold text-info">PREVIEW</span>}
          </span>
          <span className="truncate text-xs text-muted">{s.source ?? (s.engine ? s.engine : s.type)}</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 px-4 pb-4">
        {s.domain ? (
          <span
            role="link"
            onClick={(e) => {
              e.preventDefault();
              window.open(`${s.domainHttps ? "https" : "http"}://${s.domain}`, "_blank", "noopener");
            }}
            className="inline-flex w-fit max-w-full items-center gap-1 truncate text-[13px] text-accent hover:underline"
          >
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

export function ProjectView({ project, environments, environment, initialServices }: Props) {
  const can = useCan();
  const { data } = useSWR<{ services: ServiceCardData[] }>(`/api/projects/${project.id}/services?env=${environment.id}`, {
    fallbackData: { services: initialServices },
    refreshInterval: (d) => (d?.services.some((s) => ["building", "deploying", "restarting"].includes(s.status)) ? 2000 : 8000),
  });
  const services = data?.services ?? initialServices;
  const newHref = `/projects/${project.id}/new?env=${environment.name}`;
  // Select mode: tick services, then move them together. Previews follow their parent.
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [moving, setMoving] = React.useState(false);
  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const stopSelecting = () => {
    setSelecting(false);
    setSelected([]);
  };

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
            <EnvironmentSwitcher project={project} environments={environments} environment={environment} />
            {can("services.manage") && services.length > 0 && (
              <Button size="sm" variant={selecting ? "primary" : "secondary"} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
                <SquareCheck /> {selecting ? "Done" : "Select"}
              </Button>
            )}
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
      <PageBody>
        {services.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {services.map((s) => {
              const on = selected.includes(s.id);
              const selectable = s.previewPr === null;
              return (
                <div key={s.id} className="relative">
                  <ServiceCard projectId={project.id} s={s} />
                  {selecting && (
                    <button
                      type="button"
                      disabled={!selectable}
                      aria-pressed={on}
                      aria-label={`${on ? "Unselect" : "Select"} ${s.name}`}
                      title={selectable ? undefined : "Previews move with their parent service"}
                      onClick={() => toggle(s.id)}
                      className={cn(
                        "absolute inset-0 rounded-2xl transition-colors",
                        selectable ? "cursor-pointer" : "cursor-not-allowed bg-bg/50",
                        on ? "bg-accent/[0.06] ring-2 ring-accent" : selectable && "hover:bg-fg/[0.02]",
                      )}
                    >
                      {selectable && (
                        <span
                          className={cn(
                            "absolute top-4 right-4 flex size-5 items-center justify-center rounded-md border shadow-sm transition-colors",
                            on ? "border-accent bg-accent text-accent-fg" : "border-line-strong bg-surface",
                          )}
                        >
                          {on && <Check className="size-3.5" />}
                        </span>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
            <Link
              href={newHref}
              hidden={!can("services.manage")}
              className="flex min-h-[168px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-[13px] font-medium text-muted transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent"
            >
              <Plus className="size-5" />
              Add a service
            </Link>
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
        {selecting && (
          <div className="sticky bottom-4 z-20 mx-auto mt-6 flex w-full max-w-md items-center gap-3 rounded-2xl border border-line bg-surface/95 px-4 py-3 shadow-lg backdrop-blur-xl">
            <span className="min-w-0 flex-1 text-[13px] text-fg-2">{selected.length ? `${selected.length} selected` : "Tap services to select them"}</span>
            <Button size="sm" variant="ghost" onClick={stopSelecting}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!selected.length} onClick={() => setMoving(true)}>
              <FolderInput /> Move{selected.length > 1 ? ` ${selected.length}` : ""}…
            </Button>
          </div>
        )}
        <MoveServicesDialog
          serviceIds={selected}
          environmentId={environment.id}
          open={moving}
          onOpenChange={(o) => {
            setMoving(o);
            if (!o && !selecting) setSelected([]);
          }}
        />
      </PageBody>
    </>
  );
}
