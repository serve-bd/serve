"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { Building2, Eye, EyeOff, FolderKanban, Layers, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader, CopyButton, EmptyState } from "@/components/ui/misc";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { redeployEnvironment, saveSharedVars } from "@/server/actions/projects";
import { redeployReferencing, saveOrgSharedVars, saveProjectSharedVars } from "@/server/actions/shared-vars";
import { cn } from "@/lib/utils";

export type Scope = "org" | "project" | "environment";

type Row = { id: number; key: string; value: string };

let seq = 0;
const withId = (v: { key: string; value: string }): Row => ({
  ...v,
  id: ++seq,
});

const scopes: {
  value: Scope;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "org", label: "Organization", icon: Building2 },
  { value: "project", label: "Projects", icon: FolderKanban },
  { value: "environment", label: "Environments", icon: Layers },
];

const refPrefix: Record<Scope, string> = {
  org: "org",
  project: "project",
  environment: "environment",
};

const scopeText: Record<Scope, { title: string; description: string }> = {
  org: {
    title: "Organization variables",
    description: "Shared by every project. Services use them only where you reference them.",
  },
  project: {
    title: "Project variables",
    description: "Shared by every environment of the project. Services use them only where you reference them.",
  },
  environment: {
    title: "Environment variables",
    description: "Added to every service in the environment automatically. Service variables with the same name win.",
  },
};

export function SharedVariables({
  scope,
  canEdit,
  projects,
  environments,
  project,
  environment,
  vars,
}: {
  scope: Scope;
  canEdit: boolean;
  projects: { id: string; name: string }[];
  environments: { id: string; name: string }[];
  project: { id: string; name: string } | null;
  environment: { id: string; name: string } | null;
  vars: { key: string; value: string }[];
}) {
  const router = useRouter();
  const [rows, setRows] = React.useState<Row[]>(() => vars.map(withId));
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set());
  const [saved, setSaved] = React.useState(vars);

  const href = (next: { scope?: Scope; project?: string; env?: string }) => {
    const q = new URLSearchParams();
    const s = next.scope ?? scope;
    if (s !== "org") q.set("scope", s);
    const p = next.project ?? project?.id;
    if (s !== "org" && p) q.set("project", p);
    const e = next.env ?? (next.project ? undefined : environment?.name);
    if (s === "environment" && e) q.set("env", e);
    const qs = q.toString();
    return `/shared-variables${qs ? `?${qs}` : ""}`;
  };

  const clean = rows.filter((r) => r.key.trim()).map((r) => ({ key: r.key.trim(), value: r.value }));
  const dirty = JSON.stringify(clean) !== JSON.stringify(saved);
  const target = scope === "org" ? true : scope === "project" ? !!project : !!environment;

  const save = useAction(
    () => (scope === "org" ? saveOrgSharedVars(clean) : scope === "project" ? saveProjectSharedVars(project!.id, clean) : saveSharedVars(environment!.id, clean)),
    { success: "Shared variables saved", onSuccess: () => setSaved(clean) },
  );
  const redeploy = useAction(() => (scope === "environment" ? redeployEnvironment(environment!.id) : redeployReferencing(scope === "org" ? "org" : { projectId: project!.id })), {
    success: (d) => (d.count ? `Redeploying ${d.count} service${d.count === 1 ? "" : "s"}` : "No running service uses these variables"),
  });

  const update = (id: number, patch: Partial<Row>) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = () => setRows((prev) => [...prev, withId({ key: "", value: "" })]);
  const text = scopeText[scope];

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1 ring-1 ring-line">
        {scopes.map((s) => (
          <Link
            key={s.value}
            href={href({ scope: s.value })}
            className={cn(
              "flex min-w-0 items-center justify-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors",
              s.value === scope ? "bg-surface text-fg shadow-sm ring-1 ring-line" : "text-muted hover:text-fg",
            )}
          >
            <s.icon className="hidden size-3.5 flex-none sm:block" />
            <span className="truncate">{s.label}</span>
          </Link>
        ))}
      </div>

      {scope !== "org" && !project ? (
        <Card>
          <EmptyState title="No projects yet" description="Create a project to give it shared variables." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <CardHeader
            title={text.title}
            description={text.description}
            actions={
              scope !== "org" && (
                <div className="flex flex-wrap gap-2">
                  <Select
                    size="sm"
                    value={project!.id}
                    onValueChange={(v) => router.push(href({ project: v }))}
                    options={projects.map((p) => ({
                      value: p.id,
                      label: p.name,
                    }))}
                    className="w-40"
                  />
                  {scope === "environment" && environment && (
                    <Select
                      size="sm"
                      value={environment.name}
                      onValueChange={(v) => router.push(href({ env: v }))}
                      options={environments.map((e) => ({
                        value: e.name,
                        label: e.name,
                      }))}
                      className="w-36"
                    />
                  )}
                </div>
              )
            }
          />
          {!target ? (
            <EmptyState title="No environments" description="This project has no environments yet." />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No shared variables yet"
              description={canEdit ? "Add a variable and reference it from any service." : "Your role cannot see or edit these values."}
              action={
                canEdit && (
                  <Button size="sm" onClick={add}>
                    <Plus /> Add variable
                  </Button>
                )
              }
            />
          ) : (
            <div className="divide-y divide-line">
              <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)_32px] gap-3 px-5 py-2 text-[11px] font-semibold text-faint sm:grid">
                <span>Name</span>
                <span>Value</span>
                <span>Reference</span>
                <span />
              </div>
              {rows.map((r) => {
                const shown = revealed.has(r.id);
                const ref = r.key.trim() ? `\${{${refPrefix[scope]}.${r.key.trim()}}}` : "";
                return (
                  <div key={r.id} className="grid grid-cols-1 items-center gap-2 px-5 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)_32px] sm:gap-3">
                    <Input
                      value={r.key}
                      onChange={(e) =>
                        update(r.id, {
                          key: e.target.value.replace(/\s/g, "_"),
                        })
                      }
                      placeholder="KEY"
                      className="font-mono text-[12.5px]"
                      readOnly={!canEdit}
                    />
                    <div className="relative">
                      <Input
                        value={canEdit ? r.value : "••••••••"}
                        type={shown || !canEdit ? "text" : "password"}
                        onChange={(e) => update(r.id, { value: e.target.value })}
                        placeholder="value"
                        className="pr-9 font-mono text-[12.5px]"
                        autoComplete="off"
                        readOnly={!canEdit}
                        disabled={!canEdit}
                      />
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() =>
                            setRevealed((s) => {
                              const n = new Set(s);
                              if (n.has(r.id)) n.delete(r.id);
                              else n.add(r.id);
                              return n;
                            })
                          }
                          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-faint hover:text-fg"
                          aria-label={shown ? "Hide value" : "Show value"}
                        >
                          {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                        </button>
                      )}
                    </div>
                    <div className="flex min-w-0 items-center gap-2 sm:contents">
                      <div className="flex h-9 min-w-0 flex-1 items-center rounded-lg bg-surface-2 pl-2.5 ring-1 ring-line">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{ref || "—"}</span>
                        {ref && <CopyButton value={ref} label={`Copy ${ref}`} className="size-7 flex-none" />}
                      </div>
                      {canEdit ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setRows((prev) => prev.filter((x) => x.id !== r.id))}
                          aria-label="Remove variable"
                          className="justify-self-end"
                        >
                          <Trash2 />
                        </Button>
                      ) : (
                        <span />
                      )}
                    </div>
                  </div>
                );
              })}
              {canEdit && (
                <div className="px-5 py-3">
                  <Button size="sm" variant="ghost" onClick={add}>
                    <Plus /> Add variable
                  </Button>
                </div>
              )}
            </div>
          )}
          {canEdit && target && (
            <CardFooter>
              <span className="mr-auto hidden text-xs text-muted sm:inline">{dirty ? "Unsaved changes" : "Changes apply on the next deploy."}</span>
              <Button size="sm" variant="ghost" onClick={() => redeploy.run()} loading={redeploy.pending} disabled={dirty}>
                Redeploy
                <span className="hidden sm:inline"> affected services</span>
              </Button>
              <Button size="sm" variant="primary" onClick={() => save.run()} loading={save.pending} disabled={!dirty}>
                Save
              </Button>
            </CardFooter>
          )}
        </Card>
      )}

      <Card className="p-5">
        <p className="text-[13px] font-semibold text-fg">Using shared variables</p>
        <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-muted">
          <li>
            <code className="font-mono text-fg-2">{"${{org.KEY}}"}</code> reads an organization variable. <code className="font-mono text-fg-2">{"${{team.KEY}}"}</code> works too.
          </li>
          <li>
            <code className="font-mono text-fg-2">{"${{project.KEY}}"}</code> reads a variable of the service&apos;s project.
          </li>
          <li>
            <code className="font-mono text-fg-2">{"${{environment.KEY}}"}</code> reads a variable of the service&apos;s environment. These are also added to every service
            automatically.
          </li>
          <li>
            Use a reference as a whole value or inside one, like <code className="font-mono text-fg-2">{"https://${{project.API_HOST}}/v1"}</code>.
          </li>
        </ul>
      </Card>
    </div>
  );
}
