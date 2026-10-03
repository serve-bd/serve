"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { ALL_DATABASES } from "@/lib/backup-databases";

export type DatabaseChoices = { databases: string[]; selected: string[] | null; main: string; engine: string };

/** What a backup takes when nothing is chosen: the main database, or every database on MongoDB. */
export const defaultDatabases = (c: DatabaseChoices) => (c.engine === "mongodb" ? [ALL_DATABASES] : [c.main]);

/** The saved choice: null when it is the default. */
export function savedChoice(c: DatabaseChoices, picked: string[]): string[] | null {
  const want = picked.includes(ALL_DATABASES) ? [ALL_DATABASES] : [...picked].sort();
  const usual = [...defaultDatabases(c)].sort();
  return want.length && want.join("\u0000") !== usual.join("\u0000") ? want : null;
}

/**
 * The server's databases a backup takes. "Every database" means every one at backup time, new ones
 * included; ticking each database by hand takes just those.
 */
export function DatabasePicker({ choices, value, onChange, disabled }: { choices: DatabaseChoices; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const all = value.includes(ALL_DATABASES);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2.5">
      <label className={`flex cursor-pointer items-center gap-2.5 text-[12.5px] text-muted ${all ? "" : "border-b border-line pb-2"}`}>
        <Checkbox checked={all} disabled={disabled} onCheckedChange={(on) => onChange(on ? [ALL_DATABASES] : [choices.main])} />
        Every database
        {all && <span className="text-[11px] text-faint">(databases created later too)</span>}
      </label>
      {!all && (
        <div className="scrollbar-thin flex max-h-44 flex-col gap-1.5 overflow-y-auto">
          {choices.databases.map((d) => (
            <label key={d} className="flex cursor-pointer items-center gap-2.5">
              <Checkbox checked={value.includes(d)} disabled={disabled} onCheckedChange={(on) => onChange(on ? [...value, d] : value.filter((x) => x !== d))} />
              <span className="min-w-0 truncate font-mono text-[12.5px] text-fg-2">{d}</span>
              {d === choices.main && <span className="text-[11px] text-faint">main</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
