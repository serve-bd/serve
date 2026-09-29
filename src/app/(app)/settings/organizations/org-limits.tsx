"use client";

import * as React from "react";
import { Building2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui/misc";
import { SwitchRow } from "@/components/ui/switch";
import { UsageBars } from "@/components/usage-bars";
import { useAction } from "@/hooks/use-action";
import { DEFAULT_RESERVATION, formatLimitValue, hasAnyLimit, limitCatalog, type OrgLimits, type Usage, usageLevel } from "@/lib/limits";
import { cn } from "@/lib/utils";
import { saveDefaultOrgLimits, saveOrgLimits } from "@/server/actions/limits";

type Org = { id: string; name: string; members: number; root: boolean; custom: boolean; limits: OrgLimits; usage: Usage };
type Server = { id: string; name: string };

export function OrgLimitsView({ orgs, defaults, servers }: { orgs: Org[]; defaults: OrgLimits; servers: Server[] }) {
  const [editing, setEditing] = React.useState<Org | "defaults" | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Default limits"
          description="For every organization without its own limits. The Root organization stays unlimited unless you set limits for it."
          actions={
            <Button size="sm" onClick={() => setEditing("defaults")}>
              <Pencil /> Edit
            </Button>
          }
        />
        <CardBody className="py-4">
          <LimitSummary limits={defaults} empty="No limits: new organizations can use as much as they need." />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Organizations" description="Usage and limits of each organization on this instance." />
        <div className="divide-y divide-line">
          {orgs.map((o) => {
            const hot = limitCatalog.filter((l) => l.key !== "concurrentBuilds" && usageLevel(o.usage[l.key] ?? 0, o.limits[l.key]) !== "ok");
            return (
              <div key={o.id} className="flex flex-col gap-3 px-5 py-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-fg/[0.05] text-muted">
                    <Building2 className="size-4" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-fg">
                      {o.name}
                      {o.root && <Badge tone="info">Root</Badge>}
                      {o.custom ? <Badge>Own limits</Badge> : !o.root && hasAnyLimit(o.limits) ? <Badge>Default limits</Badge> : null}
                    </span>
                    <span className="text-xs text-muted">
                      {o.members} member{o.members === 1 ? "" : "s"} · {o.usage.projects ?? 0} project{o.usage.projects === 1 ? "" : "s"} · {o.usage.services ?? 0} service
                      {o.usage.services === 1 ? "" : "s"}
                      {hot.length > 0 && (
                        <span className={cn(hot.some((l) => usageLevel(o.usage[l.key] ?? 0, o.limits[l.key]) === "full") ? "text-bad" : "text-warn")}>
                          {" "}
                          · near or at the limit: {hot.map((l) => l.label.toLowerCase()).join(", ")}
                        </span>
                      )}
                    </span>
                  </div>
                  <Button size="sm" onClick={() => setEditing(o)}>
                    <Pencil /> Limits
                  </Button>
                </div>
                {hasAnyLimit(o.limits) && (
                  <div className="pl-11">
                    <UsageBars usage={o.usage} limits={o.limits} only={limitCatalog.filter((l) => o.limits[l.key] != null).map((l) => l.key)} compact />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {editing && (
        <LimitsDialog
          key={editing === "defaults" ? "defaults" : editing.id}
          org={editing === "defaults" ? null : editing}
          initial={editing === "defaults" ? defaults : editing.limits}
          servers={servers}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function LimitSummary({ limits, empty }: { limits: OrgLimits; empty: string }) {
  const set = limitCatalog.filter((l) => limits[l.key] != null);
  if (!set.length && !limits.allowedServers) return <p className="text-[13px] text-muted">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {set.map((l) => (
        <Badge key={l.key}>
          {l.label}: {formatLimitValue(l.key, limits[l.key] ?? 0)}
        </Badge>
      ))}
      {limits.allowedServers && <Badge>{limits.allowedServers.length} allowed servers</Badge>}
    </div>
  );
}

const toDraft = (l: OrgLimits): Record<string, string> => ({
  ...Object.fromEntries(limitCatalog.map(({ key }) => [key, l[key] != null ? String(l[key]) : ""])),
  defaultCpu: l.defaultCpu != null ? String(l.defaultCpu) : "",
  defaultMemory: l.defaultMemory != null ? String(l.defaultMemory) : "",
});

function LimitsDialog({ org, initial, servers, onClose }: { org: Org | null; initial: OrgLimits; servers: Server[]; onClose: () => void }) {
  const [draft, setDraft] = React.useState(toDraft(initial));
  const [useDefaults, setUseDefaults] = React.useState(org ? !org.custom && !org.root : false);
  const [allowed, setAllowed] = React.useState<string[] | null>(initial.allowedServers ?? null);
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const limits: OrgLimits = {
    ...Object.fromEntries(limitCatalog.map(({ key }) => [key, num(draft[key])])),
    defaultCpu: num(draft.defaultCpu),
    defaultMemory: num(draft.defaultMemory),
    allowedServers: allowed,
  };
  const invalid = Object.entries(draft).some(([, v]) => v.trim() !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0));
  const save = useAction(() => (org ? saveOrgLimits(org.id, useDefaults ? null : limits) : saveDefaultOrgLimits(limits)), {
    success: "Limits saved",
    onSuccess: onClose,
  });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [k]: e.target.value.replace(/[^\d.]/g, "") }));
  const locked = !!org && useDefaults;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader
          title={org ? `Limits for ${org.name}` : "Default limits"}
          description="Leave a field empty for no limit. Limits apply to new projects, services, domains, deploys and backups; nothing that exists is removed."
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
        >
          <DialogBody className="max-h-[62vh] gap-5 overflow-y-auto [&>*]:shrink-0">
            {org && !org.root && (
              <SwitchRow title="Use the default limits" description="Follow the instance defaults, and change with them." checked={useDefaults} onCheckedChange={setUseDefaults} />
            )}
            <fieldset disabled={locked} className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2", locked && "opacity-50")}>
              {limitCatalog.map((l) => (
                <Field key={l.key} label={l.label} description={l.description}>
                  <InputGroup suffix={l.unit}>
                    <Input value={draft[l.key]} onChange={set(l.key)} inputMode="decimal" placeholder="No limit" className="tabular-nums" aria-label={l.label} />
                  </InputGroup>
                </Field>
              ))}
            </fieldset>
            {(limits.cpu != null || limits.memory != null) && !locked && (
              <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4">
                <p className="text-[13px] leading-relaxed text-fg-2">
                  New services without their own limits get these, so the totals stay honest. Existing services without limits count as the same.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="CPU per service">
                    <InputGroup suffix="cores">
                      <Input value={draft.defaultCpu} onChange={set("defaultCpu")} inputMode="decimal" placeholder={String(DEFAULT_RESERVATION.cpu)} />
                    </InputGroup>
                  </Field>
                  <Field label="Memory per service">
                    <InputGroup suffix="MB">
                      <Input value={draft.defaultMemory} onChange={set("defaultMemory")} inputMode="numeric" placeholder={String(DEFAULT_RESERVATION.memory)} />
                    </InputGroup>
                  </Field>
                </div>
              </div>
            )}
            {!locked && servers.length > 1 && (
              <div className="flex flex-col gap-2">
                <SwitchRow
                  title="Only some servers"
                  description="Choose the servers this organization may deploy to."
                  checked={allowed !== null}
                  onCheckedChange={(on) => setAllowed(on ? servers.map((s) => s.id) : null)}
                />
                {allowed !== null && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {servers.map((s) => (
                      <label key={s.id} className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-[13px] text-fg-2">
                        <Checkbox checked={allowed.includes(s.id)} onCheckedChange={(c) => setAllowed((a) => (c ? [...(a ?? []), s.id] : (a ?? []).filter((x) => x !== s.id)))} />
                        {s.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={save.pending} disabled={invalid}>
              Save limits
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
