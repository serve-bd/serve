"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import type { Preparing } from "./import-card";
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
  preparing,
  onClose,
  onStarted,
  restoresUsers,
}: {
  backup: { id: string; filename: string | null; trigger?: string } | null;
  /** An import on its way in: the window opens at once and shows it until the file is in. */
  preparing?: Preparing | null;
  onClose: () => void;
  onStarted: () => void;
  restoresUsers?: boolean;
}) {
  const [choices, setChoices] = React.useState<Choices | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [into, setInto] = React.useState("");
  const [elsewhere, setElsewhere] = React.useState(false);
  const [picked, setPicked] = React.useState<Record<string, boolean>>({});
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
    setElsewhere(false);
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
    target && chosen.length === 1
      ? target.database
      : d.name === ""
        ? // A backup of this service goes back where it was taken; an import of an unnamed dump into the main one.
          (target?.database ?? (backup?.trigger === "import" ? choices?.main : d.label) ?? d.label)
        : d.name;
  const all = dbs.length > 0 && chosen.length === dbs.length;
  const ready = !!choices && (dbs.length === 0 || chosen.length > 0) && (!choices.encrypted || !choices.unreadable || !!passphrase);

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
    const res = await restoreFromBackup(backup.id, {
      backupFirst,
      users,
      into: into || undefined,
      // All of them: the whole backup, and the server holds exactly that. Some: only those are replaced.
      databases: all ? undefined : chosen.map((d) => d.name),
      passphrase: passphrase || undefined,
    });
    setPending(false);
    if (!res.ok) return setError(res.error);
    onStarted();
    onClose();
  };

  return (
    <Dialog open={!!backup || !!preparing} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent size="lg">
        <DialogHeader title="Restore backup" description={backup?.filename ?? preparing?.name} />
        <DialogBody>
          {!backup && preparing?.progress != null && (
            <div className="flex flex-col gap-2 py-6">
              <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(preparing.progress * 100)}%` }} />
              </div>
              <span className="text-[13px] text-muted tabular-nums">Uploading {Math.round(preparing.progress * 100)}%</span>
            </div>
          )}
          {((!backup && preparing && preparing.progress == null) || (backup && !choices && !loadError)) && (
            <p className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted">
              <Loader2 className="size-4 animate-spin text-accent" />
              {backup ? "Reading the databases in the file…" : "Checking the file…"}
            </p>
          )}
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
              {/* This database, as a rule: another one (staging from production, say) only when asked for. */}
              {choices.others.length > 0 && !elsewhere && backup?.trigger !== "import" && (
                <button type="button" className="w-fit text-[13px] text-accent hover:underline" onClick={() => setElsewhere(true)}>
                  Restore into another database…
                </button>
              )}
              {choices.others.length > 0 && elsewhere && (
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

              {dbs.length > 1 && (
                <div className="flex flex-col gap-2">
                  <span className="text-[13px] font-medium text-fg-2">Databases to restore</span>
                  <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
                    <label className="flex items-center gap-2 px-3 py-2 text-[13px] text-fg-2">
                      <Checkbox checked={all} indeterminate={!all && chosen.length > 0} onCheckedChange={(c) => setPicked(Object.fromEntries(dbs.map((d) => [d.name, !!c])))} />
                      All databases
                    </label>
                    {dbs.map((d) => (
                      <label key={d.name} className="flex items-center gap-2 px-3 py-2 pl-8 text-[13px] text-fg-2">
                        <Checkbox checked={!!picked[d.name]} onCheckedChange={(c) => setPicked((p) => ({ ...p, [d.name]: !!c }))} />
                        <span className="truncate font-mono text-[12.5px]">{defaultName(d)}</span>
                        {choices.tables && (
                          <span className="flex-none text-xs text-faint">{d.tables.length === 0 ? "empty" : d.tables.length === 1 ? "1 table" : `${d.tables.length} tables`}</span>
                        )}
                      </label>
                    ))}
                  </div>
                  <span className="text-xs text-muted">
                    {all ? "Every database on the server is replaced with the backup's." : "Only the ticked databases are replaced; the others stay as they are."}
                  </span>
                </div>
              )}

              <label className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-fg-2">
                <Checkbox checked={backupFirst} onCheckedChange={(c) => setBackupFirst(!!c)} className="mt-0.5" />
                <span>
                  Keep a backup of the current database
                  <span className="block text-xs text-muted">
                    A backup of everything in {targetName} is always made first, and put back if the restore fails. Keep it to undo this restore later.
                  </span>
                </span>
              </label>
              {restoresUsers && (
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
          <span className="mr-auto truncate text-xs text-muted">
            {choices ? (all || dbs.length <= 1 ? `Everything in ${targetName} is replaced with the backup` : `Replaces the ticked databases in ${targetName}`) : ""}
          </span>
          <DialogClose render={<Button variant="ghost" size="sm" disabled={pending} />}>Cancel</DialogClose>
          <Button size="sm" variant="danger" disabled={!ready} loading={pending} onClick={() => void submit()}>
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
