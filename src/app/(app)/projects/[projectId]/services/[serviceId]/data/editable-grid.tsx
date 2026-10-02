"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, KeyRound, Maximize2, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import type { Cell, Structure } from "@/server/actions/database-explorer";

type Column = Structure["columns"][number];
type Values = Record<string, Cell>;
export type GridChanges = {
  /** original: what the row showed, so a row someone changed since is not overwritten. */
  updates: { key: { column: string; value: string }[]; values: Values; original: Values }[];
  inserts: { values: Values }[];
  deletes: { key: { column: string; value: string }[]; original: Values }[];
};

const NOT_EDITABLE = /blob|binary|^bit\b|geometry|point|polygon|linestring/i;
/** Characters the rows show of one value (MAX_CELL); a longer value is cut and ends in an ellipsis. */
const MAX_CELL = 20_000;
/** A value shown cut short: saving it would write only its start. */
const capped = (v: Cell) => v !== null && v.length === MAX_CELL + 1 && v.endsWith("…");
/** Values a one-line box would hide: they open in the row panel instead. */
const long = (v: Cell) => v !== null && (v.length > 300 || v.includes("\n"));

type Spot = { kind: "row" | "new"; index: number; column: number };

/**
 * Rows to change like a spreadsheet: double-click (or Enter) a value to edit it, add and delete
 * rows, then save everything at once. Nothing is written until "Save changes"; the save is one
 * transaction, so a failure leaves the table as it was.
 */
export function EditableGrid({
  columns,
  structure,
  rows,
  loading,
  sort,
  onSort,
  empty,
  onSave,
  onDirty,
}: {
  columns: string[];
  structure: Structure;
  rows: Cell[][];
  loading?: boolean;
  sort?: { column: string; desc: boolean } | null;
  onSort?: (column: string) => void;
  empty: string;
  /** An error message, or null once saved. */
  onSave: (changes: GridChanges) => Promise<string | null>;
  /** Unsaved changes: the page keeps its rows (no paging or sorting) until they are saved or discarded. */
  onDirty: (dirty: boolean) => void;
}) {
  const info = React.useMemo(() => new Map(structure.columns.map((c) => [c.name, c])), [structure]);
  const primary = structure.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const [edits, setEdits] = React.useState<Map<number, Values>>(new Map());
  const [deleted, setDeleted] = React.useState<Set<number>>(new Set());
  const [inserts, setInserts] = React.useState<{ id: number; values: Values }[]>([]);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [active, setActive] = React.useState<Spot | null>(null);
  const [editing, setEditingState] = React.useState<{ spot: Spot; text: string; isNull: boolean } | null>(null);
  // The value being edited, read by commit: the input's blur after Escape (or after a commit) finds
  // nothing left to save, where the state of that render would still hold it.
  const editRef = React.useRef<typeof editing>(null);
  const setEditing = (next: typeof editing) => {
    editRef.current = next;
    setEditingState(next);
  };
  const [panel, setPanel] = React.useState<{ kind: "row" | "new"; index: number } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const nextId = React.useRef(1);
  const box = React.useRef<HTMLDivElement>(null);

  const editedCells = [...edits.values()].reduce((n, v) => n + Object.keys(v).length, 0);
  const dirty = edits.size > 0 || deleted.size > 0 || inserts.length > 0;
  React.useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // New rows from the server (a refresh, another page): the old changes no longer fit them.
  const rowsRef = React.useRef(rows);
  if (rowsRef.current !== rows) {
    rowsRef.current = rows;
    if (dirty || selected.size || active || editing) {
      setEdits(new Map());
      setDeleted(new Set());
      setInserts([]);
      setSelected(new Set());
      setActive(null);
      setEditing(null);
    }
  }

  const keyable = primary.length > 0 && primary.every((p) => !NOT_EDITABLE.test(info.get(p)?.type ?? ""));
  const canEdit = (kind: Spot["kind"], column: string) => {
    const col = info.get(column);
    if (!col || NOT_EDITABLE.test(col.type)) return false;
    if (kind === "new") return true;
    return keyable && !col.primaryKey;
  };
  const original = (index: number, column: string): Cell => rows[index]?.[columns.indexOf(column)] ?? null;
  const valueAt = (spot: { kind: Spot["kind"]; index: number }, column: string): Cell => {
    if (spot.kind === "new") return inserts[spot.index]?.values[column] ?? null;
    const changed = edits.get(spot.index);
    return changed && column in changed ? changed[column] : original(spot.index, column);
  };
  const isChanged = (index: number, column: string) => !!edits.get(index) && column in edits.get(index)!;

  const setValue = (spot: { kind: Spot["kind"]; index: number }, column: string, value: Cell) => {
    if (spot.kind === "new") {
      // An empty value of a new row is no value: the column gets its default.
      setInserts((list) =>
        list.map((r, i) => {
          if (i !== spot.index) return r;
          const values = { ...r.values };
          if (value === null || value === "") delete values[column];
          else values[column] = value;
          return { ...r, values };
        }),
      );
      return;
    }
    setEdits((prev) => {
      const next = new Map(prev);
      const row = { ...(next.get(spot.index) ?? {}) };
      // Back to what the row shows: no longer a change.
      if (value === original(spot.index, column)) delete row[column];
      else row[column] = value;
      if (Object.keys(row).length) next.set(spot.index, row);
      else next.delete(spot.index);
      return next;
    });
  };

  /** typed: the key that started editing, which replaces the value (as in a spreadsheet). */
  const startEdit = (spot: Spot, typed?: string) => {
    const column = columns[spot.column];
    if (!column || !canEdit(spot.kind, column)) return;
    if (spot.kind === "row" && deleted.has(spot.index)) return;
    const v = valueAt(spot, column);
    if (spot.kind === "row" && capped(original(spot.index, column))) return setPanel({ kind: spot.kind, index: spot.index });
    if (typed === undefined && long(v)) return setPanel({ kind: spot.kind, index: spot.index });
    setActive(spot);
    setEditing({ spot, text: typed ?? v ?? "", isNull: typed === undefined && v === null });
  };
  const commit = (move?: "next" | "prev" | "down") => {
    const ed = editRef.current;
    if (!ed) return;
    setEditing(null);
    const column = columns[ed.spot.column];
    setValue(ed.spot, column, ed.isNull || (ed.spot.kind === "new" && ed.text === "") ? null : ed.text);
    if (move) setActive(step(ed.spot, move));
    // Right away: the next key typed must reach the table.
    box.current?.focus();
  };
  const cancel = () => {
    setEditing(null);
    box.current?.focus();
  };
  const step = (spot: Spot, move: "next" | "prev" | "down" | "up" | "left" | "right"): Spot => {
    const rowsOf = (kind: Spot["kind"]) => (kind === "new" ? inserts.length : rows.length);
    let { kind, index, column } = spot;
    if (move === "next" || move === "right") column = Math.min(columns.length - 1, column + 1);
    if (move === "prev" || move === "left") column = Math.max(0, column - 1);
    if (move === "down") {
      if (index + 1 < rowsOf(kind)) index++;
      else if (kind === "new" && rows.length) [kind, index] = ["row", 0];
    }
    if (move === "up") {
      if (index > 0) index--;
      else if (kind === "row" && inserts.length) [kind, index] = ["new", inserts.length - 1];
    }
    return { kind, index, column };
  };

  const keyOf = (index: number) => primary.map((p) => ({ column: p, value: original(index, p) ?? "" }));
  /** What the row showed in these columns: the save fails when the row holds something else now. */
  const shown = (index: number, cols: string[]) => Object.fromEntries(cols.map((c) => [c, original(index, c)]));
  /** New rows without a value a column needs (not null, no default): the database would refuse them. */
  const missing = inserts
    .map((r, i) => ({ i, need: structure.columns.filter((c) => !c.nullable && !c.default && !(c.name in r.values)).map((c) => c.name) }))
    .filter((m) => m.need.length);
  const save = async () => {
    if (missing.length) {
      const m = missing[0];
      setError(`New row ${m.i + 1} needs a value for ${m.need.join(", ")}.`);
      setActive({ kind: "new", index: m.i, column: columns.indexOf(m.need[0]) });
      return;
    }
    setSaving(true);
    setError(null);
    const changes: GridChanges = {
      updates: [...edits.entries()].filter(([i]) => !deleted.has(i)).map(([i, values]) => ({ key: keyOf(i), values, original: shown(i, Object.keys(values)) })),
      inserts: inserts.filter((r) => Object.keys(r.values).length).map((r) => ({ values: r.values })),
      deletes: [...deleted].map((i) => ({ key: keyOf(i), original: shown(i, columns) })),
    };
    const failed = await onSave(changes);
    setSaving(false);
    if (failed) setError(failed);
  };
  const discard = () => {
    setEdits(new Map());
    setDeleted(new Set());
    setInserts([]);
    setSelected(new Set());
    setEditing(null);
    setError(null);
  };
  const addRow = () => {
    setInserts((list) => [{ id: nextId.current++, values: {} }, ...list]);
    const first = columns.findIndex((c) => canEdit("new", c));
    setActive({ kind: "new", index: 0, column: Math.max(0, first) });
    box.current?.focus();
  };
  const deleteSelected = () => {
    setDeleted((prev) => new Set([...prev, ...selected]));
    setSelected(new Set());
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing || !active || panel) return;
    const moves: Record<string, Parameters<typeof step>[1]> = { ArrowDown: "down", ArrowUp: "up", ArrowLeft: "left", ArrowRight: "right", Tab: e.shiftKey ? "prev" : "next" };
    if (moves[e.key]) {
      e.preventDefault();
      setActive(step(active, moves[e.key]));
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEdit(active);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startEdit(active, e.key);
    } else if (e.key === "Delete" && active.kind === "row" && keyable) {
      const column = columns[active.column];
      if (canEdit("row", column) && info.get(column)?.nullable) setValue(active, column, null);
    }
  };

  const allSelected = rows.length > 0 && rows.every((_, i) => selected.has(i));
  const summary = [
    editedCells && `${editedCells} ${editedCells === 1 ? "value" : "values"} changed`,
    inserts.length && `${inserts.length} new ${inserts.length === 1 ? "row" : "rows"}`,
    deleted.size && `${deleted.size} ${deleted.size === 1 ? "row" : "rows"} to delete`,
  ].filter(Boolean);

  const cell = (spot: Spot, column: string) => {
    const v = valueAt(spot, column);
    const isActive = active?.kind === spot.kind && active.index === spot.index && active.column === spot.column;
    const isEditing = editing && editing.spot.kind === spot.kind && editing.spot.index === spot.index && editing.spot.column === spot.column;
    const changed = spot.kind === "row" && isChanged(spot.index, column);
    const locked = !canEdit(spot.kind, column);
    if (isEditing) {
      const col = info.get(column);
      return (
        <td key={column} className="relative border-b border-line/70 p-0">
          <input
            // biome-ignore lint/a11y/noAutofocus: the cell being edited takes the keyboard.
            autoFocus
            value={editing.isNull ? "" : editing.text}
            placeholder={editing.spot.kind === "new" ? "Default" : editing.isNull ? "NULL" : undefined}
            onChange={(e) => setEditing({ ...editing, text: e.target.value, isNull: false })}
            onBlur={() => commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault(), commit("down");
              else if (e.key === "Tab") e.preventDefault(), commit(e.shiftKey ? "prev" : "next");
              else if (e.key === "Escape") e.preventDefault(), cancel();
            }}
            spellCheck={false}
            aria-label={`New value of ${column}`}
            className="block h-[30px] w-full min-w-40 bg-surface px-3 pr-14 font-mono text-[12.5px] text-fg outline-none ring-2 ring-accent ring-inset placeholder:text-faint placeholder:italic"
          />
          {col?.nullable && editing.spot.kind === "row" && (
            <button
              type="button"
              // Keeps the input's focus (its blur would save before the click).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEditing({ ...editing, isNull: true, text: "" })}
              className={cn(
                "absolute top-1/2 right-1.5 -translate-y-1/2 rounded px-1.5 py-0.5 font-mono text-[10.5px] transition-colors",
                editing.isNull ? "bg-accent/20 text-accent" : "bg-sunken text-muted hover:text-fg",
              )}
              title="Set NULL"
            >
              NULL
            </button>
          )}
        </td>
      );
    }
    return (
      <td
        key={column}
        onClick={() => setActive(spot)}
        onDoubleClick={() => startEdit(spot)}
        className={cn(
          "max-w-[22rem] cursor-default border-b border-line/70 px-3 py-1.5 font-mono whitespace-nowrap",
          changed && "bg-warn/10 shadow-[inset_2px_0_0_var(--warn)]",
          isActive && "outline-2 -outline-offset-2 outline-accent",
          locked && spot.kind === "row" && "text-fg-2",
        )}
        title={locked ? (info.get(column)?.primaryKey ? "Part of the primary key: change it in the Query tab" : undefined) : "Double-click to edit"}
      >
        <span className="block truncate">
          {v === null && spot.kind === "new" ? (
            <span className="text-[11px] text-faint italic">{info.get(column)?.default ? "default" : info.get(column)?.nullable ? "empty" : "needed"}</span>
          ) : v === null ? (
            <span className="rounded bg-sunken px-1 text-[11px] text-faint">NULL</span>
          ) : v === "" ? (
            <span className="text-faint">''</span>
          ) : (
            v.replace(/\n/g, "↵ ")
          )}
        </span>
      </td>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="secondary" onClick={addRow}>
          <Plus /> Add row
        </Button>
        {selected.size > 0 && (
          <Button size="xs" variant="ghost" className="text-bad hover:text-bad" onClick={deleteSelected}>
            <Trash2 /> Delete {selected.size} {selected.size === 1 ? "row" : "rows"}
          </Button>
        )}
        <span className="ml-auto hidden text-[11.5px] text-faint sm:inline">Double-click or Enter to edit · Tab moves on · Esc cancels</span>
      </div>
      {!keyable && (
        <p className="text-xs text-muted">
          This table has no primary key Serve can use, so its rows cannot be changed or deleted here. New rows can be added, and the Query tab changes the rest.
        </p>
      )}
      <div
        ref={box}
        tabIndex={-1}
        onKeyDown={onKey}
        className={cn("scrollbar-thin max-h-[36rem] overflow-auto rounded-lg border border-line outline-none transition-opacity", loading && "opacity-60")}
      >
        <table className="w-max min-w-full border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 w-16 border-b border-line bg-surface-2 px-2 py-2">
                {keyable && rows.length > 0 && (
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(on) => setSelected(on ? new Set(rows.map((_, i) => i).filter((i) => !deleted.has(i))) : new Set())}
                    aria-label="Select every row"
                  />
                )}
              </th>
              {columns.map((c) => {
                const sorted = sort?.column === c ? sort : null;
                const col = info.get(c);
                return (
                  <th
                    key={c}
                    className="sticky top-0 z-10 border-b border-line bg-surface-2 px-3 py-2 text-left font-medium whitespace-nowrap text-fg-2"
                    aria-sort={sorted ? (sorted.desc ? "descending" : "ascending") : undefined}
                  >
                    <button
                      type="button"
                      disabled={!onSort}
                      onClick={() => onSort?.(c)}
                      className="flex items-center gap-1.5 font-mono enabled:hover:text-fg"
                      title={col ? `${col.type}${col.nullable ? "" : ", not null"}` : undefined}
                    >
                      {col?.primaryKey && <KeyRound className="size-3 text-warn" />}
                      {c}
                      <span className="font-sans text-[10.5px] font-normal text-faint">{col?.type}</span>
                      {sorted ? sorted.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" /> : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {inserts.map((r, i) => (
              <tr key={`new-${r.id}`} className="bg-ok/[0.06]">
                <td className="sticky left-0 z-[5] border-b border-line/70 bg-surface px-2 py-1">
                  <span className="flex items-center gap-1">
                    <Badge tone="ok" className="px-1.5 py-0 text-[10px]">
                      new
                    </Badge>
                    <RowButton label="Open the row" onClick={() => setPanel({ kind: "new", index: i })} icon={<Maximize2 />} />
                    <RowButton label="Remove the new row" onClick={() => setInserts((list) => list.filter((x) => x.id !== r.id))} icon={<Trash2 />} />
                  </span>
                </td>
                {columns.map((c, ci) => cell({ kind: "new", index: i, column: ci }, c))}
              </tr>
            ))}
            {rows.map((_, i) => {
              const gone = deleted.has(i);
              return (
                <tr key={i} className={cn(gone ? "bg-bad/[0.06] text-faint line-through" : "hover:bg-hover/50", selected.has(i) && !gone && "bg-accent/[0.06]")}>
                  <td className="sticky left-0 z-[5] border-b border-line/70 bg-surface px-2 py-1">
                    <span className="flex items-center gap-1">
                      {keyable && !gone && (
                        <Checkbox
                          checked={selected.has(i)}
                          onCheckedChange={(on) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (on) next.add(i);
                              else next.delete(i);
                              return next;
                            })
                          }
                          aria-label={`Select row ${i + 1}`}
                        />
                      )}
                      {gone ? (
                        <RowButton
                          label="Keep the row"
                          onClick={() =>
                            setDeleted((prev) => {
                              const next = new Set(prev);
                              next.delete(i);
                              return next;
                            })
                          }
                          icon={<Undo2 />}
                        />
                      ) : (
                        <RowButton label="Open the row" onClick={() => setPanel({ kind: "row", index: i })} icon={<Maximize2 />} />
                      )}
                    </span>
                  </td>
                  {columns.map((c, ci) => cell({ kind: "row", index: i, column: ci }, c))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && !inserts.length && <p className="px-3 py-6 text-center text-[13px] text-muted">{empty}</p>}
      </div>

      {dirty && (
        <div className="sticky bottom-3 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface-2/95 px-4 py-2.5 shadow-lg backdrop-blur">
          <span className="text-[13px] text-fg">{summary.join(" · ")}</span>
          {error && <span className="w-full text-[12.5px] break-words text-bad sm:order-last">{error}</span>}
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={discard} disabled={saving}>
              <RotateCcw /> Discard
            </Button>
            <Button size="sm" variant="primary" onClick={() => void save()} loading={saving}>
              Save changes
            </Button>
          </span>
        </div>
      )}

      {panel && (
        <RowPanel
          title={panel.kind === "new" ? "New row" : `Row ${panel.index + 1}`}
          columns={columns}
          info={info}
          values={Object.fromEntries(columns.map((c) => [c, valueAt(panel, c)]))}
          // A value shown cut short is not changed here: only its start would be saved.
          editable={(c) => canEdit(panel.kind, c) && !(panel.kind === "row" && (deleted.has(panel.index) || capped(original(panel.index, c))))}
          isNew={panel.kind === "new"}
          onClose={() => setPanel(null)}
          onApply={(values) => {
            for (const [c, v] of Object.entries(values)) setValue(panel, c, v);
            setPanel(null);
          }}
        />
      )}
    </div>
  );
}

function RowButton({ label, onClick, icon }: { label: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="rounded p-1 text-faint transition-colors hover:bg-hover hover:text-fg [&_svg]:size-3.5">
      {icon}
    </button>
  );
}

/** Every column of one row as a form: for wide rows, long text and JSON. Changes join the others until saved. */
function RowPanel({
  title,
  columns,
  info,
  values,
  editable,
  isNew,
  onClose,
  onApply,
}: {
  title: string;
  columns: string[];
  info: Map<string, Column>;
  values: Values;
  editable: (column: string) => boolean;
  isNew: boolean;
  onClose: () => void;
  onApply: (values: Values) => void;
}) {
  const [draft, setDraft] = React.useState<Values>(values);
  const changed = Object.fromEntries(Object.entries(draft).filter(([c, v]) => v !== values[c]));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader title={title} description={isNew ? "Columns left empty get their default." : "Changes join the others in the table until you save them."} />
        <DialogBody className="scrollbar-thin flex max-h-[65vh] flex-col gap-3.5 overflow-y-auto">
          {columns.map((c) => {
            const col = info.get(c);
            const v = draft[c] ?? null;
            const can = editable(c);
            return (
              <div key={c} className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                  {col?.primaryKey && <KeyRound className="size-3 text-warn" />}
                  <span className="font-mono font-medium text-fg">{c}</span>
                  <span className="text-faint">{col?.type}</span>
                  {col && !col.nullable && <span className="text-faint">· not null</span>}
                  {isNew && col?.default && <span className="truncate text-faint">· default {col.default}</span>}
                  {can && !isNew && col?.nullable && (
                    <label className="ml-auto flex items-center gap-1.5 text-[12px] text-muted">
                      <Checkbox checked={v === null} onCheckedChange={(on) => setDraft((d) => ({ ...d, [c]: on ? null : "" }))} /> NULL
                    </label>
                  )}
                </span>
                <Textarea
                  value={v ?? ""}
                  placeholder={v === null ? (isNew ? "Default" : "NULL") : undefined}
                  readOnly={!can}
                  tabIndex={can ? undefined : -1}
                  onChange={(e) => setDraft((d) => ({ ...d, [c]: e.target.value }))}
                  rows={Math.min(8, Math.max(1, (v ?? "").split("\n").length, Math.ceil((v ?? "").length / 90)))}
                  spellCheck={false}
                  aria-label={c}
                  className={cn("min-h-9 resize-y py-1.5 font-mono text-[12.5px]", !can && "resize-none border-transparent bg-sunken text-fg-2 focus-visible:ring-0")}
                />
              </div>
            );
          })}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onApply(changed)} disabled={!Object.keys(changed).length}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
