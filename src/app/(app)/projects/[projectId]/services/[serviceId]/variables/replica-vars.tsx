"use client";

import * as React from "react";
import { ChevronDown, Eye, EyeOff, Lock, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardFooter, CardHeader } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useAction } from "@/hooks/use-action";
import { savePreviewVars, saveReplicaVars } from "@/server/actions/services";
import { cn } from "@/lib/utils";

/** `hidden`: the role cannot see secrets; the stored value is kept unless replaced. */
export type ReplicaVar = { key: string; value: string; hidden?: boolean };
/** `from`: the stored name of a hidden value, kept when it is saved unchanged. */
type Row = ReplicaVar & { id: number; from?: string };

let seq = 0;
const withId = (v: ReplicaVar): Row => ({ ...v, id: ++seq, from: v.hidden ? v.key : undefined });

/** Folded state of a card, remembered in this browser. */
export function useCollapsed(storageKey: string, initial = false) {
  const [collapsed, setCollapsed] = React.useState(initial);
  React.useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v !== null) setCollapsed(v === "1");
    } catch {}
  }, [storageKey]);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(storageKey, c ? "0" : "1");
      } catch {}
      return !c;
    });
  return [collapsed, toggle] as const;
}

export function CollapseButton({ collapsed, onClick, label }: { collapsed: boolean; onClick: () => void; label: string }) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={onClick} aria-expanded={!collapsed} aria-label={collapsed ? `Show ${label}` : `Hide ${label}`}>
      <ChevronDown className={cn("transition-transform", collapsed && "-rotate-90")} />
    </Button>
  );
}

/**
 * One card per replica with the variables only that replica gets, e.g. its own bot token or
 * shard. They replace service variables with the same name.
 */
export function ReplicaVars(props: {
  serviceId: string;
  /** Replicas across all servers. */
  replicas: number;
  initial: Record<number, ReplicaVar[]>;
  /** Names of the service's variables, offered to replace. */
  keys: string[];
  canEdit: boolean;
  canSeeSecrets: boolean;
  canRedeploy: boolean;
}) {
  const extra = Object.keys(props.initial)
    .map(Number)
    .filter((n) => n > props.replicas && props.initial[n]?.length);
  const numbers = [...Array.from({ length: props.replicas }, (_, i) => i + 1), ...extra.sort((a, b) => a - b)];

  if (props.replicas < 2 && !Object.values(props.initial).some((v) => v.length))
    return <p className="px-1 text-[12px] text-muted">To give replicas their own variables, like a bot token or shard per replica, set Replicas above 1 in Settings.</p>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5 px-1">
        <h3 className="font-display text-[15px] font-semibold text-fg">Per replica</h3>
        <p className="text-[13px] text-muted">Variables only one replica gets. They replace variables with the same name above.</p>
      </div>
      {numbers.map((n) => (
        <ReplicaCard key={n} {...props} replica={n} unused={n > props.replicas} initial={props.initial[n] ?? []} />
      ))}
    </div>
  );
}

/**
 * Variables pull request previews get instead of the service's: a staging database, test API keys.
 * A preview must never write to the production database.
 */
export function PreviewVars(props: {
  serviceId: string;
  initial: ReplicaVar[];
  keys: string[];
  canEdit: boolean;
  /** The preview database setting fills this variable itself. */
  databaseVariable: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5 px-1">
        <p className="text-[13px] leading-relaxed text-muted">
          Pull request previews get these instead of the Main variables with the same name, like a staging database or test API keys. Everything else comes from Main. Open previews
          get changes at once and use them from their next deploy.
          {props.databaseVariable && ` ${props.databaseVariable} is set by the preview database copy.`}
        </p>
      </div>
      <ReplicaCard {...props} replica={0} unused={false} canRedeploy={false} />
    </div>
  );
}

/** Replica 0 stands for pull request previews. */
function ReplicaCard({
  serviceId,
  replica,
  unused,
  initial,
  keys,
  canEdit,
  canRedeploy,
}: {
  serviceId: string;
  replica: number;
  unused: boolean;
  initial: ReplicaVar[];
  keys: string[];
  canEdit: boolean;
  canRedeploy: boolean;
}) {
  const [rows, setRows] = React.useState<Row[]>(() => initial.map(withId));
  const [saved, setSaved] = React.useState(() => new Map(rows.map((r) => [r.id, r.value])));
  const [baseline, setBaseline] = React.useState(() => JSON.stringify(initial.map((v) => [v.key, v.value])));
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const preview = replica === 0;
  const [folded, toggle] = useCollapsed(`serve:replica-vars:${serviceId}:${replica}`, initial.length === 0);
  // Previews have a tab of their own: nothing to fold there.
  const collapsed = !preview && folded;

  const current = rows.filter((r) => r.key.trim());
  const dirty = JSON.stringify(current.map((r) => [r.key, r.value])) !== baseline || current.length !== rows.filter((r) => r.key || r.value).length;
  const taken = new Set(rows.map((r) => r.key));
  const update = (id: number, patch: Partial<Row>) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = (key = "") => {
    setRows((prev) => [...prev.filter((r) => r.key || r.value), withId({ key, value: "" })]);
    if (collapsed) toggle();
  };

  const save = useAction(
    (redeploy: boolean) => {
      const list = current.map((r) => (r.hidden && r.from ? { key: r.key, value: "", keep: r.from } : { key: r.key, value: r.value }));
      return preview ? savePreviewVars(serviceId, list) : saveReplicaVars(serviceId, replica, list, redeploy);
    },
    {
      onSuccess: () => {
        // A renamed hidden value is now stored under its new name.
        setRows(current.map((r) => (r.hidden ? { ...r, from: r.key } : r)));
        setSaved(new Map(current.map((r) => [r.id, r.value])));
        setBaseline(JSON.stringify(current.map((r) => [r.key, r.value])));
        setRevealed(new Set());
        setConfirmOpen(false);
      },
    },
  );

  const unusedKeys = keys.filter((k) => !taken.has(k));

  return (
    <Card className="overflow-hidden">
      <CardHeader
        className={cn("items-center", collapsed && "border-b-0")}
        title={
          <span className="flex items-center gap-2">
            {preview ? "Preview variables" : `Replica ${replica}`}
            {unused && <Badge tone="warn">Not running</Badge>}
            {collapsed && current.length > 0 && <span className="text-[12px] font-normal text-muted">{current.length === 1 ? "1 variable" : `${current.length} variables`}</span>}
          </span>
        }
        description={collapsed ? undefined : unused ? "No replica has this number now. Its variables apply again when you add replicas." : undefined}
        actions={preview ? undefined : <CollapseButton collapsed={collapsed} onClick={toggle} label={`replica ${replica} variables`} />}
      />
      {!collapsed && (
        <>
          {rows.length > 0 && (
            <div className="divide-y divide-line">
              {rows.map((r) => {
                const editing = saved.get(r.id) !== r.value;
                const shown = editing || revealed.has(r.id);
                const isRef = r.value.includes("${{");
                return (
                  <div key={r.id} className="grid items-center gap-3 px-5 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_32px]">
                    <Input
                      value={r.key}
                      onChange={(e) => update(r.id, { key: e.target.value.replace(/\s/g, "_") })}
                      placeholder="KEY"
                      aria-label="Name"
                      className="font-mono text-[12.5px]"
                      disabled={!canEdit}
                    />
                    <div className="relative">
                      <Input
                        value={r.value}
                        type={shown || isRef ? "text" : "password"}
                        onChange={(e) => update(r.id, { value: e.target.value, hidden: false })}
                        placeholder={r.hidden ? (canEdit ? "Hidden. Type to replace it." : "Hidden") : canEdit ? "value" : ""}
                        aria-label={`Value of ${r.key || "the variable"} for ${preview ? "previews" : `replica ${replica}`}`}
                        className={cn("pr-9 font-mono text-[12.5px]", isRef && "text-accent")}
                        autoComplete="off"
                        disabled={!canEdit}
                      />
                      {!isRef && !editing && !r.hidden && (
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
                    {canEdit ? (
                      <Button variant="ghost" size="icon-sm" onClick={() => setRows((prev) => prev.filter((x) => x.id !== r.id))} aria-label="Remove variable">
                        <Trash2 />
                      </Button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {rows.length === 0 && (
            <p className="px-5 py-4 text-[13px] text-muted">
              {preview
                ? "None yet. Previews use the Main variables, including the production database if one is set there."
                : "No variables of its own. This replica uses the variables above."}
            </p>
          )}
          {canEdit && (
            <div className={cn("flex flex-wrap gap-2 px-5 pb-3", rows.length > 0 && "border-t border-line pt-3")}>
              <Button size="sm" variant="ghost" onClick={() => add()}>
                <Plus /> Add variable
              </Button>
              {unusedKeys.length > 0 && (
                <Menu>
                  <MenuTrigger render={<Button size="sm" variant="ghost" />}>
                    Replace a variable <ChevronDown className="text-muted" />
                  </MenuTrigger>
                  <MenuContent align="start" className="max-h-[min(60vh,26rem)] w-64 overflow-y-auto">
                    <MenuLabel>{preview ? "Give previews their own value" : `Give replica ${replica} its own value`}</MenuLabel>
                    {unusedKeys.map((k) => (
                      <MenuItem key={k} onClick={() => add(k)}>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{k}</span>
                      </MenuItem>
                    ))}
                  </MenuContent>
                </Menu>
              )}
            </div>
          )}
          {canEdit ? (
            dirty && (
              <CardFooter>
                <span className="text-xs text-muted">You have unsaved changes.</span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const next = initial.map(withId);
                      setRows(next);
                      setSaved(new Map(next.map((x) => [x.id, x.value])));
                      setBaseline(JSON.stringify(initial.map((v) => [v.key, v.value])));
                    }}
                  >
                    Discard
                  </Button>
                  <Button size="sm" variant="primary" loading={save.pending} onClick={() => (canRedeploy ? setConfirmOpen(true) : save.run(false))}>
                    Save changes
                  </Button>
                </div>
              </CardFooter>
            )
          ) : (
            <CardFooter>
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <Lock className="size-3.5" /> Read only.
              </span>
            </CardFooter>
          )}
        </>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent size="sm">
          <DialogHeader title={`Apply replica ${replica}'s variables?`} description="Variables are read when containers start. Redeploy now to use them." />
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
    </Card>
  );
}
