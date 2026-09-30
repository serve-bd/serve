"use client";

import * as React from "react";
import { Download, Eye, HardDriveDownload, KeyRound, Play, Trash2, TriangleAlert } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge, Card, CardBody, CardHeader, CopyField, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { formatBytes } from "@/lib/utils";
import { removeInstanceBackup, revealEncryptionKey, saveInstanceBackupSettings, startInstanceBackup } from "@/server/actions/instance";
import type { InstanceBackup } from "@/server/settings";
import { SettingsCard } from "../_components/settings-card";
import { ProductName } from "@/components/brand";

type Settings = { schedule: string | null; retention: number; s3DestinationId: string | null };

const presets = [
  { value: "0 3 * * *", label: "Every day at 03:00" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "0 3 * * 0", label: "Every Sunday at 03:00" },
  { value: "custom", label: "Custom (cron)" },
];

const statusTone = { running: "info", success: "ok", failed: "bad" } as const;
const triggerLabel = { manual: "Manual", schedule: "Scheduled", update: "Before update" } as const;

export function InstanceBackups({
  settings,
  backups,
  destinations,
  timezone,
}: {
  settings: Settings;
  backups: InstanceBackup[];
  destinations: { id: string; name: string; bucket: string }[];
  timezone: string;
}) {
  const confirm = useConfirm();
  const run = useAction(startInstanceBackup, { success: "Backup started" });
  const remove = useAction(removeInstanceBackup, { success: "Backup deleted" });
  const running = backups.some((b) => b.status === "running");

  return (
    <>
      <EncryptionKeyCard />

      <SettingsCard
        title="Schedule"
        description={`Backs up this instance: its database and files. Times use ${timezone}.`}
        initial={{
          enabled: !!settings.schedule,
          preset: settings.schedule && presets.some((p) => p.value === settings.schedule) ? settings.schedule : settings.schedule ? "custom" : "0 3 * * *",
          cron: settings.schedule ?? "0 3 * * *",
          retention: settings.retention,
          s3DestinationId: settings.s3DestinationId ?? "none",
        }}
        onSave={(v) =>
          saveInstanceBackupSettings({
            schedule: v.enabled ? (v.preset === "custom" ? v.cron : v.preset) : null,
            retention: v.retention,
            s3DestinationId: v.s3DestinationId === "none" ? null : v.s3DestinationId,
          })
        }
      >
        {(v, set) => (
          <>
            <SwitchRow
              title="Scheduled backups"
              description="Recommended. Keeps recent copies on this server and, if chosen, in S3."
              checked={v.enabled}
              onCheckedChange={set("enabled")}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="When">
                <Select value={v.preset} onValueChange={set("preset")} disabled={!v.enabled} options={presets} />
              </Field>
              <Field label="Keep" description="Older backups are deleted, locally and in S3.">
                <Select
                  value={String(v.retention)}
                  onValueChange={(x) => set("retention")(Number(x))}
                  options={[...new Set([3, 7, 14, 30, v.retention])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: `${n} backups` }))}
                />
              </Field>
            </div>
            {v.preset === "custom" && (
              <Field label="Cron expression" description="minute hour day-of-month month day-of-week">
                <Input value={v.cron} onChange={(e) => set("cron")(e.target.value)} disabled={!v.enabled} className="font-mono text-[13px]" placeholder="0 3 * * *" />
              </Field>
            )}
            <Field
              label="Also upload to"
              description={destinations.length ? "Storage of the Root organization." : "Add S3 storage in the Root organization to keep copies off this server."}
            >
              <Select
                value={v.s3DestinationId}
                onValueChange={set("s3DestinationId")}
                disabled={!destinations.length}
                options={[{ value: "none", label: "This server only" }, ...destinations.map((d) => ({ value: d.id, label: d.name, description: d.bucket }))]}
              />
            </Field>
          </>
        )}
      </SettingsCard>

      <Card>
        <CardHeader
          title="Backups"
          description="Each backup is one encrypted file: a database dump, certificates, proxy configuration, SSH keys and service files. Restoring it needs this instance's encryption key."
          actions={
            <Button size="sm" variant="primary" onClick={() => run.run()} loading={run.pending} disabled={running}>
              <Play /> Back up now
            </Button>
          }
        />
        {backups.length === 0 ? (
          <EmptyState icon={<HardDriveDownload />} title="No backups yet" description="Run one now, or turn on the schedule above." />
        ) : (
          <div className="divide-y divide-line">
            {backups.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-[12.5px] text-fg">{b.filename ?? "Preparing…"}</span>
                    <Badge tone={statusTone[b.status]}>{b.status === "running" ? "Running" : b.status === "success" ? "Done" : "Failed"}</Badge>
                    {b.s3Status === "uploaded" && <Badge>S3</Badge>}
                    {b.s3Status === "failed" && <Badge tone="warn">S3 failed</Badge>}
                  </div>
                  <span className="text-xs text-muted">
                    {triggerLabel[b.trigger]} · <TimeAgo date={b.createdAt} /> · v{b.version}
                    {b.size ? ` · ${formatBytes(b.size)}` : ""}
                  </span>
                  {b.error && <span className="line-clamp-2 text-xs text-bad">{b.error}</span>}
                </div>
                {b.status === "success" && (
                  <a href={`/api/instance/backups/${b.id}/download`} download className={buttonVariants({ size: "sm" })}>
                    <Download /> Download
                  </a>
                )}
                {b.status !== "running" && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Delete backup"
                    onClick={async () => {
                      if (await confirm({ title: "Delete this backup?", description: "The file is removed from this server and from S3.", confirmLabel: "Delete", danger: true }))
                        remove.run(b.id);
                    }}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Restoring"
          description={
            <>
              A running <ProductName /> cannot replace its own database, so restores run from the server's shell.
            </>
          }
        />
        <CardBody className="flex flex-col gap-3 py-5 text-[13px] leading-relaxed text-fg-2">
          <p>Copy the backup to the server, keep the same encryption key in /data/serve/.env, then run:</p>
          <CopyField value="sudo bash /data/serve/restore-instance.sh serve-….tar.gz.enc" />
          <p className="text-xs text-muted">
            The script stops <ProductName />, restores the database and files, and starts it again. It is included in the repository as scripts/restore-instance.sh; the README
            describes each step.
          </p>
        </CardBody>
      </Card>
    </>
  );
}

/** The encryption key is not in any backup; without it, the secrets in a restored database are unreadable. */
function EncryptionKeyCard() {
  const confirm = useConfirm();
  const [key, setKey] = React.useState<{ key: string; variable: string } | null>(null);
  const reveal = useAction(revealEncryptionKey, { refresh: false, onSuccess: (d) => setKey(d) });
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-warn/30 bg-warn-soft px-5 py-4">
      <div className="flex gap-3">
        <TriangleAlert className="mt-0.5 size-4 flex-none text-warn" />
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-[13px] leading-relaxed">
          <p className="font-medium text-fg">Save the encryption key somewhere safe</p>
          <p className="text-fg-2">
            Passwords, tokens and keys in the database are encrypted with it. Backups never include it, so a backup cannot be restored without it. Store it in a password manager,
            not next to the backups.
          </p>
        </div>
      </div>
      {key ? (
        <div className="flex flex-col gap-1.5 pl-7">
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <KeyRound className="size-3.5" /> {key.variable}
          </span>
          <CopyField value={key.key} secret />
        </div>
      ) : (
        <div className="pl-7">
          <Button
            size="sm"
            onClick={async () => {
              if (
                await confirm({
                  title: "Show the encryption key?",
                  description: "Anyone with this key and a backup can read every secret stored in this instance. The reveal is recorded in the activity log.",
                  confirmLabel: "Show key",
                })
              )
                reveal.run();
            }}
            loading={reveal.pending}
          >
            <Eye /> Show encryption key
          </Button>
        </div>
      )}
    </div>
  );
}
