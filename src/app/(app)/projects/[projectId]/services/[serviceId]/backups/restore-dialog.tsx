"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogError, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { restoreChoices, restoreFromBackup } from "@/server/actions/services";

type Choices = Extract<Awaited<ReturnType<typeof restoreChoices>>, { ok: true }>["data"];

/**
 * Restore a database backup: into this service or another of the same kind, all of it or chosen
 * databases (each under its own or a new name), all tables or some. A safety backup comes first.
 */
export function RestoreDialog({
  backup,
  onClose,
  onStarted,
  restoresUsers,
}: {
  backup: { id: string; filename: string | null } | null;
  onClose: () => void;
  onStarted: () => void;
  restoresUsers?: boolean;
}) {
  const [choices, setChoices] = React.useState<Choices | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [into, setInto] = React.useState("");
  const [picked, setPicked] = React.useState<Record<string, boolean>>({});
  const [names, setNames] = React.useState<Record<string, string>>({});
  // A name typed in (Other name…) rather than picked from the server's databases.
  const [custom, setCustom] = React.useState<Record<string, boolean>>({});
  const [someTables, setSomeTables] = React.useState(false);
  const [tables, setTables] = React.useState<Set<string>>(new Set());
  const [query, setQuery] = React.useState("");
  const [backupFirst, setBackupFirst] = React.useState(true);
  const [users, setUsers] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [passphrase, setPassphrase] = React.useState("");
  const [unlocking, setUnlocking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!backup) return;
    setChoices(null);
    setLoadError(null);
    setInto("");
    setNames({});
    setSomeTables(false);
    setTables(new Set());
    setQuery("");
    setBackupFirst(true);
    setUsers(false);
    setError(null);
    setPassphrase("");
    void restoreChoices(backup.id).then((res) => {
      if (!res.ok) return setLoadError(res.error);
      setChoices(res.data);
      setPicked(Object.fromEntries(res.data.databases.map((d) => [d.name, true])));
    });
  }, [backup]);

  const dbs = choices?.databases ?? [];
  const chosen = dbs.filter((d) => picked[d.name]);
  const target = into ? choices?.others.find((o) => o.id === into) : null;
  const targetName = target?.name ?? choices?.service.name ?? "";
  // Where a database goes when not renamed: its own name here; into another service a single one becomes that one's.
  const defaultName = (d: { name: string; label: string }) =>
    target && chosen.length === 1 ? target.database : d.name === "" ? (target?.database ?? choices?.main ?? d.label) : d.name;
  const one = chosen.length === 1 ? chosen[0] : null;
  // Where each chosen database goes; two never share one.
  const goesTo = (d: { name: string; label: string }) => names[d.name]?.trim() || defaultName(d);
  const takenBy = (x: string, d: { name: string }) => chosen.find((e) => e.name !== d.name && goesTo(e) === x)?.label;
  const clash = chosen.find((d) => takenBy(goesTo(d), d));
  const tableList = one && choices?.tables ? one.tables : [];
  // Tables picked in one database never carry over to another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the one database changes
  React.useEffect(() => {
    setTables(new Set());
    setSomeTables(false);
  }, [one?.name]);
  const shown = tableList.filter((t) => t.toLowerCase().includes(query.trim().toLowerCase()));
  const ready = !!choices && !clash && (dbs.length === 0 || chosen.length > 0) && (!someTables || tables.size > 0) && (!choices.encrypted || !choices.unreadable || !!passphrase);

  // An encrypted backup made with another passphrase: read again with the one typed in.
  const unlock = async () => {
    if (!backup) return;
    setUnlocking(true);
    const res = await restoreChoices(backup.id, passphrase);
    setUnlocking(false);
    if (!res.ok) return setLoadError(res.error);
    setChoices(res.data);
    setPicked(Object.fromEntries(res.data.databases.map((d) => [d.name, true])));
  };
  const needsPassphrase = !!choices?.encrypted && !!choices.unreadable;

  const submit = async () => {
    if (!backup) return;
    setPending(true);
    setError(null);
    const renames: Record<string, string> = {};
    for (const d of chosen) {
      const as = names[d.name]?.trim();
      if (as && as !== defaultName(d)) renames[d.name] = as;
    }
    const res = await restoreFromBackup(backup.id, {
      backupFirst,
      users,
      into: into || undefined,
      // Tables always name their database.
      databases: someTables && one ? [one.name] : chosen.length < dbs.length ? chosen.map((d) => d.name) : undefined,
      renames,
      tables: someTables && one ? [...tables] : undefined,
      passphrase: passphrase || undefined,
    });
    setPending(false);
    if (!res.ok) return setError(res.error);
    onStarted();
    onClose();
  };

  return (
    <Dialog open={!!backup} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader title="Restore backup" description={backup?.filename ?? undefined} />
        <DialogBody>
          {!choices && !loadError && <p className="text-[13px] text-muted">Reading the backup…</p>}
          {loadError && <p className="text-[13px] text-bad">{loadError}</p>}
          {needsPassphrase && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-fg-2">Backup passphrase</span>
              <div className="flex gap-2">
                <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="The passphrase it was made with" className="h-9" />
                <Button size="sm" onClick={() => void unlock()} loading={unlocking} disabled={!passphrase}>
                  Open
                </Button>
              </div>
              <span className="text-xs text-muted">This backup is encrypted with a passphrase other than the current one.</span>
            </div>
          )}
          {choices?.unreadable && !needsPassphrase && (
            <p className="flex items-start gap-1.5 text-xs text-warn">
              <TriangleAlert className="mt-px size-3.5 flex-none" /> Its databases and tables could not be listed, so the whole backup is restored: {choices.unreadable}
            </p>
          )}
          {choices && (
            <>
              {choices.others.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium text-fg-2">Restore into</span>
                  <Select
                    value={into || "self"}
                    onValueChange={(v) => setInto(v === "self" ? "" : v)}
                    options={[
                      { value: "self", label: choices.service.name, description: "This database" },
                      ...choices.others.map((o) => ({ value: o.id, label: o.name, description: o.running ? o.project : `${o.project} · stopped`, disabled: !o.running })),
                    ]}
                  />
                </div>
              )}

              {dbs.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-[13px] font-medium text-fg-2">{dbs.length > 1 ? "Databases" : "Database"}</span>
                  {dbs.map((d) => (
                    <div key={d.name} className="grid grid-cols-1 items-center gap-2 rounded-lg border border-line px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <label className="flex min-w-0 items-center gap-2 text-[13px] text-fg-2">
                        {dbs.length > 1 && <Checkbox checked={!!picked[d.name]} onCheckedChange={(c) => setPicked((p) => ({ ...p, [d.name]: !!c }))} />}
                        <span className="truncate font-mono text-[12.5px]">{d.label}</span>
                        {choices.tables && <span className="flex-none text-xs text-faint">{d.tables.length === 1 ? "1 table" : `${d.tables.length} tables`}</span>}
                      </label>
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Select
                          size="sm"
                          value={custom[d.name] ? "__other" : names[d.name] || "__own"}
                          onValueChange={(v) => {
                            setCustom((c) => ({ ...c, [d.name]: v === "__other" }));
                            setNames((n) => ({ ...n, [d.name]: v === "__other" || v === "__own" ? "" : v }));
                          }}
                          disabled={!picked[d.name]}
                          aria-label={`Restore ${d.label} into`}
                          options={[
                            {
                              value: "__own",
                              label: `Into ${defaultName(d)}`,
                              description: takenBy(defaultName(d), d) ? `${takenBy(defaultName(d), d)} goes there` : "Its own name",
                              disabled: !!takenBy(defaultName(d), d),
                            },
                            // The server's databases (this service only): merged, tables of the same name replaced.
                            ...(target ? [] : (choices.existing ?? []))
                              .filter((x) => x !== defaultName(d))
                              .map((x) => ({
                                value: x,
                                label: `Into ${x}`,
                                description: takenBy(x, d) ? `${takenBy(x, d)} goes there` : x === choices.main ? "The main database, merged" : "Merged",
                                disabled: !!takenBy(x, d),
                              })),
                            { value: "__other", label: "Other name…" },
                          ]}
                        />
                        {custom[d.name] && (
                          <Input
                            value={names[d.name] ?? ""}
                            onChange={(e) => setNames((n) => ({ ...n, [d.name]: e.target.value }))}
                            placeholder="New database name"
                            aria-label={`New name for ${d.label}`}
                            className="h-8 font-mono text-[12.5px]"
                            autoFocus
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {one && choices.tables && tableList.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-[13px] font-medium text-fg-2">Tables</span>
                  <Select
                    value={someTables ? "some" : "all"}
                    onValueChange={(v) => setSomeTables(v === "some")}
                    options={[
                      { value: "all", label: "All tables", description: "The whole database is replaced" },
                      { value: "some", label: "Only some tables", description: "Those tables are replaced; the others stay as they are" },
                    ]}
                  />
                  {someTables && (
                    <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
                      <div className="flex items-center gap-2">
                        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a table" className="h-8 text-[13px]" />
                        <Button size="sm" variant="ghost" onClick={() => setTables(new Set([...tables, ...shown]))}>
                          All
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setTables(new Set([...tables].filter((t) => !shown.includes(t))))}>
                          None
                        </Button>
                      </div>
                      <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                        {shown.map((t) => (
                          <label key={t} className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-[12.5px] text-fg-2 hover:bg-hover">
                            <Checkbox
                              checked={tables.has(t)}
                              onCheckedChange={(c) => {
                                const next = new Set(tables);
                                if (c) next.add(t);
                                else next.delete(t);
                                setTables(next);
                              }}
                            />
                            <span className="truncate font-mono">{t}</span>
                          </label>
                        ))}
                      </div>
                      <span className="text-xs text-muted">{tables.size === 1 ? "1 table chosen" : `${tables.size} tables chosen`}</span>
                    </div>
                  )}
                </div>
              )}

              <label className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-fg-2">
                <Checkbox checked={backupFirst} onCheckedChange={(c) => setBackupFirst(!!c)} className="mt-0.5" />
                <span>
                  Back up {targetName} first
                  <span className="block text-xs text-muted">If that backup fails, nothing is restored.</span>
                </span>
              </label>
              {restoresUsers && !someTables && (
                <label className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-fg-2">
                  <Checkbox checked={users} onCheckedChange={(c) => setUsers(!!c)} className="mt-0.5" />
                  <span>
                    Also restore the dump&apos;s users and passwords
                    <span className="mt-0.5 flex items-start gap-1 text-xs text-warn">
                      <TriangleAlert className="mt-px size-3.5 flex-none" /> Only when moving a whole server. The old server&apos;s accounts come back with their passwords and
                      rights, and anyone who had them can sign in to this database.
                    </span>
                    <span className="block text-xs text-muted">Serve&apos;s own accounts keep their passwords. Leave this off when you only want the data.</span>
                  </span>
                </label>
              )}
            </>
          )}
          <DialogError message={error} />
        </DialogBody>
        <DialogFooter>
          <span className={cn("mr-auto text-xs", clash ? "text-bad" : "truncate text-muted")}>
            {clash
              ? `${clash.label} and ${takenBy(goesTo(clash), clash)} both go into ${goesTo(clash)}. Choose another for one of them.`
              : someTables
                ? `Replaces ${tables.size === 1 ? "1 table" : `${tables.size} tables`} in ${targetName}`
                : `Replaces the data in ${targetName}`}
          </span>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" variant="danger" disabled={!ready} loading={pending} onClick={() => void submit()}>
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
