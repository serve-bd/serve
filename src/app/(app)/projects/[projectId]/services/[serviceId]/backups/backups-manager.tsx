"use client";

import * as React from "react";
import useSWR from "swr";
import { ArchiveRestore, ChevronDown, Cloud, CloudOff, Download, HardDrive, MoreHorizontal, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Led } from "@/components/ui/status";
import { Checkbox } from "@/components/ui/checkbox";
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { createBackup, deleteBackup, restoreFromBackup } from "@/server/actions/services";
import { cn, formatBytes } from "@/lib/utils";
import { ScheduleCard } from "./schedule-card";
import { ImportCard } from "./import-card";

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
  local: boolean;
  createdAt: string;
  finishedAt: string | null;
};

const triggerLabel: Record<string, string> = { manual: "Manual", schedule: "Scheduled", import: "Imported", "pre-import": "Before restore" };

/** Confirm body with a "back up first" checkbox, read through a ref when the dialog closes. */
function SafetyToggle({ valueRef }: { valueRef: React.RefObject<boolean> }) {
  const [on, setOn] = React.useState(true);
  return (
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
                    <Download /> Download{!b.local ? " from S3" : ""}
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
        <pre ref={logRef} className="mx-5 mb-3 max-h-64 overflow-auto rounded-lg bg-sunken px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-2">
          {b.log.trim()}
        </pre>
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
  extensions: string[];
  maxUpload: string | null;
  schedule: string | null;
  retention: number;
  retentionS3: number | null;
  s3DestinationId: string | null;
  destinations: { id: string; name: string; bucket: string }[];
  timezone: string;
}) {
  const confirm = useConfirm();
  const { data, mutate } = useSWR<{ backups: Backup[] }>(`/api/services/${props.serviceId}/backups${props.target ? `?target=${encodeURIComponent(props.target)}` : ""}`, {
    refreshInterval: (d) => (d?.backups.some((b) => b.status === "running" || b.restoreStatus === "running") ? 1500 : 10000),
  });

  const run = useAction(() => createBackup(props.serviceId, props.target ?? null), { success: "Backup started", onSuccess: () => void mutate() });
  const restore = useAction((id: string, backupFirst: boolean) => restoreFromBackup(id, { backupFirst }), { success: "Restore started", onSuccess: () => void mutate() });
  const remove = useAction(deleteBackup, { success: "Backup deleted", onSuccess: () => void mutate() });
  const backups = data?.backups ?? [];
  const safety = React.useRef(true);

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-6">
        <Card className="overflow-hidden">
          <CardHeader
            title={props.title ?? "Backups"}
            description={props.description ?? "Consistent dumps taken with the database's own tools. Download, restore or import one."}
            actions={
              <Button size="sm" variant="primary" onClick={() => run.run()} loading={run.pending} disabled={!props.running}>
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
                    const ok = await confirm({
                      title: "Restore this backup?",
                      description: `${props.restoreWhat ?? `The current data in ${props.engineLabel}`} is replaced with ${x.filename}.`,
                      confirmLabel: "Restore",
                      danger: true,
                      children: <SafetyToggle valueRef={safety} />,
                    });
                    if (ok) await restore.run(x.id, safety.current);
                  }}
                  onDelete={async (x) => {
                    if (
                      await confirm({
                        title: "Delete this backup?",
                        description: `${x.filename ?? "The backup"} is removed from this server${x.destination !== "local" ? " and S3" : ""}.`,
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
          s3DestinationId={props.s3DestinationId}
          destinations={props.destinations}
          timezone={props.timezone}
          canEdit={props.isAdmin}
        />
        {props.aside}
      </div>
    </div>
  );
}
