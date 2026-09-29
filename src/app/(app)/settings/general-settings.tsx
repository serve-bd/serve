"use client";

import { Field } from "@/components/ui/field";
import { Combobox } from "@/components/ui/combobox";
import { SettingsCard } from "./_components/settings-card";

let zones: { value: string; label: string; description: string }[] | null = null;
function timezoneOptions() {
  if (zones) return zones;
  const now = new Date();
  const list = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  zones = list.map((tz) => {
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
    return { value: tz, label: tz.replace(/_/g, " "), description: offset.replace("GMT", "UTC") || "UTC" };
  });
  return zones;
}

export function GeneralSettings({ initial }: { initial: { timezone: string } }) {
  return (
    <SettingsCard title="General" description="When schedules run. The product name, logo and colours are under Branding." initial={initial}>
      {(v, set) => (
        <>
          <Field label="Timezone" description="Backup schedules and scheduled tasks run in this timezone.">
            <Combobox value={v.timezone} onValueChange={set("timezone")} options={timezoneOptions()} placeholder="Search timezones" className="sm:max-w-sm" />
          </Field>
        </>
      )}
    </SettingsCard>
  );
}
