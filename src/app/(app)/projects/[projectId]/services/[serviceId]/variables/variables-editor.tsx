"use client";

import * as React from "react";
import Link from "next/link";
import { Code2, Eye, EyeOff, Plus, Trash2, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader, CopyButton, EmptyState } from "@/components/ui/misc";
import { Input, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip } from "@/components/ui/tooltip";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useAction } from "@/hooks/use-action";
import { saveEnvVars } from "@/server/actions/services";
import { parseEnv } from "@/lib/env";
import { cn } from "@/lib/utils";
import { referenceOf } from "@/lib/refs";

type Var = { key: string; value: string; buildTime: boolean; runtime: boolean; id?: number };

let seq = 0;
const withId = (v: Omit<Var, "id">): Var => ({ ...v, id: ++seq });

function toRaw(vars: Var[]) {
  return vars
    .filter((v) => v.key)
    .map((v) => `${v.key}=${/[\s#"'$]/.test(v.value) ? JSON.stringify(v.value) : v.value}`)
    .join("\n");
}

export function VariablesEditor({
  serviceId,
  type,
  status,
  initial,
  shared,
  references,
  settingsHref,
}: {
  serviceId: string;
  type: string;
  status: string;
  initial: Omit<Var, "id">[];
  shared: string[];
  references: { name: string; keys: string[] }[];
  settingsHref: string;
}) {
  const [vars, setVars] = React.useState<Var[]>(() => initial.map(withId));
  const [raw, setRaw] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [baseline, setBaseline] = React.useState(() => JSON.stringify(initial));

  const current = raw !== null ? parseEnv(raw).map((v) => ({ ...v, buildTime: vars.find((x) => x.key === v.key)?.buildTime ?? false, runtime: vars.find((x) => x.key === v.key)?.runtime ?? true })) : vars.map((v) => ({ key: v.key, value: v.value, buildTime: v.buildTime, runtime: v.runtime }));
  const dirty = JSON.stringify(current.filter((v) => v.key)) !== baseline;

  const save = useAction((redeploy: boolean) => saveEnvVars(serviceId, current, redeploy), {
    success: (d) => (d.deploymentId ? "Saved. Redeploying…" : "Variables saved"),
    onSuccess: () => {
      setBaseline(JSON.stringify(current.filter((v) => v.key)));
      if (raw !== null) {
        setVars(current.map(withId));
        setRaw(null);
      }
      setConfirmOpen(false);
    },
  });

  const update = (id: number, patch: Partial<Var>) => setVars((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  const hasBuild = type === "app";
  const canRedeploy = status !== "idle";

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <Card className="overflow-hidden">
        <CardHeader
          title="Environment variables"
          description="Encrypted at rest. Changes apply on the next deploy."
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (raw === null) setRaw(toRaw(vars));
                else {
                  setVars(parseEnv(raw).map((v) => withId({ ...v, buildTime: vars.find((x) => x.key === v.key)?.buildTime ?? false, runtime: true })));
                  setRaw(null);
                }
              }}
            >
              <Code2 /> {raw === null ? "Raw editor" : "Table view"}
            </Button>
          }
        />
        {raw !== null ? (
          <div className="p-4">
            <Textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={Math.max(10, raw.split("\n").length + 2)} className="font-mono text-[12.5px] leading-relaxed" spellCheck={false} placeholder="KEY=value" />
          </div>
        ) : vars.length === 0 ? (
          <EmptyState title="No variables yet" description="Add variables, paste a .env file in the raw editor, or reference another service." action={<Button size="sm" onClick={() => setVars([withId({ key: "", value: "", buildTime: false, runtime: true })])}><Plus /> Add variable</Button>} />
        ) : (
          <div className="divide-y divide-line">
            <div className={cn("hidden gap-3 px-5 py-2 text-[11px] font-semibold text-faint sm:grid", hasBuild ? "grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_120px_32px]" : "grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_32px]")}>
              <span>Name</span>
              <span>Value</span>
              {hasBuild && <span>Available at</span>}
              <span />
            </div>
            {vars.map((v) => {
              const shown = revealed.has(v.id!);
              const isRef = v.value.includes("${{");
              return (
                <div key={v.id} className={cn("grid items-center gap-3 px-5 py-2.5", hasBuild ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_120px_32px]" : "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_32px]")}>
                  <Input value={v.key} onChange={(e) => update(v.id!, { key: e.target.value.replace(/\s/g, "_") })} placeholder="KEY" className="font-mono text-[12.5px]" />
                  <div className="relative">
                    <Input
                      value={v.value}
                      type={shown || isRef ? "text" : "password"}
                      onChange={(e) => update(v.id!, { value: e.target.value })}
                      placeholder="value"
                      className={cn("pr-9 font-mono text-[12.5px]", isRef && "text-accent")}
                      autoComplete="off"
                    />
                    {!isRef && (
                      <button
                        type="button"
                        onClick={() => setRevealed((s) => { const n = new Set(s); if (n.has(v.id!)) n.delete(v.id!); else n.add(v.id!); return n; })}
                        className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-faint hover:text-fg"
                        aria-label={shown ? "Hide value" : "Show value"}
                      >
                        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    )}
                  </div>
                  {hasBuild && (
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <Tooltip content="Available while the app runs">
                        <label className="flex items-center gap-1.5">
                          <Checkbox checked={v.runtime} onCheckedChange={(c) => update(v.id!, { runtime: !!c })} /> Run
                        </label>
                      </Tooltip>
                      <Tooltip content="Passed as a build argument">
                        <label className="flex items-center gap-1.5">
                          <Checkbox checked={v.buildTime} onCheckedChange={(c) => update(v.id!, { buildTime: !!c })} /> Build
                        </label>
                      </Tooltip>
                    </div>
                  )}
                  <Button variant="ghost" size="icon-sm" onClick={() => setVars((prev) => prev.filter((x) => x.id !== v.id))} aria-label="Remove variable">
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
            <div className="px-5 py-3">
              <Button size="sm" variant="ghost" onClick={() => setVars((prev) => [...prev, withId({ key: "", value: "", buildTime: false, runtime: true })])}>
                <Plus /> Add variable
              </Button>
            </div>
          </div>
        )}
        <CardFooter className={cn("transition-opacity", !dirty && "opacity-60")}>
          <span className="text-xs text-muted">{dirty ? "You have unsaved changes." : `${current.filter((v) => v.key).length} variables`}</span>
          <div className="flex gap-2">
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => { setVars(initial.map(withId)); setRaw(null); }}>
                Discard
              </Button>
            )}
            <Button size="sm" variant="primary" disabled={!dirty} loading={save.pending} onClick={() => (canRedeploy ? setConfirmOpen(true) : save.run(false))}>
              Save changes
            </Button>
          </div>
        </CardFooter>
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="References" description="Link values from other services. They update when those services change." />
          <div className="flex max-h-80 flex-col gap-3 overflow-y-auto px-5 py-4 scrollbar-thin">
            {references.length === 0 && <p className="text-[13px] text-muted">Add a database or another service to this environment to reference its variables.</p>}
            {references.map((r) => (
              <div key={r.name} className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-[12px] font-semibold text-fg-2">
                  <Link2 className="size-3" /> {r.name}
                </span>
                <div className="flex flex-wrap gap-1">
                  {r.keys.map((k) => {
                    const ref = referenceOf(r.name, k);
                    return (
                      <span key={k} className="inline-flex items-center rounded-md bg-surface-2 pl-2 font-mono text-[11px] text-muted ring-1 ring-line">
                        {k}
                        <CopyButton value={ref} label={`Copy ${ref}`} className="size-6" />
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <p className="text-[13px] font-semibold text-fg">Shared variables</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            {shared.length ? `${shared.length} shared variable${shared.length === 1 ? "" : "s"} apply to every service in this environment: ${shared.slice(0, 6).join(", ")}${shared.length > 6 ? "…" : ""}.` : "Define variables once for every service in this environment."}{" "}
            <Link href={settingsHref} className="text-accent hover:underline">
              Manage
            </Link>
          </p>
        </Card>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent size="sm">
          <DialogHeader title="Apply the new variables?" description="Variables are read when containers start. Redeploy now to use them." />
          <DialogBody className="py-3"><span /></DialogBody>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => save.run(false)} disabled={save.pending}>
              Save only
            </Button>
            <Button size="sm" variant="primary" onClick={() => save.run(true)} loading={save.pending}>
              Save and redeploy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
