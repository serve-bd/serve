"use client";

import * as React from "react";
import { Plus, Snowflake, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { TimeInput } from "@/components/ui/time-input";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { type DeployRules, type FreezeWindow, freezeState, freezeUntil, WEEKDAYS } from "@/lib/deploy-rules";
import { saveDeployRules } from "@/server/actions/deploy-rules";
import { Section } from "../../services/[serviceId]/settings/section";

type Env = { id: string; name: string };

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** Which environments a rule covers: every one, or the ticked ones. */
function EnvironmentsField({ envs, value, onChange, disabled }: { envs: Env[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const all = !value.length;
  return (
    <Field label="Environments">
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2.5 text-[13px] text-fg-2">
          <Checkbox checked={all} onCheckedChange={(c) => onChange(c ? [] : envs.slice(0, 1).map((e) => e.id))} disabled={disabled} />
          Every environment
        </label>
        {!all && (
          <div className="flex flex-wrap gap-x-5 gap-y-2 pl-6">
            {envs.map((e) => (
              <label key={e.id} className="flex items-center gap-2.5 text-[13px] text-fg-2">
                <Checkbox
                  checked={value.includes(e.id)}
                  onCheckedChange={(c) => {
                    const next = c ? [...value, e.id] : value.filter((id) => id !== e.id);
                    // None ticked would read as every one: keep at least the last.
                    if (next.length) onChange(next);
                  }}
                  disabled={disabled}
                />
                {e.name}
              </label>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}

function DaysPicker({ value, onChange, disabled }: { value: number[]; onChange: (days: number[]) => void; disabled?: boolean }) {
  // Monday first, the way a work week reads.
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="flex flex-wrap gap-1">
      {order.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => (on ? value.length > 1 && onChange(value.filter((x) => x !== d)) : onChange([...value, d].sort()))}
            className={cn(
              "h-8 w-11 rounded-lg border text-xs font-medium transition-colors",
              on ? "border-accent bg-accent/10 text-fg" : "border-line text-muted hover:text-fg",
              disabled && "opacity-50",
            )}
          >
            {WEEKDAYS[d]}
          </button>
        );
      })}
    </div>
  );
}

const durations = [
  { value: "off", label: "Until I turn it off" },
  { value: "1", label: "For 1 hour" },
  { value: "4", label: "For 4 hours" },
  { value: "24", label: "For 24 hours" },
  { value: "72", label: "For 3 days" },
  { value: "168", label: "For 1 week" },
];

export function DeployRulesSettings({ projectId, rules, envs, canManage }: { projectId: string; rules: DeployRules | null; envs: Env[]; canManage: boolean }) {
  const save = useAction(saveDeployRules);
  const approval = { enabled: rules?.approval?.enabled ?? false, environmentIds: rules?.approval?.environmentIds ?? [] };
  const freeze = rules?.freeze;
  const timezone = freeze?.timezone || browserZone();
  // The other card's saved part goes along, so each card saves only its own changes.
  const savedFreeze = {
    now: freeze?.now ? { until: freeze.now.until ?? null, reason: freeze.now.reason ?? null } : null,
    windows: freeze?.windows ?? [],
    timezone,
    environmentIds: freeze?.environmentIds ?? [],
  };
  const zones = React.useMemo(() => {
    let list: string[] = [];
    try {
      list = Intl.supportedValuesOf("timeZone");
    } catch {}
    if (!list.includes("UTC")) list = ["UTC", ...list];
    return list.map((z) => ({ value: z, label: z.replace(/_/g, " ") }));
  }, []);
  const state = envs.map((e) => ({ env: e, freeze: freezeState(rules, e.id) }));
  const frozen = state.filter((s) => s.freeze.frozen);

  return (
    <>
      <Section
        title="Approvals"
        description="Deploys wait until someone who can approve deploys lets them go."
        initial={approval}
        onSave={(v) => save.run(projectId, { approval: v, freeze: savedFreeze })}
      >
        {(v, set) => (
          <>
            <SwitchRow
              title="Deploys wait for approval"
              description="Pushes, hooks, API calls and manual deploys. People who can approve deploys start their own right away."
              checked={v.enabled}
              onCheckedChange={(enabled) => set({ enabled })}
              disabled={!canManage}
            />
            {v.enabled && <EnvironmentsField envs={envs} value={v.environmentIds} onChange={(environmentIds) => set({ environmentIds })} disabled={!canManage} />}
            <p className="text-xs leading-relaxed text-muted">
              Owners and admins can approve. Give other roles the Approve deploys permission in the organization&apos;s roles. Rollbacks, a new service&apos;s first deploy,
              databases and pull request previews never wait.
            </p>
          </>
        )}
      </Section>

      <Section
        title="Deploy freeze"
        description="No deploys while it is on, or during set hours every week."
        initial={{
          now: !!savedFreeze.now,
          duration: savedFreeze.now?.until ? "keep" : "off",
          reason: savedFreeze.now?.reason ?? "",
          windows: savedFreeze.windows,
          timezone: savedFreeze.timezone,
          environmentIds: savedFreeze.environmentIds,
        }}
        onSave={(v) => {
          const until =
            !v.now || v.duration === "off" ? null : v.duration === "keep" ? (savedFreeze.now?.until ?? null) : new Date(Date.now() + Number(v.duration) * 3_600_000).toISOString();
          return save.run(projectId, {
            approval,
            freeze: { now: v.now ? { until, reason: v.reason.trim() || null } : null, windows: v.windows, timezone: v.timezone, environmentIds: v.environmentIds },
          });
        }}
      >
        {(v, set) => (
          <>
            {frozen.length > 0 && (
              <p className="flex items-start gap-2 rounded-xl bg-info/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-2">
                <Snowflake className="mt-0.5 size-3.5 flex-none text-info" />
                <span>
                  {frozen.length === envs.length ? "Deploys are frozen" : `Deploys to ${frozen.map((s) => s.env.name).join(", ")} are frozen`}{" "}
                  {frozen[0].freeze.frozen ? freezeUntil(frozen[0].freeze, timezone) : ""}.
                </span>
              </p>
            )}
            <SwitchRow
              title="Freeze deploys now"
              description="Pushes and hooks are skipped and noted in the deployments list. Manual deploys are refused."
              checked={v.now}
              onCheckedChange={(now) => set({ now })}
              disabled={!canManage}
            />
            {v.now && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="How long">
                  <Select
                    value={v.duration}
                    onValueChange={(duration) => set({ duration })}
                    disabled={!canManage}
                    options={[
                      ...(savedFreeze.now?.until
                        ? [{ value: "keep", label: `Until ${new Date(savedFreeze.now.until).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` }]
                        : []),
                      ...durations,
                    ]}
                  />
                </Field>
                <Field label="Reason" optional>
                  <Input value={v.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="Sale weekend" disabled={!canManage} maxLength={200} />
                </Field>
              </div>
            )}

            <Field label="Every week" description={v.windows.length ? undefined : "Add the hours deploys stop every week, like Friday evening to Monday morning."}>
              <div className="flex flex-col gap-3">
                {v.windows.map((w, i) => {
                  const change = (patch: Partial<FreezeWindow>) => set({ windows: v.windows.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
                      <DaysPicker value={w.days} onChange={(days) => change({ days })} disabled={!canManage} />
                      <div className="flex items-center gap-2">
                        <TimeInput value={w.start} onChange={(start) => change({ start })} disabled={!canManage} />
                        <span className="text-xs text-muted">to</span>
                        <TimeInput value={w.end} onChange={(end) => change({ end })} disabled={!canManage} />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        aria-label="Remove"
                        disabled={!canManage}
                        onClick={() => set({ windows: v.windows.filter((_, j) => j !== i) })}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  );
                })}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  disabled={!canManage || v.windows.length >= 20}
                  onClick={() => set({ windows: [...v.windows, { days: [5], start: "18:00", end: "09:00" }] })}
                >
                  <Plus /> Add hours
                </Button>
              </div>
            </Field>
            {v.windows.length > 0 && <p className="text-xs leading-relaxed text-muted">An end before the start runs past midnight: Friday 18:00 to 09:00 ends Saturday morning.</p>}
            {(v.windows.length > 0 || v.now) && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {v.windows.length > 0 && (
                  <Field label="Time zone">
                    <Combobox value={v.timezone} onValueChange={(tz) => set({ timezone: tz })} options={zones} placeholder="Search time zones…" disabled={!canManage} />
                  </Field>
                )}
              </div>
            )}
            {(v.windows.length > 0 || v.now) && (
              <EnvironmentsField envs={envs} value={v.environmentIds} onChange={(environmentIds) => set({ environmentIds })} disabled={!canManage} />
            )}
            <p className="text-xs leading-relaxed text-muted">Rollbacks, a new service&apos;s first deploy, databases and pull request previews are not frozen.</p>
          </>
        )}
      </Section>
    </>
  );
}
