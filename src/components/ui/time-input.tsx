"use client";

import * as React from "react";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");

/** Whether this browser shows times with AM/PM. */
function uses12Hour() {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === true;
  } catch {
    return false;
  }
}

/**
 * A time of day ("HH:MM", 24-hour) picked from the app's own menus, not the browser's: hours,
 * minutes in steps of 5 (a saved odd minute stays listed) and AM/PM where the browser uses it.
 */
export function TimeInput({ value, onChange, className, disabled }: { value: string; onChange: (value: string) => void; className?: string; disabled?: boolean }) {
  const [h12, setH12] = React.useState(false);
  // Read after mounting: the server renders 24-hour, the browser may switch to AM/PM.
  React.useEffect(() => setH12(uses12Hour()), []);
  const [hRaw, mRaw] = (value || "00:00").split(":");
  const hour = Math.min(23, Math.max(0, Number(hRaw) || 0));
  const minute = Math.min(59, Math.max(0, Number(mRaw) || 0));
  const set = (h: number, m: number) => onChange(`${pad(h)}:${pad(m)}`);

  const minutes = [...new Set([...Array.from({ length: 12 }, (_, i) => i * 5), minute])].sort((a, b) => a - b);
  const pm = hour >= 12;
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Select
        aria-label="Hour"
        className="w-[4.5rem] font-mono"
        disabled={disabled}
        value={String(h12 ? hour % 12 || 12 : hour)}
        onValueChange={(v) => {
          const n = Number(v);
          set(h12 ? (n % 12) + (pm ? 12 : 0) : n, minute);
        }}
        options={(h12 ? Array.from({ length: 12 }, (_, i) => i + 1) : Array.from({ length: 24 }, (_, i) => i)).map((n) => ({ value: String(n), label: h12 ? String(n) : pad(n) }))}
      />
      <span className="text-muted">:</span>
      <Select
        aria-label="Minute"
        className="w-[4.5rem] font-mono"
        disabled={disabled}
        value={String(minute)}
        onValueChange={(v) => set(hour, Number(v))}
        options={minutes.map((n) => ({ value: String(n), label: pad(n) }))}
      />
      {h12 && (
        <Select
          aria-label="AM or PM"
          className="w-[4.5rem]"
          disabled={disabled}
          value={pm ? "pm" : "am"}
          onValueChange={(v) => set((hour % 12) + (v === "pm" ? 12 : 0), minute)}
          options={[
            { value: "am", label: "AM" },
            { value: "pm", label: "PM" },
          ]}
        />
      )}
    </div>
  );
}
