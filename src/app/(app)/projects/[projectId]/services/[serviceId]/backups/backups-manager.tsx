"use client";

import { ALL_DATABASES, readChoice } from "@/lib/backup-databases";
import * as React from "react";
import useSWR from "swr";
import { ArchiveRestore, ChevronDown, Cloud, CloudOff, Download, HardDrive, MoreHorizontal, Play, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState, TimeAgo, Copyable } from "@/components/ui/misc";
import { Led } from "@/components/ui/status";
import { Checkbox } from "@/components/ui/checkbox";
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { createBackup, deleteBackup, restoreFromBackup } from "@/server/actions/services";
import { cn, formatBytes } from "@/lib/utils";
import { ScheduleCard } from "./schedule-card";
import { ImportCard } from "./import-card";
import { type DatabaseChoices, DatabasePicker, defaultDatabases } from "./database-picker";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";

type Backup = {
  id: string;
  status: string;
  filename: string | null;
  size: number | null;
  destination: string;
  error: string | null;
  trigger: string;
  s3Status: "uploaded" | "failed" | "deleted" | null;
  restoreStatus: "running" | "success" | "failed" | null;
  restoredAt: string | null;
  log: string | null;
  /** The databases it holds; null for the main database (or a stack's dump). */
  databases: string[] | null;
  local: boolean;
  createdAt: string;
  finishedAt: string | null;
};

const triggerLabel: Record<string, string> = { manual: "Manual", schedule: "Scheduled", import: "Imported", "pre-import": "Before restore" };

/** Confirm body with a "back up first" checkbox (and for MongoDB a users one), read through refs when the dialog closes. */
function SafetyToggle({ valueRef, usersRef }: { valueRef: React.RefObject<boolean>; usersRef?: React.RefObject<boolean> }) {
  const [on, setOn] = React.useState(true);
  const [users, setUsers] = React.useState(false);
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-fg-2">
        <Checkbox
          checked={on}
          onCheckedChange={(c) => {
            setOn(!!c);
            valueRef.current = !!c;
          }}
          className="mt-0.5"
        />
        <span>
          Back up the current data first
          <span className="block text-xs text-muted">If that backup fails, nothing is restored.</span>
        </span>
      </label>
      {usersRef && (
        <label className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-fg-2">
          <Checkbox
            checked={users}
            onCheckedChange={(c) => {
              setUsers(!!c);
              usersRef.current = !!c;
            }}
            className="mt-0.5"
          />
          <span>
            Also restore the dump&apos;s users and passwords
            <span className="mt-0.5 flex items-start gap-1 text-xs text-warn">
              <TriangleAlert className="mt-px size-3.5 flex-none" /> Only when moving a whole server. The old server&apos;s accounts come back with their passwords and rights, and
              anyone who had them can sign in to this database.
            </span>
            <span className="block text-xs text-muted">Serve&apos;s own accounts keep their passwords. Leave this off when you only want the data.</span>
          </span>
        </label>
      )}
    </div>
  );
}

function BackupRow({ b, isAdmin, onRestore, onDelete }: { b: Backup; isAdmin: boolean; onRestore: (b: Backup) => void; onDelete: (b: Backup) => void }) {
  const busy = b.status === "running" || b.restoreStatus === "running";
  // The log opens by itself while something runs and when it failed, until it is closed by hand.
  const [choice, setChoice] = React.useState<boolean | null>(null);
  const open = choice ?? (busy || b.status === "failed" || b.restoreStatus === "failed");
  const logRef = React.useRef<HTMLPreElement>(null);
  React.useEffect(() => {
    if (open && busy && logRef.current && b.log) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [open, busy, b.log]);
  const available = b.local || b.destination !== "local";
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 px-5 py-3">
        <Led color={b.status === "success" ? "var(--ok)" : b.status === "failed" ? "var(--bad)" : "var(--info)"} pulse={busy} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-[12.5px] text-fg-2">{b.filename ?? (b.status === "running" ? "Backing up…" : "Failed backup")}</span>
          {b.databases && b.databases.length > 0 && (
            <span className="truncate text-xs text-muted" title={b.databases.join(", ")}>
              {b.databases.length === 1 ? "Database" : `${b.databases.length} databases`}: {b.databases.join(", ")}
            </span>
          )}
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <TimeAgo date={b.createdAt} />
            {b.size !== null && <span>· {formatBytes(b.size)}</span>}
            <span>· {triggerLabel[b.trigger] ?? b.trigger}</span>
            {b.status === "running" && <span className="text-info">· {b.trigger === "import" ? "Importing" : "Running"}</span>}
            {b.status === "failed" && b.error && <span className="truncate text-bad">· {b.error}</span>}
            {b.restoreStatus === "running" && <span className="text-info">· Restoring…</span>}
            {b.restoreStatus === "success" && b.restoredAt && (
              <span className="text-ok">
                · Restored <TimeAgo date={b.restoredAt} />
              </span>
            )}
            {b.restoreStatus === "failed" && <span className="text-bad">· Restore failed</span>}
          </span>
        </div>
        <div className="hidden flex-none items-center gap-1.5 sm:flex">
          {b.status === "success" && b.local && (
            <Badge>
              <HardDrive /> Local
            </Badge>
          )}
          {b.s3Status === "uploaded" && (
            <Badge tone="info">
              <Cloud /> S3
            </Badge>
          )}
          {b.s3Status === "failed" && (
            <Badge tone="bad">
              <CloudOff /> S3 failed
            </Badge>
          )}
        </div>
        {b.log && (
          <button
            type="button"
            onClick={() => setChoice(!open)}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg"
            aria-expanded={open}
          >
            Log
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        )}
        {!busy && (
          <Menu>
            <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Backup actions">
              <MoreHorizontal className="size-4" />
            </MenuTrigger>
            <MenuContent>
              {b.status === "success" && available && (
                <>
                  <MenuLinkItem render={<a href={`/api/backups/${b.id}/download`} download />}>
                    <Download /> Download{!b.local ? " from the bucket" : ""}
                  </MenuLinkItem>
                  {isAdmin && (
                    <MenuItem onClick={() => onRestore(b)}>
                      <ArchiveRestore /> Restore
                    </MenuItem>
                  )}
                  <MenuSeparator />
                </>
              )}
              <MenuItem danger onClick={() => onDelete(b)}>
                <Trash2 /> Delete
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      {open && b.log && (
        <Copyable value={b.log.trim()} className="mx-5 mb-3">
          <pre ref={logRef} className="max-h-64 overflow-auto rounded-lg bg-sunken py-2 pr-9 pl-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-2">
            {b.log.trim()}
          </pre>
        </Copyable>
      )}
    </div>
  );
}

export function BackupsManager(props: {
  serviceId: string;
  /** A compose stack's backup key (db:…, volume:…, dir:…). */
  target?: string | null;
  title?: string;
  description?: string;
  /** Shown in the restore question: what gets replaced. */
  restoreWhat?: string;
  /** Extra controls in the schedule column (like "Stop backing up"). */
  aside?: React.ReactNode;
  isAdmin: boolean;
  running: boolean;
  engineLabel: string;
  /** MongoDB: restores can bring back the dump's users. */
  restoresUsers?: boolean;
  extensions: string[];
  maxUpload: string | null;
  schedule: string | null;
  retention: number;
  retentionS3: number | null;
  keepLocal?: boolean;
  timeoutMinutes?: number | null;
  lowPriority?: boolean;
  s3DestinationId: string | null;
  destinations: { id: string; name: string; bucket: string }[];
  timezone: string;
  /** A database service whose backups can take several databases of its server. */
  databaseChoices?: DatabaseChoices | null;
}) {
  const confirm = useConfirm();
  const [picking, setPicking] = React.useState(false);
  const { data, mutate } = useSWR<{ backups: Backup[] }>(`/api/services/${props.serviceId}/backups${props.target ? `?target=${encodeURIComponent(props.target)}` : ""}`, {
    refreshInterval: (d) => (d?.backups.some((b) => b.status === "running" || b.restoreStatus === "running") ? 1500 : 10000),
  });

  const run = useAction((databases?: string[]) => createBackup(props.serviceId, props.target ?? null, { databases }), {
    onSuccess: () => {
      setPicking(false);
      void mutate();
    },
  });
  const choices = props.databaseChoices && props.databaseChoices.databases.length > 1 ? props.databaseChoices : null;
  const restore = useAction((id: string, backupFirst: boolean, users: boolean) => restoreFromBackup(id, { backupFirst, users }), {
    onSuccess: () => void mutate(),
  });
  const remove = useAction(deleteBackup, { onSuccess: () => void mutate() });
  const backups = data?.backups ?? [];
  const safety = React.useRef(true);
  const users = React.useRef(false);

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-6">
        <Card className="overflow-hidden">
          <CardHeader
            title={props.title ?? "Backups"}
            description={props.description ?? "Consistent dumps taken with the database's own tools. Download, restore or import one."}
            actions={
              <Button size="sm" variant="primary" onClick={() => (choices ? setPicking(true) : run.run())} loading={run.pending && !picking} disabled={!props.running}>
                <Play /> Back up now
              </Button>
            }
          />
          {backups.length === 0 ? (
            <EmptyState
              icon={<HardDrive />}
              title="No backups yet"
              description={props.running ? "Take a backup now or set a schedule." : props.target ? "Start the stack to take a backup." : "Start the database to take a backup."}
            />
          ) : (
            <div className="divide-y divide-line">
              {backups.map((b) => (
                <BackupRow
                  key={b.id}
                  b={b}
                  isAdmin={props.isAdmin}
                  onRestore={async (x) => {
                    safety.current = true;
                    users.current = false;
                    const ok = await confirm({
                      title: "Restore this backup?",
                      description: `${props.restoreWhat ?? `The current data in ${props.engineLabel}`} is replaced with ${x.filename}.`,
                      confirmLabel: "Restore",
                      danger: true,
                      children: <SafetyToggle valueRef={safety} usersRef={props.restoresUsers ? users : undefined} />,
                    });
                    if (ok) await restore.run(x.id, safety.current, users.current);
                  }}
                  onDelete={async (x) => {
                    if (
                      await confirm({
                        title: "Delete this backup?",
                        description: `${x.filename ?? "The backup"} is removed from this server${x.destination !== "local" ? " and its bucket" : ""}.`,
                        confirmLabel: "Delete",
                        danger: true,
                      })
                    )
                      remove.run(x.id);
                  }}
                />
              ))}
            </div>
          )}
        </Card>
        {props.isAdmin && !props.target && (
          <ImportCard
            serviceId={props.serviceId}
            running={props.running}
            engineLabel={props.engineLabel}
            restoresUsers={props.restoresUsers}
            extensions={props.extensions}
            maxUpload={props.maxUpload}
            destinations={props.destinations}
            onStarted={() => void mutate()}
          />
        )}
      </div>

      <div className="flex flex-col gap-4">
        <ScheduleCard
          key={props.target ?? "database"}
          serviceId={props.serviceId}
          target={props.target}
          noun={props.target && !props.target.startsWith("db:") ? "copies" : "dumps"}
          schedule={props.schedule}
          retention={props.retention}
          retentionS3={props.retentionS3}
          keepLocal={props.keepLocal}
          timeoutMinutes={props.timeoutMinutes}
          lowPriority={props.lowPriority}
          s3DestinationId={props.s3DestinationId}
          destinations={props.destinations}
          timezone={props.timezone}
          canEdit={props.isAdmin}
          // The schedule offers the choice with one database too: Every database also takes the ones made later.
          databaseChoices={props.databaseChoices ?? null}
        />
        {props.aside}
      </div>
      {picking && choices && <BackupNowDialog choices={choices} pending={run.pending} onClose={() => setPicking(false)} onRun={(dbs) => void run.run(dbs)} />}
    </div>
  );
}

/** Back up now, for a server with several databases: which of them this backup takes. */
function BackupNowDialog({ choices, pending, onClose, onRun }: { choices: DatabaseChoices; pending: boolean; onClose: () => void; onRun: (databases: string[]) => void }) {
  const [picked, setPicked] = React.useState<string[]>(() => (choices.selected?.length ? choices.selected : defaultDatabases(choices)));
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent size="sm">
        <DialogHeader title="Back up now" description="The databases this backup takes. A restore brings each back as it was." />
        <DialogBody>
          <DatabasePicker choices={choices} value={picked} onChange={setPicked} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onRun(picked)} loading={pending} disabled={!picked.length}>
            {picked.includes(ALL_DATABASES)
              ? readChoice(picked).skip.length
                ? `Back up all but ${readChoice(picked).skip.length}`
                : "Back up every database"
              : `Back up ${picked.length === 1 ? "1 database" : `${picked.length} databases`}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
