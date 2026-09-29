"use client";

import { TimeAgo } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import type { CleanupRun } from "@/server/settings";
import { SettingsCard } from "../_components/settings-card";

type AutoSettings = {
  cleanupEnabled: boolean;
  cleanupIntervalHours: number;
  cleanupDiskThreshold: number;
  cleanupBuildCacheDays: number;
  cleanupUnusedImages: boolean;
};

const intervals = [6, 12, 24, 48, 168];

/** Cleanup schedule shared by every server. */
export function CleanupPolicy({ settings, latest }: { settings: AutoSettings; latest: CleanupRun | null }) {
  return (
    <SettingsCard
      title="Automatic cleanup"
      description="Every server is cleaned up on this schedule, and right away when its disk fills up."
      initial={settings}
      footerNote={
        latest ? (
          <>
            Last run <TimeAgo date={latest.at} />
          </>
        ) : undefined
      }
    >
      {(v, set) => (
        <>
          <SwitchRow
            title="Scheduled cleanup"
            description="Removes dangling Serve images, stale deployment containers and old build cache."
            checked={v.cleanupEnabled}
            onCheckedChange={set("cleanupEnabled")}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Run every">
              <Select
                value={String(v.cleanupIntervalHours)}
                onValueChange={(x) => set("cleanupIntervalHours")(Number(x))}
                disabled={!v.cleanupEnabled}
                options={(intervals.includes(v.cleanupIntervalHours) ? intervals : [...intervals, v.cleanupIntervalHours].sort((a, b) => a - b)).map((h) => ({
                  value: String(h),
                  label: h === 168 ? "Week" : h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} hours`,
                }))}
              />
            </Field>
            <Field label="Clean up when disk reaches" description="Runs an aggressive cleanup and notifies you.">
              <InputGroup suffix="%">
                <Input
                  value={String(v.cleanupDiskThreshold)}
                  onChange={(e) => set("cleanupDiskThreshold")(Math.min(99, Number(e.target.value.replace(/\D/g, "")) || 0))}
                  onBlur={() => set("cleanupDiskThreshold")(Math.max(50, v.cleanupDiskThreshold))}
                  inputMode="numeric"
                />
              </InputGroup>
            </Field>
            <Field label="Keep build cache for" description="0 keeps it forever. Faster builds, more disk.">
              <InputGroup suffix="days">
                <Input
                  value={String(v.cleanupBuildCacheDays)}
                  onChange={(e) => set("cleanupBuildCacheDays")(Math.min(90, Number(e.target.value.replace(/\D/g, "")) || 0))}
                  inputMode="numeric"
                />
              </InputGroup>
            </Field>
          </div>
          <SwitchRow
            title="Remove unused images"
            description="Also delete images no container uses and older than a day, including other projects' images on this host. Serve keeps its own images for rollbacks."
            checked={v.cleanupUnusedImages}
            onCheckedChange={set("cleanupUnusedImages")}
          />
        </>
      )}
    </SettingsCard>
  );
}
