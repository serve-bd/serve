"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Input } from "@/components/ui/input";

/** A settings card with its own form state and save button. */
export function Section<T>({
  id,
  title,
  description,
  initial,
  onSave,
  children,
  footerNote,
  footerAction,
}: {
  /** Anchor for the settings navigation. */
  id?: string;
  title: string;
  description?: string;
  initial: T;
  onSave: (value: T) => Promise<unknown>;
  children: (value: T, set: (patch: Partial<T>) => void) => React.ReactNode;
  footerNote?: React.ReactNode;
  /** Secondary action shown at the start of the footer, like "Add volume". */
  footerAction?: (value: T, set: (patch: Partial<T>) => void) => React.ReactNode;
}) {
  const [value, setValue] = React.useState<T>(initial);
  const [saved, setSaved] = React.useState(JSON.stringify(initial));
  const [pending, setPending] = React.useState(false);
  const dirty = JSON.stringify(value) !== saved;
  const set = (patch: Partial<T>) => setValue((v) => ({ ...v, ...patch }));
  return (
    <Card id={id} className="scroll-mt-6">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          const ok = await onSave(value);
          setPending(false);
          if (ok !== undefined) setSaved(JSON.stringify(value));
        }}
      >
        <CardHeader title={title} description={description} />
        <CardBody className="flex flex-col gap-4 py-5">{children(value, set)}</CardBody>
        <CardFooter>
          <div className="flex min-w-0 items-center gap-3">
            {footerAction?.(value, set)}
            <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : footerNote}</span>
          </div>
          <div className="flex flex-none gap-2">
            {dirty && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setValue(JSON.parse(saved))}>
                Discard
              </Button>
            )}
            <Button type="submit" variant="primary" size="sm" disabled={!dirty} loading={pending}>
              Save
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

export const num = (v: string) => (v.trim() === "" ? null : Number(v));
export const digits = (v: string) => v.replace(/\D/g, "");

/** Editable list of key/value pairs (build args, labels). */
export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = "KEY",
  valuePlaceholder = "value",
  addLabel = "Add",
}: {
  value: { key: string; value: string }[];
  onChange: (next: { key: string; value: string }[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      {value.map((row, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_32px] gap-2">
          <Input
            value={row.key}
            onChange={(e) => onChange(value.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
            placeholder={keyPlaceholder}
            className="h-8 font-mono text-[12.5px]"
          />
          <Input
            value={row.value}
            onChange={(e) => onChange(value.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
            placeholder={valuePlaceholder}
            className="h-8 font-mono text-[12.5px]"
          />
          <Button variant="ghost" size="icon" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove">
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button size="xs" variant="ghost" className="w-fit" onClick={() => onChange([...value, { key: "", value: "" }])}>
        <Plus /> {addLabel}
      </Button>
    </div>
  );
}

/** Textarea-like list editor: one entry per line. */
export function linesOf(text: string) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
