"use client";

import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { ALL_DATABASES, readChoice, SKIP_PREFIX } from "@/lib/backup-databases";

export type DatabaseChoices = { databases: string[]; selected: string[] | null; main: string; engine: string };

/** What a backup takes when nothing is chosen: the main database, or every database on MongoDB. */
export const defaultDatabases = (c: DatabaseChoices) => (c.engine === "mongodb" ? [ALL_DATABASES] : [c.main]);

/** The saved choice: null when it is the default. */
export function savedChoice(c: DatabaseChoices, picked: string[]): string[] | null {
  const { all, skip } = readChoice(picked);
  const want = all ? [ALL_DATABASES, ...[...skip].sort().map((d) => `${SKIP_PREFIX}${d}`)] : [...picked].sort();
  const usual = [...defaultDatabases(c)].sort();
  return want.length && want.join("\u0000") !== usual.join("\u0000") ? want : null;
}

/**
 * The server's databases a backup takes. "Every database" means every one at backup time, new ones
 * included, less any left out; ticking each database by hand takes just those.
 */
export function DatabasePicker({
  choices,
  value,
  onChange,
  disabled,
  scheduled = false,
}: {
  choices: DatabaseChoices;
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  /** For a schedule: Every database also takes databases made later, which is worth saying there. */
  scheduled?: boolean;
}) {
  const { all, skip } = readChoice(value);
  const [skipping, setSkipping] = React.useState(skip.length > 0);
  const setSkip = (next: string[]) => onChange([ALL_DATABASES, ...next.map((d) => `${SKIP_PREFIX}${d}`)]);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2.5">
      <div className={`flex flex-col gap-1 text-[12.5px] text-muted ${all && !skipping ? "" : "border-b border-line pb-2"}`}>
        <label className="flex cursor-pointer items-start gap-2.5">
          <Checkbox
            checked={all}
            disabled={disabled}
            onCheckedChange={(on) => {
              setSkipping(false);
              onChange(on ? [ALL_DATABASES] : [choices.main]);
            }}
          />
          <span className="flex flex-col gap-0.5">
            Every database
            {all && scheduled && <span className="text-[11.5px] text-faint">Databases created later are included too.</span>}
          </span>
        </label>
        {all && !skipping && !disabled && (
          <button type="button" onClick={() => setSkipping(true)} className="ml-[26px] w-fit text-[12px] text-accent hover:underline">
            Leave some out
          </button>
        )}
      </div>
      {all && skipping && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] text-faint">Leave out</span>
          <div className="scrollbar-thin flex max-h-44 flex-col gap-1.5 overflow-y-auto">
            {choices.databases.map((d) => (
              <label key={d} className="flex cursor-pointer items-center gap-2.5">
                <Checkbox checked={skip.includes(d)} disabled={disabled} onCheckedChange={(on) => setSkip(on ? [...skip, d] : skip.filter((x) => x !== d))} />
                <span className={`min-w-0 truncate font-mono text-[12.5px] ${skip.includes(d) ? "text-faint line-through" : "text-fg-2"}`}>{d}</span>
                {d === choices.main && <span className="text-[11px] text-faint">main</span>}
              </label>
            ))}
          </div>
        </div>
      )}
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
