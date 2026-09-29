"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import useSWR from "swr";
import { ArrowUpRight, Check, ChevronDown, Layers3, Plus, Settings } from "lucide-react";
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

type Props = {
  project: { id: string; name: string; description: string | null; color: string };
  environments: { id: string; name: string }[];
  environment: { id: string; name: string };
  initialServices: ServiceCardData[];
};

function EnvironmentSwitcher({ project, environments, environment }: Omit<Props, "initialServices">) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
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
          <MenuSeparator />
          <MenuItem onClick={() => setOpen(true)}>
            <Plus /> New environment
          </MenuItem>
        </MenuContent>
      </Menu>
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
  const sourceKind = s.source && s.type === "app" ? (s.source.includes("/") && !s.source.includes(":") ? "git" : "image") : null;
  return (
    <Link
      href={`/projects/${projectId}/services/${s.id}`}
      className="group flex flex-col rounded-2xl border border-line bg-surface shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md"
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
  const { data } = useSWR<{ services: ServiceCardData[] }>(`/api/projects/${project.id}/services?env=${environment.id}`, {
    fallbackData: { services: initialServices },
    refreshInterval: (d) =>
      d?.services.some((s) => ["building", "deploying", "restarting"].includes(s.status)) ? 2000 : 8000,
  });
  const services = data?.services ?? initialServices;
  const newHref = `/projects/${project.id}/new?env=${environment.name}`;

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
            <Link href={`/projects/${project.id}/settings?env=${environment.name}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              <Settings /> Settings
            </Link>
            <Link href={newHref} className={buttonVariants({ variant: "primary", size: "sm" })}>
              <Plus /> New service
            </Link>
          </>
        }
      />
      <PageBody>
        {services.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {services.map((s) => (
              <ServiceCard key={s.id} projectId={project.id} s={s} />
            ))}
            <Link
              href={newHref}
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
                <Link href={newHref} className={buttonVariants({ variant: "primary", size: "sm" })}>
                  <Plus /> New service
                </Link>
              }
            />
          </Card>
        )}
      </PageBody>
    </>
  );
}
