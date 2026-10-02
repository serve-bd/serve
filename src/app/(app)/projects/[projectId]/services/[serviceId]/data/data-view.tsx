"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Database, Eye, FileJson, KeyRound, Play, RotateCw, Search, ShieldAlert, Table2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/code-editor";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge, Card, CardHeader, CopyButton, EmptyState, Kbd, Skeleton } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/switch";
import { Tab, Tabs, TabsList } from "@/components/ui/tabs";
import { cn, formatBytes } from "@/lib/utils";
import type { ActionResult } from "@/server/action";
import {
  type Cell,
  type DocumentsPage,
  type ExplorerOverview,
  type ExplorerQueryResult,
  explorerKey,
  explorerKeys,
  explorerOverview,
  explorerQuery,
  explorerRows,
  explorerStructure,
  type KeyInfo,
  type KeyValue,
  type RowsPage,
  type Structure,
} from "@/server/actions/database-explorer";

type Family = ExplorerOverview["family"];
type TableRef = { schema: string | null; name: string };
type FilterOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "contains" | "null" | "notnull";

const PAGE_SIZE = 50;
const number = new Intl.NumberFormat("en-US");
const count = (n: number | null | undefined) => (n === null || n === undefined ? "" : number.format(n));

/** Runs server reads in order: an answer to an older request is dropped. */
function useRead<T>() {
  const [state, setState] = React.useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });
  const seq = React.useRef(0);
  const run = React.useCallback(async (request: () => Promise<ActionResult<T>>) => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    let res: ActionResult<T>;
    try {
      res = await request();
    } catch (e) {
      res = { ok: false, error: (e as Error).message || "The request failed." };
    }
    if (id !== seq.current) return null;
    setState(res.ok ? { data: res.data, error: null, loading: false } : { data: null, error: res.error, loading: false });
    return res.ok ? res.data : null;
  }, []);
  const clear = React.useCallback(() => {
    seq.current++;
    setState({ data: null, error: null, loading: false });
  }, []);
  return [state, run, clear] as const;
}

export function DataBrowser({
  serviceId,
  serviceName,
  engine,
  running,
  error,
  initial,
}: {
  serviceId: string;
  serviceName: string;
  engine: string;
  running: boolean;
  error: string | null;
  initial: ExplorerOverview | null;
}) {
  const confirm = useConfirm();
  const [readOnly, setReadOnly] = React.useState(true);
  const [tab, setTab] = React.useState<"browse" | "query">("browse");
  const [overview, setOverview] = React.useState(initial);
  const [loadError, setLoadError] = React.useState(error);
  const [loading, setLoading] = React.useState(false);
  const family: Family = overview?.family ?? (engine === "mongodb" ? "mongo" : engine === "redis" || engine === "valkey" ? "kv" : "sql");

  const load = async (database: string | null) => {
    setLoading(true);
    const res = await explorerOverview(serviceId, database).catch((e: Error) => ({ ok: false as const, error: e.message }));
    setLoading(false);
    if (res.ok) {
      setOverview(res.data);
      setLoadError(null);
    } else setLoadError(res.error);
  };

  const toggleReadOnly = async (on: boolean) => {
    if (on) return setReadOnly(true);
    const ok = await confirm({
      title: "Allow changes?",
      description:
        family === "kv"
          ? "Commands can then write and delete keys. Each command you run is written to the activity log."
          : family === "mongo"
            ? "Insert, update and delete become available, and pipelines may write with $out and $merge. Each operation you run is written to the activity log."
            : "Queries can then add, change and delete rows, and change or drop tables. Each query you run is written to the activity log.",
      confirmLabel: "Allow changes",
      danger: true,
    });
    if (ok) setReadOnly(false);
  };

  const databases = overview?.databases ?? [];
  const databaseLabel = (d: { name: string; size: number | null }) =>
    family === "kv" ? `Database ${d.name}${d.size ? ` · ${count(d.size)} ${d.size === 1 ? "key" : "keys"}` : ""}` : d.name;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Data"
          description={`Browse and query the data inside ${serviceName}. Read only mode keeps it safe from changes.`}
          actions={
            running &&
            overview && (
              <div className="flex items-center gap-2.5">
                {!readOnly && (
                  <Badge tone="warn">
                    <ShieldAlert /> Changes allowed
                  </Badge>
                )}
                <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-fg-2">
                  <Switch checked={readOnly} onCheckedChange={(v) => void toggleReadOnly(v)} aria-label="Read only" />
                  Read only
                </label>
              </div>
            )
          }
        />
        {!running ? (
          <EmptyState icon={<Database />} title="The database is not running" description="The data is read from the running database. Start it to browse and query it." />
        ) : !overview ? (
          <div className="flex flex-col items-start gap-3 px-5 py-4">
            <p className="text-sm whitespace-pre-wrap text-bad">{loadError ?? "Could not read the database."}</p>
            <Button size="sm" loading={loading} onClick={() => void load(null)}>
              <RotateCw /> Try again
            </Button>
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(v) => setTab(v as "browse" | "query")}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 sm:px-5">
              <TabsList>
                <Tab value="browse">
                  <Table2 /> Browse
                </Tab>
                <Tab value="query">
                  <Play /> Query
                </Tab>
              </TabsList>
              {(databases.length > 1 || family === "kv") && (
                <Select
                  size="sm"
                  aria-label="Database"
                  className="w-auto min-w-40 max-w-full"
                  value={overview.database}
                  onValueChange={(v) => void load(v)}
                  options={(family === "kv" ? kvDatabases(databases) : databases).map((d) => ({
                    value: d.name,
                    label: databaseLabel(d),
                    description: family !== "kv" && d.size ? formatBytes(d.size) : undefined,
                  }))}
                />
              )}
            </div>
            {loadError && <p className="border-b border-line px-5 py-2.5 text-sm text-bad">{loadError}</p>}
            <div className={cn(loading && "pointer-events-none opacity-60 transition-opacity")}>
              {tab === "browse" ? (
                family === "kv" ? (
                  <KvBrowser key={`kv-${overview.database}`} serviceId={serviceId} database={overview.database} />
                ) : (
                  <TableBrowser key={`${family}-${overview.database}`} serviceId={serviceId} overview={overview} family={family} onRefresh={() => void load(overview.database)} />
                )
              ) : (
                <QueryPanel key={`q-${overview.database}`} serviceId={serviceId} engine={engine} family={family} overview={overview} readOnly={readOnly} />
              )}
            </div>
          </Tabs>
        )}
      </Card>
      <p className="px-1 text-xs leading-relaxed text-muted">
        Like the console, this page needs the console permission. Queries run as Serve&apos;s own login, stop after 30 seconds and show up to 1,000 rows.
      </p>
    </div>
  );
}

/** Databases 0 to 15 of a Redis or Valkey server, with the key counts of the ones that have keys. */
function kvDatabases(found: { name: string; size: number | null }[]) {
  const max = Math.max(15, ...found.map((d) => Number(d.name)));
  return Array.from({ length: max + 1 }, (_, i) => found.find((d) => d.name === String(i)) ?? { name: String(i), size: 0 });
}

/* ------------------------------------------------------------ Tables and collections */

function TableBrowser({ serviceId, overview, family, onRefresh }: { serviceId: string; overview: ExplorerOverview; family: Family; onRefresh: () => void }) {
  const tables = overview.tables;
  const [selected, setSelected] = React.useState<TableRef | null>(tables[0] ? { schema: tables[0].schema, name: tables[0].name } : null);
  const [search, setSearch] = React.useState("");
  const keyOf = (t: TableRef) => `${t.schema ?? ""}\u0000${t.name}`;
  const shown = tables.filter((t) => !search || t.name.toLowerCase().includes(search.toLowerCase()));
  const schemas = [...new Set(shown.map((t) => t.schema))];
  const noun = family === "mongo" ? "collection" : "table";
  const current = selected ? tables.find((t) => keyOf(t) === keyOf(selected)) : undefined;

  if (!tables.length) {
    return (
      <EmptyState
        icon={<Table2 />}
        title={`No ${noun}s in ${overview.database}`}
        description={family === "mongo" ? "Collections appear here once they have documents." : "Tables appear here once they are created, for example from the Query tab."}
        action={
          <Button size="sm" onClick={onRefresh}>
            <RotateCw /> Refresh
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="hidden max-h-[44rem] flex-col border-r border-line lg:flex">
        <div className="flex items-center gap-1.5 border-b border-line p-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Find a ${noun}`} className="h-8 pl-8 text-[13px]" aria-label={`Find a ${noun}`} />
          </div>
          <Button size="icon-sm" variant="ghost" onClick={onRefresh} aria-label={`Refresh the ${noun}s`} title="Refresh">
            <RotateCw />
          </Button>
        </div>
        <nav className="scrollbar-thin flex-1 overflow-y-auto p-1.5">
          {schemas.map((schema) => (
            <div key={schema ?? ""} className="mb-1">
              {schema !== null && overview.schemas.length > 1 && <p className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{schema}</p>}
              {shown
                .filter((t) => t.schema === schema)
                .map((t) => {
                  const active = !!selected && keyOf(t) === keyOf(selected);
                  return (
                    <button
                      key={keyOf(t)}
                      type="button"
                      onClick={() => setSelected({ schema: t.schema, name: t.name })}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                        active ? "bg-accent-soft text-accent-strong" : "text-fg-2 hover:bg-hover hover:text-fg",
                      )}
                    >
                      {t.kind.includes("view") ? (
                        <Eye className="size-3.5 flex-none opacity-60" />
                      ) : family === "mongo" ? (
                        <FileJson className="size-3.5 flex-none opacity-60" />
                      ) : (
                        <Table2 className="size-3.5 flex-none opacity-60" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{t.name}</span>
                      {t.rows !== null && <span className="flex-none text-[11px] text-faint tabular-nums">{compact(t.rows)}</span>}
                    </button>
                  );
                })}
            </div>
          ))}
          {!shown.length && <p className="px-2 py-3 text-[13px] text-muted">No {noun} matches.</p>}
        </nav>
      </aside>
      <div className="min-w-0">
        <div className="border-b border-line p-3 lg:hidden">
          <Combobox
            size="sm"
            value={selected ? keyOf(selected) : null}
            onValueChange={(v) => {
              const t = tables.find((x) => keyOf(x) === v);
              if (t) setSelected({ schema: t.schema, name: t.name });
            }}
            placeholder={`Find a ${noun}`}
            options={tables.map((t) => ({
              value: keyOf(t),
              label: t.schema && overview.schemas.length > 1 ? `${t.schema}.${t.name}` : t.name,
              description: t.rows !== null ? `${count(t.rows)} rows` : undefined,
            }))}
          />
        </div>
        {selected && current ? (
          <TableView
            key={keyOf(selected)}
            serviceId={serviceId}
            database={overview.database}
            table={selected}
            family={family}
            info={current}
            showSchema={overview.schemas.length > 1}
          />
        ) : (
          <EmptyState icon={<Table2 />} title={`Choose a ${noun}`} />
        )}
      </div>
    </div>
  );
}

/** Large counts in a few characters, for the table list. */
function compact(n: number) {
  return n < 10_000 ? number.format(n) : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function TableView({
  serviceId,
  database,
  table,
  family,
  info,
  showSchema,
}: {
  serviceId: string;
  database: string;
  table: TableRef;
  family: Family;
  info: ExplorerOverview["tables"][number];
  showSchema: boolean;
}) {
  const [view, setView] = React.useState<"rows" | "structure">("rows");
  const [structure, loadStructure] = useRead<Structure>();
  const ref = React.useMemo(() => ({ database, schema: table.schema, table: table.name }), [database, table.schema, table.name]);

  React.useEffect(() => {
    void loadStructure(() => explorerStructure(serviceId, ref));
  }, [serviceId, ref, loadStructure]);

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h4 className="min-w-0 font-mono text-[14px] font-semibold break-all text-fg">
            {showSchema && table.schema ? <span className="text-muted">{table.schema}.</span> : null}
            {table.name}
          </h4>
          <p className="text-xs text-muted">
            {[info.kind, info.rows !== null ? `about ${count(info.rows)} ${family === "mongo" ? "documents" : "rows"}` : null, info.bytes ? formatBytes(info.bytes) : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <Tabs value={view} onValueChange={(v) => setView(v as "rows" | "structure")}>
          <TabsList>
            <Tab value="rows">{family === "mongo" ? "Documents" : "Rows"}</Tab>
            <Tab value="structure">Structure</Tab>
          </TabsList>
        </Tabs>
      </div>
      {view === "rows" ? (
        family === "mongo" ? (
          <DocumentsView serviceId={serviceId} reference={ref} />
        ) : (
          <RowsView serviceId={serviceId} reference={ref} columns={structure.data?.columns.map((c) => c.name) ?? []} />
        )
      ) : (
        <StructureView state={structure} family={family} />
      )}
    </div>
  );
}

const FILTER_LABELS: { value: FilterOp; label: string }[] = [
  { value: "eq", label: "equals" },
  { value: "ne", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "lt", label: "less than" },
  { value: "le", label: "at most" },
  { value: "gt", label: "more than" },
  { value: "ge", label: "at least" },
  { value: "null", label: "is NULL" },
  { value: "notnull", label: "is not NULL" },
];

function RowsView({ serviceId, reference, columns }: { serviceId: string; reference: { database: string; schema: string | null; table: string }; columns: string[] }) {
  const [page, setPage] = React.useState(0);
  const [sort, setSort] = React.useState<{ column: string; desc: boolean } | null>(null);
  const [filter, setFilter] = React.useState<{ column: string; op: FilterOp; value: string } | null>(null);
  const [draft, setDraft] = React.useState<{ column: string; op: FilterOp; value: string }>({ column: "", op: "eq", value: "" });
  const [rows, loadRows] = useRead<RowsPage | DocumentsPage>();
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    void reload;
    void loadRows(() => explorerRows(serviceId, { ...reference, page, sort, filter }));
  }, [serviceId, reference, page, sort, filter, loadRows, reload]);

  const data = rows.data && "rows" in rows.data ? rows.data : null;
  const shownColumns = data?.columns.length ? data.columns : columns;
  const column = draft.column || shownColumns[0] || "";
  const needsValue = draft.op !== "null" && draft.op !== "notnull";
  const apply = () => {
    if (!column) return;
    setPage(0);
    setFilter({ column, op: draft.op, value: draft.value });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <Select
          size="sm"
          aria-label="Column"
          className="w-auto max-w-full min-w-32 flex-1 sm:flex-none"
          value={column || null}
          placeholder="Column"
          onValueChange={(v) => setDraft((d) => ({ ...d, column: v }))}
          options={shownColumns.map((c) => ({ value: c, label: c }))}
        />
        <Select
          size="sm"
          aria-label="Condition"
          className="w-auto min-w-28"
          value={draft.op}
          onValueChange={(v) => setDraft((d) => ({ ...d, op: v as FilterOp }))}
          options={FILTER_LABELS}
        />
        {needsValue && (
          <Input
            value={draft.value}
            onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
            placeholder="Value"
            className="h-8 min-w-32 flex-1 text-[13px]"
            aria-label="Value"
          />
        )}
        <Button size="sm" type="submit" disabled={!column}>
          Filter
        </Button>
        {filter && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilter(null);
              setPage(0);
            }}
          >
            <X /> Clear
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" className="ml-auto" onClick={() => setReload((n) => n + 1)} aria-label="Refresh the rows" title="Refresh">
          <RotateCw className={cn(rows.loading && "animate-spin")} />
        </Button>
      </form>
      {filter && (
        <p className="text-xs text-muted">
          Rows where <span className="font-mono text-fg-2">{filter.column}</span> {FILTER_LABELS.find((f) => f.value === filter.op)?.label}
          {filter.op !== "null" && filter.op !== "notnull" && (
            <>
              {" "}
              <span className="font-mono text-fg-2">{JSON.stringify(filter.value)}</span>
            </>
          )}
        </p>
      )}
      {rows.error ? (
        <ErrorBox message={rows.error} />
      ) : !data ? (
        <TableSkeleton />
      ) : (
        <>
          <ResultTable
            columns={shownColumns}
            rows={data.rows}
            loading={rows.loading}
            sort={sort}
            onSort={(c) => {
              setPage(0);
              setSort((s) => (s?.column !== c ? { column: c, desc: false } : s.desc ? null : { column: c, desc: true }));
            }}
            empty={filter ? "No rows match the filter." : "This table has no rows."}
          />
          {data.truncated && <p className="text-xs text-warn">Some values were too large and the page was cut short. Use the Query tab to choose fewer columns.</p>}
          <Pager page={page} shown={data.rows.length} total={data.total} capped={data.totalCapped} loading={rows.loading} onPage={setPage} noun="rows" />
        </>
      )}
    </div>
  );
}

function DocumentsView({ serviceId, reference }: { serviceId: string; reference: { database: string; schema: string | null; table: string } }) {
  const [page, setPage] = React.useState(0);
  const [applied, setApplied] = React.useState({ filter: "", sort: "" });
  const [draft, setDraft] = React.useState({ filter: "", sort: "" });
  const [docs, loadDocs] = useRead<RowsPage | DocumentsPage>();
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    void reload;
    void loadDocs(() => explorerRows(serviceId, { ...reference, page, mongoFilter: applied.filter, mongoSort: applied.sort }));
  }, [serviceId, reference, page, applied, loadDocs, reload]);

  const data = docs.data && "documents" in docs.data ? docs.data : null;
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(0);
          setApplied(draft);
        }}
      >
        <Input
          value={draft.filter}
          onChange={(e) => setDraft((d) => ({ ...d, filter: e.target.value }))}
          placeholder='Filter, like { "status": "active" }'
          className="h-8 min-w-48 flex-[2] font-mono text-[12.5px]"
          aria-label="Filter"
        />
        <Input
          value={draft.sort}
          onChange={(e) => setDraft((d) => ({ ...d, sort: e.target.value }))}
          placeholder='Sort, like { "_id": -1 }'
          className="h-8 min-w-36 flex-1 font-mono text-[12.5px]"
          aria-label="Sort"
        />
        <Button size="sm" type="submit">
          Find
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => setReload((n) => n + 1)} aria-label="Refresh the documents" title="Refresh">
          <RotateCw className={cn(docs.loading && "animate-spin")} />
        </Button>
      </form>
      {docs.error ? (
        <ErrorBox message={docs.error} />
      ) : !data ? (
        <TableSkeleton />
      ) : (
        <>
          <DocumentList documents={data.documents} loading={docs.loading} empty={applied.filter ? "No documents match the filter." : "This collection has no documents."} />
          <Pager page={page} shown={data.documents.length} total={data.total} capped={data.totalCapped} loading={docs.loading} onPage={setPage} noun="documents" />
        </>
      )}
    </div>
  );
}

function StructureView({ state, family }: { state: { data: Structure | null; error: string | null; loading: boolean }; family: Family }) {
  if (state.error) {
    return (
      <div className="p-4 sm:p-5">
        <ErrorBox message={state.error} />
      </div>
    );
  }
  if (!state.data) {
    return (
      <div className="p-4 sm:p-5">
        <TableSkeleton />
      </div>
    );
  }
  const { columns, indexes } = state.data;
  return (
    <div className="flex min-w-0 flex-col gap-5 p-4 sm:p-5">
      <section className="flex min-w-0 flex-col gap-2">
        <h5 className="text-[13px] font-semibold text-fg">{family === "mongo" ? "Fields" : "Columns"}</h5>
        {family === "mongo" && <p className="text-xs text-muted">Seen in the first 100 documents, with their types.</p>}
        <div className="scrollbar-thin overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-max text-[13px]">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Type</th>
                {family !== "mongo" && <th className="px-3 py-2 font-medium">Null</th>}
                {family !== "mongo" && <th className="px-3 py-2 font-medium">Default</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {columns.map((c) => (
                <tr key={c.name}>
                  <td className="px-3 py-2 font-mono text-[12.5px] text-fg">
                    <span className="flex items-center gap-2">
                      {c.name}
                      {c.primaryKey && (
                        <Badge tone="accent">
                          <KeyRound /> {family === "mongo" ? "id" : "primary key"}
                        </Badge>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[12.5px] text-fg-2">{c.type}</td>
                  {family !== "mongo" && <td className="px-3 py-2 text-fg-2">{c.nullable ? "yes" : "no"}</td>}
                  {family !== "mongo" && <td className="max-w-80 truncate px-3 py-2 font-mono text-[12.5px] text-muted">{c.default ?? ""}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!columns.length && <p className="text-[13px] text-muted">No {family === "mongo" ? "documents to read fields from" : "columns"}.</p>}
      </section>
      <section className="flex min-w-0 flex-col gap-2">
        <h5 className="text-[13px] font-semibold text-fg">
          {indexes.some((i) => ["Primary key", "Sorting key", "Partition key"].includes(i.name)) ? "Keys and indexes" : "Indexes"}
        </h5>
        {indexes.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {indexes.map((i) => (
              <li key={i.name} className="flex flex-col gap-1 px-3 py-2.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[12.5px] font-medium text-fg">{i.name}</span>
                  {i.primary ? <Badge tone="accent">primary</Badge> : i.unique ? <Badge tone="info">unique</Badge> : null}
                </span>
                <code className="font-mono text-xs break-all text-muted">{i.definition}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">No indexes.</p>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------- Shared pieces */

function ErrorBox({ message }: { message: string }) {
  return <pre className="rounded-lg border border-bad/30 bg-bad-soft px-3 py-2.5 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-bad">{message}</pre>;
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className={cn("h-5", i === 0 ? "w-1/2" : "w-full")} />
      ))}
    </div>
  );
}

function Pager({
  page,
  shown,
  total,
  capped,
  loading,
  onPage,
  noun,
}: {
  page: number;
  shown: number;
  total: number | null;
  capped: boolean;
  loading: boolean;
  onPage: (page: number) => void;
  noun: string;
}) {
  const from = page * PAGE_SIZE;
  const more = total === null ? shown === PAGE_SIZE : capped || from + shown < total;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
      <span className="tabular-nums">
        {shown ? `${count(from + 1)}–${count(from + shown)}` : "0"}
        {total !== null && ` of ${count(total)}${capped ? "+" : ""} ${noun}`}
      </span>
      <span className="flex items-center gap-1">
        <Button size="xs" variant="ghost" disabled={page === 0 || loading} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft /> Previous
        </Button>
        <Button size="xs" variant="ghost" disabled={!more || loading} onClick={() => onPage(page + 1)} aria-label="Next page">
          Next <ChevronRight />
        </Button>
      </span>
    </div>
  );
}

/** Rows in a box that scrolls on its own; a click on a value shows all of it. */
function ResultTable({
  columns,
  rows,
  loading,
  sort,
  onSort,
  empty,
  first,
}: {
  columns: string[];
  rows: Cell[][];
  loading?: boolean;
  sort?: { column: string; desc: boolean } | null;
  onSort?: (column: string) => void;
  empty: string;
  /** Pairs and lists: the first column is a label (field, index), not data. */
  first?: "label";
}) {
  const [open, setOpen] = React.useState<{ column: string; value: Cell } | null>(null);
  return (
    <>
      <div className={cn("scrollbar-thin max-h-[36rem] overflow-auto rounded-lg border border-line transition-opacity", loading && "opacity-60")}>
        <table className="w-max min-w-full border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr>
              {columns.map((c, i) => {
                const sorted = sort?.column === c ? sort : null;
                return (
                  <th
                    key={`${i}-${c}`}
                    className="sticky top-0 z-10 border-b border-line bg-surface-2 px-3 py-2 text-left font-medium whitespace-nowrap text-fg-2"
                    aria-sort={sorted ? (sorted.desc ? "descending" : "ascending") : undefined}
                  >
                    {onSort ? (
                      <button type="button" onClick={() => onSort(c)} className="flex items-center gap-1 font-mono hover:text-fg">
                        {c}
                        {sorted ? sorted.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" /> : null}
                      </button>
                    ) : (
                      <span className="font-mono">{c}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="hover:bg-hover/60">
                {columns.map((c, i) => {
                  const v = row[i] ?? null;
                  return (
                    <td key={`${i}-${c}`} className="border-b border-line/70 p-0">
                      <button
                        type="button"
                        onClick={() => setOpen({ column: c, value: v })}
                        className={cn(
                          "block max-w-[22rem] min-w-0 truncate px-3 py-1.5 text-left font-mono",
                          v === null ? "text-faint italic" : first === "label" && i === 0 ? "text-muted" : "text-fg",
                        )}
                        title={v !== null && v.length > 40 ? "Show all" : undefined}
                      >
                        {v === null ? "NULL" : v === "" ? " " : v.replace(/\n/g, "↵ ")}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="px-3 py-6 text-center text-[13px] text-muted">{empty}</p>}
      </div>
      {open && <ValueDialog title={open.column} value={open.value} onClose={() => setOpen(null)} />}
    </>
  );
}

function ValueDialog({ title, value, onClose }: { title: string; value: Cell; onClose: () => void }) {
  const pretty = React.useMemo(() => {
    if (value === null) return null;
    const t = value.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {}
    }
    return value;
  }, [value]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader title={<span className="font-mono break-all">{title}</span>} description={value === null ? "NULL" : `${count(value.length)} characters`} />
        <DialogBody className="flex flex-col gap-2">
          {pretty !== null && (
            <>
              <pre className="scrollbar-thin max-h-[60vh] overflow-auto rounded-lg border border-line bg-sunken p-3 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-fg">
                {pretty}
              </pre>
              <div className="flex justify-end">
                <CopyButton value={value ?? ""} label="Copy the value" />
              </div>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function DocumentList({ documents, loading, empty }: { documents: string[]; loading?: boolean; empty: string }) {
  if (!documents.length) return <p className="rounded-lg border border-line px-3 py-6 text-center text-[13px] text-muted">{empty}</p>;
  return (
    <ul className={cn("flex flex-col gap-2 transition-opacity", loading && "opacity-60")}>
      {documents.map((d, i) => (
        <li key={i} className="group relative">
          <pre className="scrollbar-thin max-h-80 overflow-auto rounded-lg border border-line bg-sunken/60 p-3 font-mono text-[12px] leading-relaxed whitespace-pre text-fg">
            {d}
          </pre>
          <CopyButton value={d} label="Copy the document" className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" />
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ Redis / Valkey */

function ttlText(ms: number) {
  if (ms === -1) return "No expiry";
  if (ms < 0) return "Gone";
  const s = Math.round(ms / 1000);
  if (s < 90) return `Expires in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `Expires in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `Expires in ${h}h`;
  return `Expires in ${Math.round(h / 24)}d`;
}

const KV_TONES: Record<string, "neutral" | "accent" | "info" | "ok" | "warn"> = { string: "neutral", hash: "accent", list: "info", set: "ok", zset: "warn", stream: "info" };

function KvBrowser({ serviceId, database }: { serviceId: string; database: string }) {
  const [pattern, setPattern] = React.useState("*");
  const [applied, setApplied] = React.useState("*");
  const [keys, setKeys] = React.useState<KeyInfo[]>([]);
  const [cursor, setCursor] = React.useState("0");
  const [scan, runScan] = useRead<{ cursor: string; keys: KeyInfo[] }>();
  const [selected, setSelected] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (from: string, match: string) => {
      const data = await runScan(() => explorerKeys(serviceId, { database, pattern: match, cursor: from }));
      if (!data) return;
      setKeys((k) => {
        const seen = new Set(from === "0" ? [] : k.map((x) => x.key));
        return [...(from === "0" ? [] : k), ...data.keys.filter((x) => !seen.has(x.key))].sort((a, b) => a.key.localeCompare(b.key));
      });
      setCursor(data.cursor);
    },
    [serviceId, database, runScan],
  );

  React.useEffect(() => {
    void load("0", applied);
  }, [load, applied]);

  return (
    <div className="grid lg:grid-cols-[19rem_minmax(0,1fr)]">
      <aside className="flex min-w-0 flex-col border-b border-line lg:max-h-[44rem] lg:border-r lg:border-b-0">
        <form
          className="flex items-center gap-1.5 border-b border-line p-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSelected(null);
            if (pattern === applied) void load("0", applied);
            setApplied(pattern || "*");
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
            <Input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="Pattern, like user:*"
              className="h-8 pl-8 font-mono text-[12.5px]"
              aria-label="Key pattern"
            />
          </div>
          <Button size="sm" type="submit" loading={scan.loading && cursor === "0"}>
            Scan
          </Button>
        </form>
        {scan.error && <p className="px-3 py-2 text-[13px] text-bad">{scan.error}</p>}
        <nav className="scrollbar-thin max-h-72 flex-1 overflow-y-auto p-1.5 lg:max-h-none">
          {keys.map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => setSelected(k.key)}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                selected === k.key ? "bg-accent-soft text-accent-strong" : "text-fg-2 hover:bg-hover hover:text-fg",
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{k.key}</span>
              {k.ttl >= 0 && <span className="flex-none text-[11px] text-faint">TTL</span>}
              <Badge tone={KV_TONES[k.type] ?? "neutral"} className="flex-none">
                {k.type}
              </Badge>
            </button>
          ))}
          {!keys.length && !scan.loading && !scan.error && <p className="px-2 py-3 text-[13px] text-muted">{applied === "*" ? "This database has no keys." : "No keys match."}</p>}
          {!keys.length && scan.loading && (
            <div className="flex flex-col gap-2 p-1.5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          )}
        </nav>
        {cursor !== "0" && (
          <div className="border-t border-line p-2">
            <Button size="sm" variant="ghost" className="w-full" loading={scan.loading} onClick={() => void load(cursor, applied)}>
              Load more keys
            </Button>
          </div>
        )}
      </aside>
      <div className="min-w-0">
        {selected ? (
          <KeyView key={selected} serviceId={serviceId} database={database} name={selected} />
        ) : (
          <EmptyState icon={<KeyRound />} title="Choose a key" description="Its type, time to live and value show here." />
        )}
      </div>
    </div>
  );
}

function KeyView({ serviceId, database, name }: { serviceId: string; database: string; name: string }) {
  const [value, setValue] = React.useState<KeyValue | null>(null);
  const [state, run] = useRead<KeyValue>();

  const load = React.useCallback(
    async (at: string) => {
      const data = await run(() => explorerKey(serviceId, { database, key: name, at }));
      if (data) setValue((v) => (at === "0" || !v ? data : { ...data, entries: [...v.entries, ...data.entries] }));
    },
    [serviceId, database, name, run],
  );
  React.useEffect(() => {
    void load("0");
  }, [load]);

  if (state.error && !value) {
    return (
      <div className="p-4 sm:p-5">
        <ErrorBox message={state.error} />
      </div>
    );
  }
  if (!value) {
    return (
      <div className="p-4 sm:p-5">
        <TableSkeleton />
      </div>
    );
  }
  const columns: Record<string, string[]> = { hash: ["field", "value"], list: ["index", "value"], set: ["member"], zset: ["member", "score"], stream: ["id", "fields"] };
  const sizeNoun: Record<string, string> = { string: "bytes", hash: "fields", list: "items", set: "members", zset: "members", stream: "entries" };
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
      <div className="flex flex-col gap-1">
        <h4 className="font-mono text-[14px] font-semibold break-all whitespace-pre-wrap text-fg">{value.key}</h4>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <Badge tone={KV_TONES[value.type] ?? "neutral"}>{value.type}</Badge>
          <span>{ttlText(value.ttl)}</span>
          {value.size >= 0 && (
            <span>
              · {count(value.size)} {sizeNoun[value.type] ?? ""}
            </span>
          )}
          <Button size="icon-sm" variant="ghost" className="ml-auto" onClick={() => void load("0")} aria-label="Refresh the value" title="Refresh">
            <RotateCw className={cn(state.loading && "animate-spin")} />
          </Button>
        </p>
      </div>
      {value.type === "none" ? (
        <p className="text-[13px] text-muted">This key is gone. It may have expired.</p>
      ) : value.type === "string" ? (
        <>
          <div className="relative">
            <pre className="scrollbar-thin max-h-[32rem] overflow-auto rounded-lg border border-line bg-sunken/60 p-3 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-fg">
              {value.entries[0]?.[0] ?? ""}
            </pre>
            <CopyButton value={value.entries[0]?.[0] ?? ""} label="Copy the value" className="absolute top-2 right-2" />
          </div>
          {value.truncated && <p className="text-xs text-warn">Showing the first 64 KB.</p>}
        </>
      ) : columns[value.type] ? (
        <>
          <ResultTable
            columns={columns[value.type]}
            rows={value.entries}
            loading={state.loading}
            empty="Empty."
            first={value.type === "list" || value.type === "hash" ? "label" : undefined}
          />
          <div className="flex items-center justify-between text-xs text-muted">
            <span className="tabular-nums">
              {count(value.entries.length)} of {count(value.size)}
            </span>
            {value.next !== "0" && (
              <Button size="xs" variant="ghost" loading={state.loading} onClick={() => void load(value.next)}>
                Load more
              </Button>
            )}
          </div>
        </>
      ) : (
        <p className="text-[13px] text-muted">Values of type {value.type} cannot be shown here. Use the Query tab.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- Query */

const MONGO_OPS = [
  { value: "find", label: "find", hint: 'A filter, like { "status": "active" }', write: false },
  { value: "aggregate", label: "aggregate", hint: 'A pipeline, like [{ "$group": { "_id": "$status", "n": { "$sum": 1 } } }]', write: false },
  { value: "count", label: "count", hint: "A filter. {} counts every document.", write: false },
  { value: "distinct", label: "distinct", hint: "A filter. {} looks at every document.", write: false },
  { value: "insert", label: "insert", hint: 'A document or a list of documents, like { "name": "Ada" }', write: true },
  { value: "update", label: "update", hint: 'Every matching document: { "filter": {…}, "update": { "$set": {…} } }', write: true },
  { value: "delete", label: "delete", hint: "Every document matching the filter. {} deletes all.", write: true },
] as const;
type MongoOperation = (typeof MONGO_OPS)[number]["value"];

/** The last query of each service stays in this browser (local storage may be off: then it is not kept). */
function useStoredText(key: string, fallback: string) {
  const [text, setText] = React.useState(fallback);
  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(key);
      if (saved !== null) setText(saved);
    } catch {}
  }, [key]);
  const set = React.useCallback(
    (v: string) => {
      setText(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {}
    },
    [key],
  );
  return [text, set] as const;
}

function QueryPanel({ serviceId, engine, family, overview, readOnly }: { serviceId: string; engine: string; family: Family; overview: ExplorerOverview; readOnly: boolean }) {
  const firstTable = overview.tables.find((t) => !t.kind.includes("view")) ?? overview.tables[0];
  const example =
    family === "kv"
      ? "SCAN 0 MATCH * COUNT 100"
      : family === "mongo"
        ? "{}"
        : firstTable
          ? `SELECT * FROM ${quoteName(engine, firstTable.schema && firstTable.schema !== "public" ? firstTable.schema : null, firstTable.name)} LIMIT 100;`
          : engine === "clickhouse"
            ? "SELECT version();"
            : "SELECT version();";
  const [text, setText] = useStoredText(`serve:data:${serviceId}:${family === "mongo" ? "mongo" : "query"}`, example);
  const [collection, setCollection] = React.useState(overview.tables[0]?.name ?? "");
  const [operation, setOperation] = React.useState<MongoOperation>("find");
  const [field, setField] = React.useState("");
  const [result, setResult] = React.useState<ExplorerQueryResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [history, setHistory] = React.useState<string[]>([]);
  const op = MONGO_OPS.find((o) => o.value === operation) ?? MONGO_OPS[0];

  React.useEffect(() => {
    if (readOnly && op.write) setOperation("find");
  }, [readOnly, op.write]);

  const runQuery = async (query = text) => {
    if (running || (!query.trim() && family !== "mongo")) return;
    setRunning(true);
    setError(null);
    const res = await explorerQuery(serviceId, {
      database: overview.database,
      query,
      readOnly,
      ...(family === "mongo" ? { collection, operation, field: operation === "distinct" ? field : undefined } : {}),
    }).catch((e: Error) => ({ ok: false as const, error: e.message }));
    setRunning(false);
    if (!res.ok) {
      setResult(null);
      setError(res.error);
      return;
    }
    setResult(res.data);
    if (family === "kv") setHistory((h) => [query, ...h.filter((x) => x !== query)].slice(0, 12));
  };

  const shortcut = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void runQuery();
    }
  };

  const limits = family === "kv" ? "Up to 30 seconds." : "Up to 1,000 rows and 30 seconds.";
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
      {family === "kv" ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runQuery();
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='A command, like GET "user:1"'
            className="min-w-48 flex-1 font-mono text-[13px]"
            aria-label="Command"
            spellCheck={false}
          />
          <Button type="submit" variant="primary" loading={running} disabled={!text.trim()}>
            <Play /> Run
          </Button>
        </form>
      ) : (
        <>
          {family === "mongo" && (
            <div className="flex flex-wrap items-center gap-2">
              <Combobox
                size="sm"
                className="w-auto min-w-48 flex-1 sm:max-w-72"
                value={collection || null}
                onValueChange={setCollection}
                placeholder="Collection"
                options={overview.tables.map((t) => ({ value: t.name, label: t.name }))}
              />
              <Select
                size="sm"
                aria-label="Operation"
                className="w-auto min-w-32"
                value={operation}
                onValueChange={(v) => setOperation(v as MongoOperation)}
                options={MONGO_OPS.map((o) => ({
                  value: o.value,
                  label: o.label,
                  disabled: o.write && readOnly,
                  description: o.write && readOnly ? "Allow changes to use it" : undefined,
                }))}
              />
              {operation === "distinct" && (
                <Input value={field} onChange={(e) => setField(e.target.value)} placeholder="Field" className="h-8 w-40 font-mono text-[12.5px]" aria-label="Field" />
              )}
            </div>
          )}
          {/* Capture: the editor would take Mod-Enter as a new line. */}
          <div onKeyDownCapture={shortcut}>
            <CodeEditor
              value={text}
              onChange={setText}
              language={family === "mongo" ? "json" : "sql"}
              minRows={family === "mongo" ? 4 : 6}
              maxHeight="20rem"
              placeholder={family === "mongo" ? op.hint : "SELECT …"}
              aria-label={family === "mongo" ? "Query" : "SQL"}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" loading={running} onClick={() => void runQuery()} disabled={family !== "mongo" && !text.trim()}>
              <Play /> Run
            </Button>
            <span className="hidden items-center gap-1 text-xs text-faint sm:flex">
              <Kbd>Ctrl</Kbd>
              <Kbd>Enter</Kbd>
            </span>
            <span className="text-xs text-muted">{family === "mongo" ? op.hint : limits}</span>
          </div>
        </>
      )}
      {family === "kv" && (
        <p className="text-xs text-muted">
          {readOnly ? "Read only: read commands run (GET, HGETALL, SCAN, TTL…), commands that write are refused." : "Changes allowed: every command runs, and is logged."} {limits}
        </p>
      )}
      {family === "kv" && history.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {history.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => {
                setText(h);
                void runQuery(h);
              }}
              className="max-w-full truncate rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11.5px] text-fg-2 hover:bg-hover hover:text-fg"
            >
              {h}
            </button>
          ))}
        </div>
      )}
      {error && <ErrorBox message={error} />}
      {result && <QueryResultView result={result} />}
    </div>
  );
}

/** A table name as the engine quotes it, for the example query. */
function quoteName(engine: string, schema: string | null, name: string) {
  const q = (s: string) => (engine === "mysql" || engine === "mariadb" || engine === "clickhouse" ? `\`${s.replace(/`/g, "``")}\`` : `"${s.replace(/"/g, '""')}"`);
  const plain = (s: string) => /^[a-z_][a-z0-9_]*$/.test(s);
  const part = (s: string) => (plain(s) ? s : q(s));
  return schema ? `${part(schema)}.${part(name)}` : part(name);
}

function QueryResultView({ result }: { result: ExplorerQueryResult }) {
  const time = `${number.format(result.ms)} ms`;
  if (result.error) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-muted">Failed after {time}</p>
        <ErrorBox message={result.error} />
      </div>
    );
  }
  const r = result.result;
  if (!r) return null;
  const status = (text: string) => <p className="text-xs text-muted tabular-nums">{text}</p>;
  switch (r.kind) {
    case "rows":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          {status(r.truncated ? `First ${count(r.rows.length)} rows · ${time}` : `${count(r.rows.length)} ${r.rows.length === 1 ? "row" : "rows"} · ${time}`)}
          <ResultTable columns={r.columns} rows={r.rows} empty="No rows." />
        </div>
      );
    case "documents":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          {status(`${r.truncated ? "First " : ""}${count(r.documents.length)} ${r.documents.length === 1 ? "document" : "documents"} · ${time}`)}
          <DocumentList documents={r.documents} empty="No documents." />
        </div>
      );
    case "done":
      return (
        <p className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-fg-2">
          {r.message
            ? `Done. ${r.message}.`
            : r.affected === null
              ? "Done."
              : r.affected === 0
                ? "Done. No rows changed."
                : `Done. ${count(r.affected)} ${r.affected === 1 ? "row" : "rows"} changed.`}{" "}
          <span className="text-muted">{time}</span>
        </p>
      );
    case "value":
    case "text":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          {status(time)}
          <div className="relative">
            <pre className="scrollbar-thin max-h-[32rem] overflow-auto rounded-lg border border-line bg-sunken/60 p-3 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-fg">
              {r.kind === "value" ? r.value : r.text}
            </pre>
            <CopyButton value={r.kind === "value" ? r.value : r.text} className="absolute top-2 right-2" />
          </div>
        </div>
      );
  }
}
