"use client";

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Blocks,
  Box,
  CalendarDays,
  Check,
  Columns2,
  Copy,
  Gauge,
  GripVertical,
  LayoutDashboard,
  Link2,
  Loader2,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Rocket,
  Server,
  Settings2,
  StickyNote,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useRouter } from "@/hooks/use-router";
import {
  ACTIVITY_WEEKS,
  type Column,
  type DashboardLayout,
  type DashboardRow,
  defaultLayout,
  type InnerRow,
  type Item,
  layoutId,
  MAX_COLS,
  MAX_WIDTH,
  newColumn,
  newInnerRow,
  newWidget,
  type Widget,
  WIDGET_TYPES,
  WIDGETS,
  type WidgetType,
  widgetSchema,
  widgetTitle,
} from "@/lib/dashboard";
import { cn } from "@/lib/utils";
import { resetDashboard, saveDashboard } from "@/server/actions/dashboard";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = { Sun, Gauge, AlertTriangle, Rocket, CalendarDays, Blocks, Box, Server, Activity, Link2, StickyNote };
const WidgetIcon = ({ type, className }: { type: WidgetType; className?: string }) => {
  const Icon = ICONS[WIDGETS[type].icon] ?? Box;
  return <Icon className={className} />;
};

/* ------------------------------------------------------------------ editing state */

const EditingContext = React.createContext<{ editing: boolean; setEditing: (v: boolean) => void }>({ editing: false, setEditing: () => {} });

/** Holds whether the overview is being customized, for the header button and the layout. */
export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const [editing, setEditing] = React.useState(false);
  const value = React.useMemo(() => ({ editing, setEditing }), [editing]);
  return <EditingContext.Provider value={value}>{children}</EditingContext.Provider>;
}

export function CustomizeButton() {
  const { editing, setEditing } = React.useContext(EditingContext);
  if (editing) return null;
  return (
    <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
      <LayoutDashboard /> Customize
    </Button>
  );
}

/* ------------------------------------------------------------------ layout changes */

type Loc = { columnId: string; index: number };
type Drag = { kind: "widget" | "inner" | "row"; id: string } | null;
type Drop = { at: Loc } | { row: number } | { newRow: number } | null;

/** Apply `fn` to every column, inner rows' columns included (`inner` tells which). */
function mapColumns(layout: DashboardLayout, fn: (c: Column, inner: boolean) => Column): DashboardLayout {
  return {
    ...layout,
    rows: layout.rows.map((r) => ({
      ...r,
      columns: r.columns.map((c) =>
        fn({ ...c, items: c.items.map((it) => (it.kind === "row" ? { ...it, columns: it.columns.map((ic) => fn(ic, true) as Column<Widget>) } : it)) }, false),
      ),
    })),
  };
}

function innerColumnIds(layout: DashboardLayout) {
  const ids = new Set<string>();
  mapColumns(layout, (c, inner) => {
    if (inner) ids.add(c.id);
    return c;
  });
  return ids;
}

function findItem(layout: DashboardLayout, id: string): { item: Item; columnId: string; index: number } | null {
  let found: { item: Item; columnId: string; index: number } | null = null;
  mapColumns(layout, (c) => {
    const index = c.items.findIndex((it) => it.id === id);
    if (index >= 0) found = { item: c.items[index], columnId: c.id, index };
    return c;
  });
  return found;
}

function removeItem(layout: DashboardLayout, id: string): DashboardLayout {
  return mapColumns(layout, (c) => ({ ...c, items: c.items.filter((it) => it.id !== id) }));
}

/** Put `item` at `loc`. A row never goes inside another row's column. */
function insertItem(layout: DashboardLayout, loc: Loc, item: Item): DashboardLayout {
  if (item.kind === "row" && innerColumnIds(layout).has(loc.columnId)) return layout;
  return mapColumns(layout, (c) => {
    if (c.id !== loc.columnId) return c;
    const items = [...c.items];
    items.splice(Math.max(0, Math.min(loc.index, items.length)), 0, item);
    return { ...c, items };
  });
}

function moveItem(layout: DashboardLayout, id: string, to: Loc): DashboardLayout {
  const from = findItem(layout, id);
  if (!from) return layout;
  if (from.item.kind === "row" && innerColumnIds(layout).has(to.columnId)) return layout;
  // Indexes after the old place shift by one once it is gone.
  const index = from.columnId === to.columnId && from.index < to.index ? to.index - 1 : to.index;
  return insertItem(removeItem(layout, id), { columnId: to.columnId, index }, from.item);
}

function patchItem(layout: DashboardLayout, id: string, patch: Partial<Widget> | Partial<InnerRow>): DashboardLayout {
  return mapColumns(layout, (c) => ({ ...c, items: c.items.map((it) => (it.id === id ? ({ ...it, ...patch } as Item) : it)) }));
}

const patchColumn = (layout: DashboardLayout, id: string, patch: Partial<Column>) => mapColumns(layout, (c) => (c.id === id ? { ...c, ...patch } : c));

/** Change how many columns there are. Items of removed columns move to the last one kept. */
function setColumnCount<T extends Item>(columns: Column<T>[], n: number): Column<T>[] {
  if (n >= columns.length) return [...columns, ...Array.from({ length: n - columns.length }, () => newColumn<T>())];
  const kept = columns.slice(0, n);
  const moved = columns.slice(n).flatMap((c) => c.items);
  return kept.map((c, i) => (i === n - 1 ? { ...c, items: [...c.items, ...moved] } : c));
}

const patchRow = (layout: DashboardLayout, id: string, patch: Partial<DashboardRow>): DashboardLayout => ({
  ...layout,
  rows: layout.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
});

function moveRow(layout: DashboardLayout, id: string, index: number): DashboardLayout {
  const from = layout.rows.findIndex((r) => r.id === id);
  if (from < 0) return layout;
  const rows = [...layout.rows];
  const [row] = rows.splice(from, 1);
  rows.splice(from < index ? index - 1 : index, 0, row);
  return { ...layout, rows };
}

/** A copy with new ids, so it saves as a second widget or row. */
function cloneItem(item: Item): Item {
  if (item.kind === "widget") return { ...item, id: layoutId(), options: { ...item.options, links: item.options.links?.map((l) => ({ ...l })) } };
  return { ...item, id: layoutId(), columns: item.columns.map((c) => ({ ...c, id: layoutId(), items: c.items.map((w) => cloneItem(w) as Widget) })) };
}

/* ------------------------------------------------------------------ viewing */

/** Columns side by side on wide screens (inner rows: from tablets up), stacked on phones. Each stacks on its own. */
function ViewColumns({ columns, nodes, inner }: { columns: Column[]; nodes: Record<string, React.ReactNode>; inner?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-6", inner ? "sm:flex-row" : "lg:flex-row")}>
      {columns.map((c) => (
        <div key={c.id} style={{ flexGrow: c.width }} className={cn("flex min-w-0 flex-col gap-6", inner ? "sm:basis-0" : "lg:basis-0")}>
          {c.items.map((it) => (
            <ViewItem key={it.id} item={it} nodes={nodes} />
          ))}
        </div>
      ))}
    </div>
  );
}

const shows = (item: Item, nodes: Record<string, React.ReactNode>): boolean =>
  item.kind === "widget" ? nodes[item.id] != null : item.columns.some((c) => c.items.some((w) => shows(w, nodes)));

function ViewItem({ item, nodes }: { item: Item; nodes: Record<string, React.ReactNode> }) {
  if (!shows(item, nodes)) return null;
  if (item.kind === "widget") return <div className={cn("min-w-0", item.fill && "flex flex-1 flex-col [&>*]:flex-1")}>{nodes[item.id]}</div>;
  return (
    <section className="flex min-w-0 flex-col gap-3">
      {item.title && <h3 className="text-[13px] font-semibold text-fg-2">{item.title}</h3>}
      <ViewColumns columns={item.columns} nodes={nodes} inner />
    </section>
  );
}

/* ------------------------------------------------------------------ the layout */

type Choices = { projects: { id: string; name: string }[]; servers: { id: string; name: string }[] };

type EditApi = {
  nodes: Record<string, React.ReactNode>;
  drag: Drag;
  drop: Drop;
  startDrag: (e: React.PointerEvent, kind: NonNullable<Drag>["kind"], id: string, label: string) => void;
  change: (fn: (l: DashboardLayout) => DashboardLayout) => void;
  openSettings: (id: string) => void;
  openAdd: (columnId: string, inner: boolean) => void;
};

/** The nearest scrolling box around `el`, for scrolling while dragging near the window's edge. */
function scrollParent(el: HTMLElement | null): HTMLElement {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const overflow = getComputedStyle(n).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

const half = (el: HTMLElement, y: number) => {
  const rect = el.getBoundingClientRect();
  return y < rect.top + rect.height / 2;
};

/**
 * Where a drop at (x, y) lands, read from data attributes on the page. Rows can't go inside
 * an inner row, so for those the search climbs out of inner columns.
 */
function dropAt(x: number, y: number, kind: NonNullable<Drag>["kind"]): Drop {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  if (kind === "row") {
    const row = el.closest<HTMLElement>("[data-row-index]");
    if (!row) return null;
    const i = Number(row.dataset.rowIndex);
    return { row: half(row, y) ? i : i + 1 };
  }
  const newRow = el.closest<HTMLElement>("[data-new-row]");
  if (newRow) return { newRow: Number(newRow.dataset.newRow) };
  const outer = (found: HTMLElement | null, attr: string) => {
    let n = found;
    while (n && kind === "inner" && n.dataset.inner === "1") n = n.parentElement?.closest<HTMLElement>(attr) ?? null;
    return n;
  };
  const item = outer(el.closest<HTMLElement>("[data-item]"), "[data-item]");
  const column = outer(el.closest<HTMLElement>("[data-column]"), "[data-column]");
  // The deeper of the two wins: a column's empty space inside an inner row is that column.
  if (column && (!item || item.contains(column))) return { at: { columnId: column.dataset.column ?? "", index: Number(column.dataset.count) } };
  if (item) {
    const i = Number(item.dataset.index);
    return { at: { columnId: item.dataset.columnId ?? "", index: half(item, y) ? i : i + 1 } };
  }
  return null;
}

export function Dashboard({ initial, nodes, projects, servers }: { initial: DashboardLayout; nodes: Record<string, React.ReactNode> } & Choices) {
  const { editing, setEditing } = React.useContext(EditingContext);
  const router = useRouter();
  const confirm = useConfirm();
  const [layout, setLayout] = React.useState(initial);
  const [saving, setSaving] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [drag, setDrag] = React.useState<Drag>(null);
  const [drop, setDrop] = React.useState<Drop>(null);
  const [settingsFor, setSettingsFor] = React.useState<string | null>(null);
  const [addTo, setAddTo] = React.useState<{ columnId: string; inner: boolean } | null>(null);
  const [, startRefresh] = React.useTransition();

  // Every change saves on its own, then the page refreshes so new widgets get their content.
  const saved = React.useRef(JSON.stringify(initial));
  React.useEffect(() => {
    const json = JSON.stringify(layout);
    if (json === saved.current) return;
    setSaving("saving");
    const t = setTimeout(async () => {
      const res = await saveDashboard(layout);
      if (!res.ok) {
        setSaving("error");
        toast.error(res.error);
        return;
      }
      saved.current = json;
      setSaving("saved");
      startRefresh(() => router.refresh());
    }, 450);
    return () => clearTimeout(t);
  }, [layout, router]);

  const change = React.useCallback((fn: (l: DashboardLayout) => DashboardLayout) => setLayout(fn), []);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = React.useState<{ x: number; y: number; label: string } | null>(null);

  const reset = async () => {
    const ok = await confirm({
      title: "Reset your overview?",
      description: "Your rows and widgets go back to the default layout. Notes and shortcuts you wrote are removed.",
      confirmLabel: "Reset",
      danger: true,
    });
    if (!ok) return;
    const res = await resetDashboard();
    if (!res.ok) return toast.error(res.error);
    const fresh = defaultLayout();
    saved.current = JSON.stringify(fresh);
    setLayout(fresh);
    setSaving("saved");
    startRefresh(() => router.refresh());
  };

  const applyDrop = (d: NonNullable<Drag>, target: Drop) => {
    if (!target) return;
    const { id, kind } = d;
    if (kind === "row" && "row" in target) change((l) => moveRow(l, id, target.row));
    else if (kind !== "row" && "at" in target) change((l) => moveItem(l, id, target.at));
    else if (kind !== "row" && "newRow" in target) {
      change((l) => {
        const found = findItem(l, id);
        if (!found) return l;
        const item = found.item;
        const row: DashboardRow =
          item.kind === "widget" ? { id: layoutId(), columns: [{ ...newColumn(), items: [item] }] } : { id: layoutId(), title: item.title, columns: item.columns };
        const rows = [...removeItem(l, id).rows];
        rows.splice(target.newRow, 0, row);
        return { ...l, rows };
      });
    }
  };

  // Dragging with pointer events, not the browser's drag and drop: that one is unreliable on
  // some Linux desktops and does nothing on touch screens.
  const startDrag = (e: React.PointerEvent, kind: NonNullable<Drag>["kind"], id: string, label: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, a")) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const scroller = scrollParent(rootRef.current);
    let started = false;
    let target: Drop = null;
    let pointerY = start.y;
    let frame = 0;
    const autoScroll = () => {
      const edge = 72;
      const dy = pointerY < edge ? -(edge - pointerY) / 3 : pointerY > window.innerHeight - edge ? (pointerY - (window.innerHeight - edge)) / 3 : 0;
      if (dy) scroller.scrollBy(0, dy);
      frame = requestAnimationFrame(autoScroll);
    };
    const move = (ev: PointerEvent) => {
      pointerY = ev.clientY;
      if (!started) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        started = true;
        setDrag({ kind, id });
        document.body.style.userSelect = "none";
        frame = requestAnimationFrame(autoScroll);
      }
      setGhost({ x: ev.clientX, y: ev.clientY, label });
      target = dropAt(ev.clientX, ev.clientY, kind);
      setDrop(target);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      cancelAnimationFrame(frame);
      document.body.style.userSelect = "";
      if (started) applyDrop({ kind, id }, target);
      setDrag(null);
      setDrop(null);
      setGhost(null);
    };
    const cancel = () => {
      target = null;
      up();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  const api: EditApi = { nodes, drag, drop, startDrag, change, openSettings: setSettingsFor, openAdd: (columnId, inner) => setAddTo({ columnId, inner }) };
  const settingsWidget = settingsFor ? findItem(layout, settingsFor)?.item : undefined;
  const visibleRows = editing ? layout.rows : layout.rows.filter((r) => r.columns.some((c) => c.items.some((it) => shows(it, nodes))));
  const newRowDrops = drag !== null && drag.kind !== "row";

  return (
    <div ref={rootRef} className={cn("relative flex flex-col", editing ? "gap-3 pb-28" : "gap-8")}>
      {ghost && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-lg border border-accent bg-surface px-2.5 py-1.5 text-[12.5px] font-medium text-fg shadow-lg"
          style={{ left: ghost.x + 14, top: ghost.y + 10 }}
        >
          <GripVertical className="size-3.5 text-faint" /> {ghost.label}
        </div>
      )}
      {editing && <NewRowDrop index={0} active={newRowDrops} over={drop !== null && "newRow" in drop && drop.newRow === 0} />}
      {visibleRows.map((row, rowIndex) => (
        <React.Fragment key={row.id}>
          {editing ? (
            <EditRow row={row} index={rowIndex} total={layout.rows.length} api={api} />
          ) : (
            <section className="flex flex-col gap-3">
              {row.title && <h2 className="font-display text-[15px] font-semibold text-fg">{row.title}</h2>}
              <ViewColumns columns={row.columns} nodes={nodes} />
            </section>
          )}
          {editing && <NewRowDrop index={rowIndex + 1} active={newRowDrops} over={drop !== null && "newRow" in drop && drop.newRow === rowIndex + 1} />}
        </React.Fragment>
      ))}

      {!editing && !visibleRows.length && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong px-6 py-14 text-center">
          <p className="text-[13.5px] text-muted">Your overview is empty.</p>
          <Button size="sm" onClick={() => setEditing(true)}>
            <LayoutDashboard /> Add widgets
          </Button>
        </div>
      )}

      {editing && (
        <>
          <AddRowMenu onAdd={(cols) => change((l) => ({ ...l, rows: [...l.rows, { id: layoutId(), columns: Array.from({ length: cols }, () => newColumn()) }] }))} />
          <EditBar saving={saving} onReset={reset} onDone={() => setEditing(false)} />
        </>
      )}

      <AddWidgetDialog
        open={addTo !== null}
        inner={addTo?.inner ?? false}
        onOpenChange={(o) => !o && setAddTo(null)}
        onPick={(type) => {
          const target = addTo;
          setAddTo(null);
          if (!target) return;
          const loc = { columnId: target.columnId, index: Number.MAX_SAFE_INTEGER };
          if (type === "row") return change((l) => insertItem(l, loc, newInnerRow(2)));
          const w = newWidget(type);
          if (type === "project") w.options.projectId = projects[0]?.id;
          if (type === "server") w.options.serverId = servers[0]?.id;
          change((l) => insertItem(l, loc, w));
          // Notes and shortcuts are empty until written, so their settings open right away.
          if (type === "note" || type === "shortcuts") setSettingsFor(w.id);
        }}
      />

      {settingsWidget?.kind === "widget" && (
        <WidgetSettings
          key={settingsWidget.id}
          widget={settingsWidget}
          projects={projects}
          servers={servers}
          onClose={() => setSettingsFor(null)}
          onSave={(next) => {
            change((l) => patchItem(l, next.id, next));
            setSettingsFor(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ customizing */

function ColsPicker({ value, max, onChange }: { value: number; max: number; onChange: (n: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Columns" className="flex flex-none items-center rounded-lg border border-line bg-surface p-0.5">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          title={`${n} ${n === 1 ? "column" : "columns"}`}
          onClick={() => onChange(n)}
          className={cn("flex h-6 items-center gap-[2px] rounded-md px-1.5 transition-colors", value === n ? "bg-surface-2 text-fg shadow-sm" : "text-faint hover:text-fg")}
        >
          {Array.from({ length: n }, (_, j) => (
            <span key={j} className="h-3 w-[5px] rounded-[2px] bg-current" />
          ))}
        </button>
      ))}
    </div>
  );
}

function EditRow({ row, index, total, api }: { row: DashboardRow; index: number; total: number; api: EditApi }) {
  const ref = React.useRef<HTMLElement>(null);
  const { drag, drop, change } = api;
  const rowDrop = drag?.kind === "row" && drop && "row" in drop ? (drop.row === index ? "before" : drop.row === index + 1 ? "after" : null) : null;
  return (
    <section
      ref={ref}
      aria-label={`Row ${index + 1}`}
      data-row-index={index}
      className={cn(
        "relative flex flex-col gap-2 rounded-2xl border border-dashed border-line-strong bg-surface-2/40 p-2 transition-[box-shadow,opacity] sm:p-3",
        drag?.kind === "row" && drag.id === row.id && "opacity-50",
        rowDrop === "before" && "shadow-[0_-3px_0_0_var(--accent)]",
        rowDrop === "after" && "shadow-[0_3px_0_0_var(--accent)]",
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span
          onPointerDown={(e) => api.startDrag(e, "row", row.id, row.title || `Row ${index + 1}`)}
          title="Drag to move this row"
          className="flex h-7 flex-none cursor-grab touch-none items-center gap-1 rounded-md px-1 text-[12px] font-medium text-muted hover:bg-hover active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" /> Row {index + 1}
        </span>
        <ColsPicker value={row.columns.length} max={MAX_COLS} onChange={(n) => change((l) => patchRow(l, row.id, { columns: setColumnCount(row.columns, n) }))} />
        <RowTitle row={row} onChange={(title) => change((l) => patchRow(l, row.id, { title: title.trim() || undefined }))} />
        <span className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" title="Move row up" disabled={index === 0} onClick={() => change((l) => moveRow(l, row.id, index - 1))}>
            <ArrowUp />
          </Button>
          <Button variant="ghost" size="icon-sm" title="Move row down" disabled={index === total - 1} onClick={() => change((l) => moveRow(l, row.id, index + 2))}>
            <ArrowDown />
          </Button>
          <Button variant="ghost" size="icon-sm" title="Remove row" onClick={() => change((l) => ({ ...l, rows: l.rows.filter((r) => r.id !== row.id) }))}>
            <Trash2 />
          </Button>
        </span>
      </header>
      <EditColumns columns={row.columns} api={api} />
    </section>
  );
}

function EditColumns({ columns, api, inner }: { columns: Column[]; api: EditApi; inner?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-3", inner ? "sm:flex-row" : "lg:flex-row")}>
      {columns.map((c, i) => (
        <EditColumn key={c.id} column={c} siblings={columns.length} resizable={i < columns.length - 1} api={api} inner={inner} />
      ))}
    </div>
  );
}

function EditColumn({ column, siblings, resizable, api, inner }: { column: Column; siblings: number; resizable: boolean; api: EditApi; inner?: boolean }) {
  const { drag, drop, change } = api;
  const ref = React.useRef<HTMLDivElement>(null);
  const [preview, setPreview] = React.useState<number | null>(null);
  const width = preview ?? column.width;

  // Drag the right edge: each step of one column's current share adds or takes one unit of width.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const unit = el.getBoundingClientRect().width / column.width;
    const startX = e.clientX;
    let next = column.width;
    const move = (ev: PointerEvent) => {
      next = Math.max(1, Math.min(MAX_WIDTH, Math.round(column.width + (ev.clientX - startX) / unit)));
      setPreview(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPreview(null);
      if (next !== column.width) change((l) => patchColumn(l, column.id, { width: next }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // A row can't be dropped into an inner row's column; let the event reach the row around it.
  const accepts = drag !== null && drag.kind !== "row" && !(inner && drag.kind === "inner");
  const target = drop && "at" in drop && drop.at.columnId === column.id ? drop.at.index : null;
  return (
    <div
      ref={ref}
      style={{ flexGrow: width }}
      data-column={column.id}
      data-count={column.items.length}
      data-inner={inner ? "1" : undefined}
      className={cn(
        "relative flex min-w-0 flex-col gap-3 rounded-xl p-1.5",
        preview !== null && "ring-2 ring-accent",
        inner ? "sm:basis-0" : "lg:basis-0",
        "bg-[repeating-linear-gradient(135deg,transparent_0_6px,color-mix(in_oklab,var(--line)_55%,transparent)_6px_7px)]",
      )}
    >
      {resizable && (
        <span
          role="separator"
          aria-orientation="vertical"
          title="Drag to change the width"
          onPointerDown={startResize}
          className={cn("group/handle absolute top-0 -right-3 bottom-0 z-10 w-3 cursor-col-resize items-center justify-center", inner ? "hidden sm:flex" : "hidden lg:flex")}
        >
          <span className={cn("h-10 w-1 rounded-full bg-line-strong transition-colors group-hover/handle:bg-accent", preview !== null && "bg-accent")} />
        </span>
      )}
      {siblings > 1 && (
        <div className={cn("items-center justify-between gap-2 px-1 text-[11px] text-faint", inner ? "hidden sm:flex" : "hidden lg:flex")}>
          <span>Width</span>
          <span className="flex items-center gap-0.5 rounded-md border border-line bg-surface">
            <button
              type="button"
              title="Narrower"
              disabled={column.width <= 1}
              onClick={() => change((l) => patchColumn(l, column.id, { width: column.width - 1 }))}
              className="flex size-5 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:opacity-30"
            >
              <Minus className="size-3" />
            </button>
            <span className="w-3 text-center font-mono text-fg-2 tabular-nums">{width}</span>
            <button
              type="button"
              title="Wider"
              disabled={column.width >= MAX_WIDTH}
              onClick={() => change((l) => patchColumn(l, column.id, { width: column.width + 1 }))}
              className="flex size-5 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:opacity-30"
            >
              <Plus className="size-3" />
            </button>
          </span>
        </div>
      )}
      {column.items.map((it, i) => {
        const side = target === i ? "before" : target === i + 1 && i === column.items.length - 1 ? "after" : null;
        const place = { "data-item": "", "data-index": i, "data-column-id": column.id, "data-inner": inner ? "1" : undefined };
        const moves = {
          up: i > 0 ? () => change((l) => moveItem(l, it.id, { columnId: column.id, index: i - 1 })) : undefined,
          down: i < column.items.length - 1 ? () => change((l) => moveItem(l, it.id, { columnId: column.id, index: i + 2 })) : undefined,
        };
        return it.kind === "widget" ? (
          <EditWidget key={it.id} widget={it} api={api} side={side} place={place} moves={moves} />
        ) : (
          <EditInnerRow key={it.id} row={it} api={api} side={side} place={place} moves={moves} />
        );
      })}
      <button
        type="button"
        onClick={() => api.openAdd(column.id, Boolean(inner))}
        className={cn(
          "flex min-h-12 items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong bg-bg/40 text-[12.5px] font-medium text-muted transition-colors hover:border-fg/30 hover:bg-hover/50 hover:text-fg",
          target === column.items.length && column.items.length === 0 && "border-accent bg-accent/5 text-fg",
        )}
      >
        <Plus className="size-3.5" /> {accepts ? "Drop here" : "Add"}
      </button>
    </div>
  );
}

type Moves = { up?: () => void; down?: () => void };

const sideClass = (side: "before" | "after" | null) => (side === "before" ? "shadow-[0_-3px_0_0_var(--accent)]" : side === "after" ? "shadow-[0_3px_0_0_var(--accent)]" : "");

function ItemMenu({ item, moves, api, onSettings }: { item: Item; moves: Moves; api: EditApi; onSettings?: () => void }) {
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="icon-sm" title="More" />}>
        <MoreHorizontal />
      </MenuTrigger>
      <MenuContent>
        {onSettings && (
          <MenuItem onClick={onSettings}>
            <Settings2 /> Settings
          </MenuItem>
        )}
        <MenuItem disabled={!moves.up} onClick={moves.up}>
          <ArrowUp /> Move up
        </MenuItem>
        <MenuItem disabled={!moves.down} onClick={moves.down}>
          <ArrowDown /> Move down
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={() =>
            api.change((l) => {
              const found = findItem(l, item.id);
              return found ? insertItem(l, { columnId: found.columnId, index: found.index + 1 }, cloneItem(found.item)) : l;
            })
          }
        >
          <Copy /> Duplicate
        </MenuItem>
        <MenuItem danger onClick={() => api.change((l) => removeItem(l, item.id))}>
          <Trash2 /> Remove
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

type Place = Record<string, string | number | undefined>;

function EditInnerRow({ row, api, side, place, moves }: { row: InnerRow; api: EditApi; side: "before" | "after" | null; place: Place; moves: Moves }) {
  const ref = React.useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      {...place}
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-line-strong bg-surface-2/60 p-1.5 transition-[opacity,box-shadow]",
        api.drag?.id === row.id && "opacity-40",
        sideClass(side),
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          onPointerDown={(e) => {
            e.stopPropagation();
            api.startDrag(e, "inner", row.id, row.title || "Row");
          }}
          title="Drag to move"
          className="flex h-7 flex-none cursor-grab touch-none items-center gap-1 rounded-md px-1 text-[12px] font-medium text-muted hover:bg-hover active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" /> <Columns2 className="size-3.5" />
        </span>
        <ColsPicker value={row.columns.length} max={3} onChange={(n) => api.change((l) => patchItem(l, row.id, { columns: setColumnCount(row.columns, n) }))} />
        <RowTitle row={row} onChange={(title) => api.change((l) => patchItem(l, row.id, { title: title.trim() || undefined }))} />
        <span className="ml-auto">
          <ItemMenu item={row} moves={moves} api={api} />
        </span>
      </div>
      <EditColumns columns={row.columns} api={api} inner />
    </div>
  );
}

function EditWidget({ widget: w, api, side, place, moves }: { widget: Widget; api: EditApi; side: "before" | "after" | null; place: Place; moves: Moves }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const node = api.nodes[w.id];
  const loaded = w.id in api.nodes;
  return (
    <div
      ref={ref}
      {...place}
      className={cn(
        "group/edit flex min-w-0 flex-col gap-1.5 rounded-xl transition-[opacity,box-shadow]",
        w.fill && "flex-1",
        api.drag?.id === w.id && "opacity-40",
        sideClass(side),
      )}
    >
      <div
        onPointerDown={(e) => api.startDrag(e, "widget", w.id, widgetTitle(w))}
        className="flex h-8 cursor-grab touch-none items-center gap-1.5 rounded-lg border border-line bg-surface-2 pr-0.5 pl-2 shadow-sm transition-colors group-hover/edit:border-line-strong active:cursor-grabbing"
        title="Drag to move"
      >
        <GripVertical className="size-3.5 flex-none text-faint" />
        <WidgetIcon type={w.type} className="size-3.5 flex-none text-muted" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg-2">{widgetTitle(w)}</span>
        <Button variant="ghost" size="icon-sm" title="Widget settings" onClick={() => api.openSettings(w.id)}>
          <Settings2 />
        </Button>
        <ItemMenu item={w} moves={moves} api={api} />
      </div>
      <div className={cn("pointer-events-none flex min-h-0 flex-col select-none", w.fill && "flex-1 [&>*]:flex-1")} inert>
        {!loaded ? (
          <div className="flex min-h-20 flex-1 items-center justify-center gap-2 text-xs text-faint">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        ) : node == null ? (
          <div className="flex min-h-20 flex-1 items-center justify-center rounded-lg border border-dashed border-line px-4 py-5 text-center text-xs leading-relaxed text-muted">
            {WIDGETS[w.type].emptyHint ?? "Nothing to show right now."}
          </div>
        ) : (
          node
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ smaller parts */

/** The row's heading, typed in place. Saved when the field loses focus or on Enter. */
function RowTitle({ row, onChange }: { row: { title?: string }; onChange: (title: string) => void }) {
  const [value, setValue] = React.useState(row.title ?? "");
  React.useEffect(() => setValue(row.title ?? ""), [row.title]);
  const commit = () => value.trim() !== (row.title ?? "") && onChange(value);
  return (
    <input
      aria-label="Row title"
      value={value}
      maxLength={60}
      placeholder="Add a row title"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setValue(row.title ?? "");
          e.currentTarget.blur();
        }
      }}
      className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 font-display text-[14px] font-semibold text-fg outline-none placeholder:font-sans placeholder:text-[13px] placeholder:font-normal placeholder:text-faint hover:border-line focus:border-accent focus:bg-surface sm:max-w-xs"
    />
  );
}

/** A slot between rows. Always there while customizing, so nothing moves when a drag starts. */
function NewRowDrop({ index, active, over }: { index: number; active: boolean; over: boolean }) {
  return (
    <div
      data-new-row={active ? index : undefined}
      aria-hidden
      className={cn(
        "-my-1.5 flex h-6 items-center justify-center rounded-lg border border-dashed text-[11px] font-medium transition-colors",
        over ? "border-accent bg-accent/5 text-fg" : active ? "border-line-strong text-faint" : "border-transparent text-transparent",
      )}
    >
      New row
    </div>
  );
}

function AddRowMenu({ onAdd }: { onAdd: (cols: number) => void }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className="flex h-12 items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-[13px] font-medium text-muted transition-colors hover:border-fg/30 hover:bg-hover/50 hover:text-fg"
          />
        }
      >
        <Plus className="size-4" /> Add row
      </MenuTrigger>
      <MenuContent align="center">
        {Array.from({ length: MAX_COLS }, (_, i) => i + 1).map((n) => (
          <MenuItem key={n} onClick={() => onAdd(n)}>
            <span className="flex w-8 gap-[2px]" aria-hidden>
              {Array.from({ length: n }, (_, j) => (
                <span key={j} className="h-3 flex-1 rounded-[2px] bg-fg/40" />
              ))}
            </span>
            {n} {n === 1 ? "column" : "columns"}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function EditBar({ saving, onReset, onDone }: { saving: "idle" | "saving" | "saved" | "error"; onReset: () => void; onDone: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border border-line bg-surface/95 py-1.5 pr-1.5 pl-4 shadow-lg backdrop-blur-xl">
        <span className="hidden text-[13px] font-medium text-fg sm:inline">Customizing</span>
        <span className="flex min-w-16 items-center gap-1.5 text-xs text-muted" aria-live="polite">
          {saving === "saving" ? (
            <>
              <Loader2 className="size-3 animate-spin" /> Saving
            </>
          ) : saving === "saved" ? (
            <>
              <Check className="size-3" /> Saved
            </>
          ) : saving === "error" ? (
            <span className="text-bad">Not saved</span>
          ) : (
            "Drag to move"
          )}
        </span>
        <Button variant="ghost" size="sm" onClick={onReset}>
          <RotateCcw /> Reset
        </Button>
        <Button variant="primary" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function AddWidgetDialog({ open, inner, onOpenChange, onPick }: { open: boolean; inner: boolean; onOpenChange: (o: boolean) => void; onPick: (type: WidgetType | "row") => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader title="Add to this column" description="Pick a widget. You can change its look in its settings afterwards." />
        <DialogBody>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {!inner && (
              <button
                type="button"
                onClick={() => onPick("row")}
                className="flex items-start gap-3 rounded-xl border border-dashed border-line-strong bg-surface p-3 text-left transition-colors hover:border-fg/30 hover:bg-hover/60 focus-visible:border-accent focus-visible:outline-none sm:col-span-2"
              >
                <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-sunken text-fg-2">
                  <Columns2 className="size-4" />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13.5px] font-medium text-fg">Row</span>
                  <span className="text-xs leading-relaxed text-muted">Split this column into smaller columns, to put small widgets side by side.</span>
                </span>
              </button>
            )}
            {WIDGET_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => onPick(type)}
                className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:border-line-strong hover:bg-hover/60 focus-visible:border-accent focus-visible:outline-none"
              >
                <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-sunken text-fg-2">
                  <WidgetIcon type={type} className="size-4" />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13.5px] font-medium text-fg">{WIDGETS[type].name}</span>
                  <span className="text-xs leading-relaxed text-muted">{WIDGETS[type].description}</span>
                </span>
              </button>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-fit items-center rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("h-7 rounded-md px-3 text-[13px] font-medium transition-colors", value === o.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const PRESET_LINKS = [
  { label: "Projects", href: "/projects" },
  { label: "Servers", href: "/servers" },
  { label: "Templates", href: "/templates" },
  { label: "Domains", href: "/domains" },
  { label: "Monitoring", href: "/monitoring" },
  { label: "Activity", href: "/activity" },
  { label: "Account", href: "/account" },
];

function WidgetSettings({ widget, projects, servers, onClose, onSave }: { widget: Widget; onClose: () => void; onSave: (w: Widget) => void } & Choices) {
  const [draft, setDraft] = React.useState<Widget>(widget);
  const [error, setError] = React.useState<string | null>(null);
  const meta = WIDGETS[widget.type];
  const set = (patch: Partial<Widget>) => setDraft((d) => ({ ...d, ...patch }));
  const setOption = (patch: Partial<Widget["options"]>) => setDraft((d) => ({ ...d, options: { ...d.options, ...patch } }));
  const links = draft.options.links ?? [];

  const save = () => {
    const clean: Widget = {
      ...draft,
      title: draft.title?.trim() || undefined,
      options: { ...draft.options, links: draft.options.links?.filter((l) => l.label.trim() || l.href.trim()) },
    };
    const parsed = widgetSchema.safeParse(clean);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the values");
      return;
    }
    onSave(parsed.data as Widget);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader title={`${meta.name} settings`} description={meta.description} />
        <DialogBody>
          <Field label="Title" optional>
            <Input
              value={draft.title ?? ""}
              placeholder={widget.type === "project" || widget.type === "server" ? "The project or server name" : meta.name}
              onChange={(e) => set({ title: e.target.value })}
              maxLength={60}
            />
          </Field>

          {widget.type === "project" && (
            <Field label="Project">
              <Select
                value={draft.options.projectId ?? null}
                onValueChange={(v) => setOption({ projectId: v })}
                options={projects.map((p) => ({ value: p.id, label: p.name }))}
                placeholder="Pick a project"
              />
            </Field>
          )}
          {widget.type === "server" && (
            <Field label="Server">
              <Select
                value={draft.options.serverId ?? null}
                onValueChange={(v) => setOption({ serverId: v })}
                options={servers.map((s) => ({ value: s.id, label: s.name }))}
                placeholder="Pick a server"
              />
            </Field>
          )}
          {widget.type === "activity" && (
            <Field label="Period">
              <Segmented
                label="Period"
                value={draft.options.weeks ?? 26}
                options={ACTIVITY_WEEKS.map((n) => ({ value: n, label: n === 52 ? "1 year" : `${n} weeks` }))}
                onChange={(v) => setOption({ weeks: v })}
              />
            </Field>
          )}
          {widget.type === "note" && (
            <Field label="Note" description="Plain text. Only you see it.">
              <Textarea
                rows={6}
                value={draft.options.text ?? ""}
                onChange={(e) => setOption({ text: e.target.value })}
                maxLength={4000}
                placeholder="Things to check, a deploy checklist, anything."
              />
            </Field>
          )}
          {widget.type === "shortcuts" && (
            <Field label="Links" description="A path inside Serve, like /servers, or a full web address.">
              <div className="flex flex-col gap-2">
                {links.map((l, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      aria-label="Name"
                      value={l.label}
                      placeholder="Name"
                      className="w-[38%]"
                      maxLength={40}
                      onChange={(e) => setOption({ links: links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                    />
                    <Input
                      aria-label="Address"
                      value={l.href}
                      placeholder="https://… or /servers"
                      onChange={(e) => setOption({ links: links.map((x, j) => (j === i ? { ...x, href: e.target.value } : x)) })}
                    />
                    <Button variant="ghost" size="icon" title="Remove link" onClick={() => setOption({ links: links.filter((_, j) => j !== i) })}>
                      <X />
                    </Button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button size="xs" onClick={() => setOption({ links: [...links, { label: "", href: "" }] })} disabled={links.length >= 16}>
                    <Plus /> Add link
                  </Button>
                  {PRESET_LINKS.filter((p) => !links.some((l) => l.href === p.href)).map((p) => (
                    <button
                      key={p.href}
                      type="button"
                      disabled={links.length >= 16}
                      onClick={() => setOption({ links: [...links, p] })}
                      className="h-7 rounded-lg border border-dashed border-line-strong px-2 text-xs text-muted transition-colors hover:border-fg/30 hover:text-fg"
                    >
                      + {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </Field>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Look">
              <Segmented
                label="Look"
                value={draft.frame}
                options={[
                  { value: "card", label: "Card" },
                  { value: "plain", label: "No card" },
                ]}
                onChange={(v) => set({ frame: v })}
              />
            </Field>
            {meta.limit && (
              <Field label="Most items" description={`Up to ${meta.limit.max}.`}>
                <Input
                  type="number"
                  min={1}
                  max={meta.limit.max}
                  className="w-24"
                  value={draft.limit ?? meta.limit.default}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    const max = meta.limit?.max ?? 50;
                    set({ limit: Number.isFinite(n) ? Math.max(1, Math.min(max, Math.round(n))) : undefined });
                  }}
                />
              </Field>
            )}
          </div>
          <label className="flex items-center justify-between gap-4 rounded-xl border border-line px-3 py-2.5">
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium text-fg">Fill the space</span>
              <span className="text-xs text-muted">Grow to the bottom of its column when a column beside it is taller.</span>
            </span>
            <Switch checked={draft.fill} onCheckedChange={(v) => set({ fill: v })} />
          </label>
          {error && <p className="text-xs text-bad">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
