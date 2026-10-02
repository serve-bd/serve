"use client";

import { Checkbox } from "@/components/ui/checkbox";

export type DatabaseChoices = { databases: string[]; selected: string[] | null; main: string; engine: string };

/** What a backup takes when nothing is chosen: the main database, or every database on MongoDB. */
export const defaultDatabases = (c: DatabaseChoices) => (c.engine === "mongodb" ? c.databases : [c.main]);

/** The saved choice: null when it is the default (so the default follows new databases on MongoDB). */
export function savedChoice(c: DatabaseChoices, picked: string[]): string[] | null {
  const want = [...picked].sort();
  const usual = [...defaultDatabases(c)].sort();
  return want.length && want.join("\u0000") !== usual.join("\u0000") ? want : null;
}

/** Checkboxes of the server's databases a backup takes. */
export function DatabasePicker({ choices, value, onChange, disabled }: { choices: DatabaseChoices; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const all = choices.databases.length > 0 && choices.databases.every((d) => value.includes(d));
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2.5">
      <label className="flex cursor-pointer items-center gap-2.5 border-b border-line pb-2 text-[12.5px] text-muted">
        <Checkbox checked={all} disabled={disabled} onCheckedChange={(on) => onChange(on ? [...choices.databases] : [choices.main])} />
        Every database
      </label>
      <div className="scrollbar-thin flex max-h-44 flex-col gap-1.5 overflow-y-auto">
        {choices.databases.map((d) => (
          <label key={d} className="flex cursor-pointer items-center gap-2.5">
            <Checkbox checked={value.includes(d)} disabled={disabled} onCheckedChange={(on) => onChange(on ? [...value, d] : value.filter((x) => x !== d))} />
            <span className="min-w-0 truncate font-mono text-[12.5px] text-fg-2">{d}</span>
            {d === choices.main && <span className="text-[11px] text-faint">main</span>}
          </label>
        ))}
      </div>
    </div>
  );
}
