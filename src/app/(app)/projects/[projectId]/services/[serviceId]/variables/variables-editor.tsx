"use client";

import * as React from "react";
import { ChevronDown, Code2, Lock, Eye, EyeOff, Plus, Trash2, Link2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardFooter, CardHeader, CopyButton, EmptyState } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Input, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip } from "@/components/ui/tooltip";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useAction } from "@/hooks/use-action";
import { useCan } from "@/components/permissions";
import { saveEnvVars } from "@/server/actions/services";
import { formatEnv, parseEnv } from "@/lib/env";
import { cn } from "@/lib/utils";
import { referenceOf } from "@/lib/refs";
import { Tab, Tabs, TabsList, TabsPanel } from "@/components/ui/tabs";
import { CollapseButton, PreviewVars, type ReplicaVar, ReplicaVars, useCollapsed } from "./replica-vars";

/** `hidden`: the value is kept on the server and not sent here (the role cannot see secrets); `from` is its stored key. */
type Var = { key: string; value: string; buildTime: boolean; runtime: boolean; id?: number; hidden?: boolean; from?: string };

/**
 * A group of values to reference. `addAs` names the variable Add creates (default: the key).
 * `own`: the service's own values, referenced without a service name (${{SERVE_PUBLIC_URL}}).
 */
type Reference = { name: string; keys: string[]; label?: string; note?: string; warn?: boolean; addAs?: Record<string, string>; own?: boolean };

const refOf = (r: Reference, key: string) => (r.own ? `\${{${key}}}` : referenceOf(r.name, key));

let seq = 0;
const withId = (v: Omit<Var, "id">): Var => ({ ...v, id: ++seq });

export function VariablesEditor({
  serviceId,
  type,
  status,
  initial,
  references,
  composeVars = [],
  replicas = 0,
  replicaVars = {},
  canEdit = true,
  canSeeSecrets = true,
  previewVars = null,
  previewDatabaseVariable = null,
  initialTab,
}: {
  serviceId: string;
  type: string;
  status: string;
  initial: Omit<Var, "id">[];
  references: Reference[];
  /** ${VARIABLES} the compose file uses without a default. */
  composeVars?: string[];
  /** Replicas across all servers; 0 when the service has none (compose, databases). */
  replicas?: number;
  replicaVars?: Record<number, ReplicaVar[]>;
  canEdit?: boolean;
  /** Without it, values arrive hidden and saving keeps them unless replaced. */
  canSeeSecrets?: boolean;
  /** Variables of pull request previews; null when the service has no previews. */
  previewVars?: ReplicaVar[] | null;
  previewDatabaseVariable?: string | null;
  initialTab?: "main" | "previews";
}) {
  const [vars, setVars] = React.useState<Var[]>(() => initial.map(withId));
  // Rows as last saved: their values are masked until revealed. New and edited values stay readable while typing.
  const [savedValues, setSavedValues] = React.useState(() => new Map(vars.map((v) => [v.id!, v.value])));
  const [raw, setRaw] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<"main" | "previews">(initialTab ?? "main");
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed(`serve:vars-collapsed:${serviceId}`);
  const baselineOf = (rows: Omit<Var, "id">[]) =>
    JSON.stringify(
      rows.filter((v) => v.key).map((v) => ({ key: v.key, value: v.value, buildTime: v.buildTime, runtime: v.runtime, ...(v.hidden ? { keep: v.from ?? v.key } : {}) })),
    );
  const [baseline, setBaseline] = React.useState(() => baselineOf(initial));

  const current =
    raw !== null
      ? parseEnv(raw).map((v) => ({ ...v, buildTime: vars.find((x) => x.key === v.key)?.buildTime ?? true, runtime: vars.find((x) => x.key === v.key)?.runtime ?? true }))
      : vars.map((v) => ({ key: v.key, value: v.value, buildTime: v.buildTime, runtime: v.runtime, ...(v.hidden ? { keep: v.from ?? v.key } : {}) }));
  const dirty = JSON.stringify(current.filter((v) => v.key)) !== baseline;

  const save = useAction((redeploy: boolean) => saveEnvVars(serviceId, current, redeploy), {
    onSuccess: () => {
      // A renamed hidden value is now stored under its new name.
      setBaseline(JSON.stringify(current.filter((v) => v.key).map((v) => ("keep" in v ? { ...v, keep: v.key } : v))));
      const saved = raw !== null ? current.map(withId) : vars.map((v) => (v.hidden ? { ...v, from: v.key } : v));
      if (raw === null) setVars(saved);
      if (raw !== null) {
        setVars(saved);
        setRaw(null);
      }
      setSavedValues(new Map(saved.map((v) => [v.id!, v.value])));
      setRevealed(new Set());
      setConfirmOpen(false);
    },
  });

  const addVar = (key: string, value: string) => {
    if (raw !== null) setRaw(`${raw.replace(/\n*$/, "")}\n${key}=${value}\n`);
    else setVars((prev) => [...prev.filter((v) => v.key || v.value), withId({ key, value, buildTime: true, runtime: true })]);
  };
  const taken = new Set(current.map((v) => v.key));
  const update = (id: number, patch: Partial<Var>) => setVars((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  const hasBuild = type === "app";
  const can = useCan();
  // Saving with a redeploy needs deploy rights; without them the save alone still works.
  const canRedeploy = status !== "idle" && can("services.deploy");
  const missing = composeVars.filter((name) => !current.some((v) => v.key === name));

  return (
    <Tabs value={previewVars ? tab : "main"} onValueChange={(v) => setTab(v as "main" | "previews")} className="flex flex-col gap-4">
      {previewVars && (
        <TabsList>
          <Tab value="main">Main</Tab>
          <Tab value="previews">
            Previews
            {previewVars.length > 0 && <span className="text-[11px] text-faint tabular-nums">{previewVars.length}</span>}
          </Tab>
        </TabsList>
      )}
      {/* Both panels stay mounted, so unsaved edits survive switching tabs. */}
      <TabsPanel value="main" keepMounted className="data-[hidden]:hidden">
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-w-0 flex-col gap-4">
            {missing.length > 0 && (
              <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn/30 bg-warn-soft px-4 py-3 text-[13px]">
                <TriangleAlert className="size-4 flex-none text-warn" />
                <p className="min-w-0 flex-1 text-fg-2">
                  The compose file uses {missing.length === 1 ? "a variable that is" : "variables that are"} not set:{" "}
                  <span className="font-mono text-fg">{missing.join(", ")}</span>. Deploys stop until {missing.length === 1 ? "it is" : "they are"} added.
                </p>
                <Button
                  size="sm"
                  onClick={() => {
                    setRaw(null);
                    setVars((prev) => [...prev, ...missing.map((key) => withId({ key, value: "", buildTime: true, runtime: true }))]);
                  }}
                >
                  <Plus /> Add {missing.length === 1 ? "it" : "all"}
                </Button>
              </div>
            )}
            <Card className="overflow-hidden">
              <CardHeader
                className={cn(collapsed && "items-center border-b-0")}
                title={
                  <span className="flex items-center gap-2">
                    Environment variables {!canEdit && <Badge>Read only</Badge>}
                    {collapsed && <span className="text-[12px] font-normal text-muted">{current.filter((v) => v.key).length} variables</span>}
                  </span>
                }
                description={collapsed ? undefined : "Encrypted at rest. Changes apply on the next deploy."}
                actions={
                  <>
                    {!collapsed && canSeeSecrets && canEdit && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (raw === null) setRaw(formatEnv(vars));
                          else {
                            setVars(
                              parseEnv(raw).map((v) => {
                                const was = vars.find((x) => x.key === v.key);
                                return withId({ ...v, buildTime: was?.buildTime ?? true, runtime: was?.runtime ?? true });
                              }),
                            );
                            setRaw(null);
                          }
                        }}
                      >
                        <Code2 /> {raw === null ? "Raw editor" : "Table view"}
                      </Button>
                    )}
                    <CollapseButton collapsed={collapsed} onClick={toggleCollapsed} label="environment variables" />
                  </>
                }
              />
              {collapsed ? null : raw !== null ? (
                <div className="p-4">
                  <Textarea
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                    rows={Math.max(10, raw.split("\n").length + 2)}
                    className="font-mono text-[12.5px] leading-relaxed"
                    spellCheck={false}
                    placeholder="KEY=value"
                  />
                </div>
              ) : vars.length === 0 ? (
                <EmptyState
                  title="No variables yet"
                  description={canEdit ? "Add variables, paste a .env file in the raw editor, or reference another service." : "This service has no variables."}
                  action={
                    canEdit && (
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button size="sm" onClick={() => setVars([withId({ key: "", value: "", buildTime: true, runtime: true })])}>
                          <Plus /> Add variable
                        </Button>
                        <AddReferenceMenu references={references} taken={taken} onAdd={addVar} />
                      </div>
                    )
                  }
                />
              ) : (
                <div className="divide-y divide-line">
                  <div
                    className={cn(
                      "hidden gap-3 px-5 py-2 text-[11px] font-semibold text-faint sm:grid",
                      hasBuild ? "grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_120px_32px]" : "grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_32px]",
                    )}
                  >
                    <span>Name</span>
                    <span>Value</span>
                    {hasBuild && <span>Available at</span>}
                    <span />
                  </div>
                  {vars.map((v) => {
                    const editing = savedValues.get(v.id!) !== v.value;
                    const shown = editing || revealed.has(v.id!);
                    const isRef = v.value.includes("${{");
                    return (
                      <div
                        key={v.id}
                        className={cn(
                          "grid items-center gap-3 px-5 py-2.5",
                          hasBuild ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_120px_32px]" : "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_32px]",
                        )}
                      >
                        <Input
                          value={v.key}
                          onChange={(e) => update(v.id!, { key: e.target.value.replace(/\s/g, "_") })}
                          placeholder="KEY"
                          className="font-mono text-[12.5px]"
                          disabled={!canEdit}
                        />
                        <div className="relative">
                          <Input
                            value={v.value}
                            type={shown || isRef ? "text" : "password"}
                            onChange={(e) => update(v.id!, { value: e.target.value, hidden: false })}
                            placeholder={v.hidden ? (canEdit ? "Hidden. Type to replace it." : "Hidden") : canEdit ? "value" : ""}
                            className={cn("pr-9 font-mono text-[12.5px]", isRef && "text-accent")}
                            autoComplete="off"
                            disabled={!canEdit}
                            title={v.hidden ? "Your role cannot see secret values." : undefined}
                          />
                          {!isRef && !editing && !v.hidden && (canSeeSecrets || !v.from) && (
                            <button
                              type="button"
                              onClick={() =>
                                setRevealed((s) => {
                                  const n = new Set(s);
                                  if (n.has(v.id!)) n.delete(v.id!);
                                  else n.add(v.id!);
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
                        {hasBuild && (
                          <div className="flex items-center gap-3 text-xs text-muted">
                            <Tooltip content="Available while the app runs">
                              <label className="flex items-center gap-1.5">
                                <Checkbox checked={v.runtime} onCheckedChange={(c) => update(v.id!, { runtime: !!c })} disabled={!canEdit} /> Run
                              </label>
                            </Tooltip>
                            <Tooltip content="Passed as a build argument">
                              <label className="flex items-center gap-1.5">
                                <Checkbox checked={v.buildTime} onCheckedChange={(c) => update(v.id!, { buildTime: !!c })} disabled={!canEdit} /> Build
                              </label>
                            </Tooltip>
                          </div>
                        )}
                        {canEdit ? (
                          <Button variant="ghost" size="icon-sm" onClick={() => setVars((prev) => prev.filter((x) => x.id !== v.id))} aria-label="Remove variable">
                            <Trash2 />
                          </Button>
                        ) : (
                          <span />
                        )}
                      </div>
                    );
                  })}
                  {canEdit && (
                    <div className="flex flex-wrap gap-2 px-5 py-3">
                      <Button size="sm" variant="ghost" onClick={() => setVars((prev) => [...prev, withId({ key: "", value: "", buildTime: true, runtime: true })])}>
                        <Plus /> Add variable
                      </Button>
                      <AddReferenceMenu references={references} taken={taken} onAdd={addVar} variant="ghost" />
                    </div>
                  )}
                </div>
              )}
              {collapsed && !dirty ? null : canEdit ? (
                <CardFooter className={cn("transition-opacity", !dirty && "opacity-60")}>
                  <span className="text-xs text-muted">
                    {dirty ? "You have unsaved changes." : `${current.filter((v) => v.key).length} variables${canSeeSecrets ? "" : " · values hidden for your role"}`}
                  </span>
                  <div className="flex gap-2">
                    {dirty && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const rows = initial.map(withId);
                          setVars(rows);
                          // The page may hold newer values than the last save (someone else saved since).
                          setBaseline(baselineOf(initial));
                          setSavedValues(new Map(rows.map((v) => [v.id!, v.value])));
                          setRaw(null);
                        }}
                      >
                        Discard
                      </Button>
                    )}
                    <Button size="sm" variant="primary" disabled={!dirty || !canEdit} loading={save.pending} onClick={() => (canRedeploy ? setConfirmOpen(true) : save.run(false))}>
                      Save changes
                    </Button>
                  </div>
                </CardFooter>
              ) : (
                <CardFooter>
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <Lock className="size-3.5" /> Read only. Your role can see these variables but not change them.
                  </span>
                </CardFooter>
              )}
            </Card>
            {replicas > 0 && (
              <ReplicaVars
                serviceId={serviceId}
                replicas={replicas}
                initial={replicaVars}
                keys={current.filter((v) => v.key && v.runtime).map((v) => v.key)}
                canEdit={canEdit}
                canSeeSecrets={canSeeSecrets}
                canRedeploy={canRedeploy}
              />
            )}
          </div>

          <div className="flex flex-col gap-4">
            <ReferencesCard references={references} canEdit={canEdit} taken={taken} onAdd={addVar} />
          </div>
        </div>
      </TabsPanel>
      {previewVars && (
        <TabsPanel value="previews" keepMounted className="max-w-3xl data-[hidden]:hidden">
          <PreviewVars
            serviceId={serviceId}
            initial={previewVars}
            keys={current.filter((v) => v.key).map((v) => v.key)}
            canEdit={canEdit}
            databaseVariable={previewDatabaseVariable}
          />
        </TabsPanel>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent size="sm">
          <DialogHeader title="Apply the new variables?" description="Variables are read when containers start. Redeploy now to use them." />
          <DialogBody className="py-3">
            <span />
          </DialogBody>
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
    </Tabs>
  );
}

/** Values of other services to reference: one folding group per service, each value with Add and Copy. */
function ReferencesCard({ references, canEdit, taken, onAdd }: { references: Reference[]; canEdit: boolean; taken: Set<string>; onAdd: (key: string, value: string) => void }) {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(references[0] ? [references[0].name] : []));
  const q = query.trim().toLowerCase();
  const groups = references
    .map((r) => ({ ...r, title: r.label ?? r.name, keys: q && !(r.label ?? r.name).toLowerCase().includes(q) ? r.keys.filter((k) => k.toLowerCase().includes(q)) : r.keys }))
    .filter((r) => r.keys.length);
  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <Card>
      <CardHeader
        title="References"
        description="Nothing is added by itself. Add a value and it becomes KEY=${{source.KEY}}, always up to date. Remove the variable to stop using it."
      />
      {references.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-muted">Add a database or another service to this environment, or add shared variables, to reference their values.</p>
      ) : (
        <>
          {references.length > 3 && (
            <div className="border-b border-line px-4 py-2.5">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter services and values" className="h-8 text-[13px]" aria-label="Filter references" />
            </div>
          )}
          <div className="max-h-[28rem] divide-y divide-line overflow-y-auto scrollbar-thin">
            {groups.length === 0 && <p className="px-5 py-4 text-[13px] text-muted">Nothing matches.</p>}
            {groups.map((r) => {
              const expanded = !!q || open.has(r.name);
              return (
                <div key={r.name}>
                  <button
                    type="button"
                    onClick={() => toggle(r.name)}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-hover"
                  >
                    <span className="flex size-6 flex-none items-center justify-center rounded-md bg-fg/[0.05] text-muted">
                      <Link2 className="size-3.5" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] font-medium text-fg">{r.title}</span>
                      {r.note && <span className={cn("truncate text-[11px]", r.warn ? "text-warn" : "text-faint")}>{r.note}</span>}
                    </span>
                    <span className="flex-none text-xs text-faint tabular-nums">{r.keys.length}</span>
                    <ChevronDown className={cn("size-3.5 flex-none text-faint transition-transform", expanded && "rotate-180")} />
                  </button>
                  {expanded && (
                    <ul className="pb-2">
                      {r.keys.map((k) => {
                        const ref = refOf(r, k);
                        const name = r.addAs?.[k] ?? k;
                        const added = taken.has(name);
                        return (
                          <li key={k} className="group flex items-center gap-1 py-0.5 pr-2 pl-12">
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2" title={ref}>
                              {k}
                            </span>
                            {canEdit && (
                              <Tooltip content={added ? `${name} is already a variable` : `Add ${name}=${ref}`}>
                                <Button type="button" size="xs" variant="ghost" disabled={added} onClick={() => onAdd(name, ref)} className="opacity-70 group-hover:opacity-100">
                                  <Plus /> {added ? "Added" : "Add"}
                                </Button>
                              </Tooltip>
                            )}
                            <CopyButton value={ref} label={`Copy ${ref}`} className="size-7" />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

/** One click to add a reference: every value of other services and shared variables, grouped. */
function AddReferenceMenu({
  references,
  taken,
  onAdd,
  variant = "secondary",
}: {
  references: Reference[];
  taken: Set<string>;
  onAdd: (key: string, value: string) => void;
  variant?: "secondary" | "ghost";
}) {
  if (!references.length) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant={variant} />}>
        <Link2 /> Add reference <ChevronDown className="text-muted" />
      </MenuTrigger>
      <MenuContent align="start" className="max-h-[min(60vh,26rem)] w-72 overflow-y-auto">
        {references.map((r, i) => (
          <React.Fragment key={r.name}>
            {i > 0 && <MenuSeparator />}
            <MenuLabel>{r.label ?? r.name}</MenuLabel>
            {r.keys.map((k) => (
              <MenuItem key={k} disabled={taken.has(r.addAs?.[k] ?? k)} onClick={() => onAdd(r.addAs?.[k] ?? k, refOf(r, k))}>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{k}</span>
                {taken.has(r.addAs?.[k] ?? k) && <span className="text-[11px] text-faint">Added</span>}
              </MenuItem>
            ))}
          </React.Fragment>
        ))}
      </MenuContent>
    </Menu>
  );
}
