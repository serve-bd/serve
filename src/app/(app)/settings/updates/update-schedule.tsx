"use client";

import * as React from "react";
import { CronExpressionParser } from "cron-parser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { useNow } from "@/hooks/use-client";
import { saveUpdateSettings } from "@/server/actions/instance";

export type UpdateScheduleSettings = { checkEnabled: boolean; checkSchedule: string; autoUpdate: boolean; autoSchedule: string; timezone: string };

const CHECK_PRESETS = [
  { value: "0 * * * *", label: "Every hour" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "0 0 * * *", label: "Every day" },
  { value: "0 0 * * 0", label: "Every week" },
];
const UPDATE_PRESETS = [
  { value: "0 3 * * *", label: "Every day at 03:00" },
  { value: "0 3 * * 0", label: "Every Sunday at 03:00" },
  { value: "0 3 * * 1-5", label: "Weekdays at 03:00" },
];

/** When a cron expression fires next, or null when it is not valid. */
function nextRun(cron: string, tz: string, now: number) {
  try {
    if (cron.trim().split(/\s+/).length !== 5) return null;
    return CronExpressionParser.parse(cron, { currentDate: new Date(now), tz })
      .next()
      .toDate();
  } catch {
    return null;
  }
}

/** A preset, or a cron expression of your own. */
function SchedulePicker({
  label,
  value,
  onChange,
  presets,
  timezone,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  presets: { value: string; label: string }[];
  timezone: string;
  disabled?: boolean;
}) {
  const preset = presets.some((p) => p.value === value);
  const [custom, setCustom] = React.useState(!preset);
  const now = useNow();
  const next = now === null ? undefined : nextRun(value, timezone, now);
  return (
    <div className="flex flex-col gap-2 pl-0 sm:pl-1">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          aria-label={label}
          size="sm"
          disabled={disabled}
          className="sm:w-56"
          value={custom ? "custom" : value}
          onValueChange={(v) => {
            if (v === "custom") return setCustom(true);
            setCustom(false);
            onChange(v);
          }}
          options={[...presets, { value: "custom", label: "Custom cron…" }]}
        />
        {custom && (
          <Input
            aria-label={`${label} as a cron expression`}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            placeholder="0 3 * * *"
            spellCheck={false}
            className="h-8 font-mono text-[13px] sm:w-44"
          />
        )}
      </div>
      <p className={next === null ? "text-xs text-bad" : "text-xs text-muted"}>
        {next === null
          ? "Not a valid cron expression. Use five fields: minute, hour, day of month, month, day of week."
          : next
            ? `Next: ${next.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone })} (${timezone})`
            : ""}
      </p>
    </div>
  );
}

/** How often to look for releases, and whether to install them on a schedule. */
export function UpdateSchedule({ initial, canAutoUpdate }: { initial: UpdateScheduleSettings; canAutoUpdate: boolean }) {
  const [s, setS] = React.useState(initial);
  const set = (patch: Partial<UpdateScheduleSettings>) => setS((x) => ({ ...x, ...patch }));
  const changed = JSON.stringify(s) !== JSON.stringify(initial);
  const valid = !!nextRun(s.checkSchedule, s.timezone, Date.now()) && !!nextRun(s.autoSchedule, s.timezone, Date.now());
  const save = useAction(() => saveUpdateSettings({ checkEnabled: s.checkEnabled, checkSchedule: s.checkSchedule, autoUpdate: s.autoUpdate, autoSchedule: s.autoSchedule }), {
    success: "Update settings saved",
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <SwitchRow
          title="Check for updates"
          description="Asks GitHub for the newest release. Nothing about this instance is sent."
          checked={s.checkEnabled}
          onCheckedChange={(c) => set({ checkEnabled: c })}
        />
        {s.checkEnabled && (
          <SchedulePicker label="Check schedule" value={s.checkSchedule} onChange={(v) => set({ checkSchedule: v })} presets={CHECK_PRESETS} timezone={s.timezone} />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <SwitchRow
          title="Install updates automatically"
          description={
            canAutoUpdate
              ? "At the time you pick, a new release is installed the same way as Update now: a backup first, and a roll back if it does not start."
              : "Not here: this copy runs from source code (pnpm), so it cannot replace itself. Servers installed with install.sh can."
          }
          checked={s.autoUpdate}
          disabled={!canAutoUpdate}
          onCheckedChange={(c) => set({ autoUpdate: c })}
        />
        {s.autoUpdate && (
          <SchedulePicker label="Update schedule" value={s.autoSchedule} onChange={(v) => set({ autoSchedule: v })} presets={UPDATE_PRESETS} timezone={s.timezone} />
        )}
      </div>
      {changed && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setS(initial)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!valid} loading={save.pending} onClick={() => save.run()}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
