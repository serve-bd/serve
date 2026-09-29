"use client";

import * as React from "react";
import Link from "next/link";
import useSWR from "swr";
import { ArchiveRestore, Download, HardDrive, MoreHorizontal, Play, Trash2, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardFooter, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Led } from "@/components/ui/status";
import { Menu, MenuContent, MenuItem, MenuLinkItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { createBackup, deleteBackup, restoreFromBackup, updateService } from "@/server/actions/services";
import { formatBytes } from "@/lib/utils";

type Backup = {
  id: string;
  status: string;
  filename: string | null;
  size: number | null;
  destination: string;
  error: string | null;
  trigger: string;
  createdAt: string;
  finishedAt: string | null;
};

const presets = [
  { value: "off", label: "Off", cron: null },
  { value: "hourly", label: "Every hour", cron: "0 * * * *" },
  { value: "6h", label: "Every 6 hours", cron: "0 */6 * * *" },
  { value: "daily", label: "Daily at 03:00", cron: "0 3 * * *" },
  { value: "weekly", label: "Weekly on Sunday", cron: "0 3 * * 0" },
  { value: "custom", label: "Custom cron", cron: "" },
];

export function BackupsManager(props: {
  serviceId: string;
  isAdmin: boolean;
  schedule: string | null;
  retention: number;
  s3DestinationId: string | null;
  destinations: { id: string; name: string; bucket: string }[];
}) {
  const confirm = useConfirm();
  const { data, mutate } = useSWR<{ backups: Backup[] }>(`/api/services/${props.serviceId}/backups`, {
    refreshInterval: (d) => (d?.backups.some((b) => b.status === "running") ? 1500 : 10000),
  });
  const initialPreset = presets.find((p) => p.cron === props.schedule)?.value ?? (props.schedule ? "custom" : "off");
  const [preset, setPreset] = React.useState(initialPreset);
  const [cron, setCron] = React.useState(props.schedule ?? "");
  const [retention, setRetention] = React.useState(String(props.retention));
  const [dest, setDest] = React.useState(props.s3DestinationId ?? "local");

  const run = useAction(() => createBackup(props.serviceId), { success: "Backup started", onSuccess: () => void mutate() });
  const restore = useAction(restoreFromBackup, { success: "Restore started" });
  const remove = useAction(deleteBackup, { success: "Backup deleted", onSuccess: () => void mutate() });
  const saveSchedule = useAction(
    () =>
      updateService(props.serviceId, {
        database: {
          backupSchedule: preset === "off" ? null : preset === "custom" ? cron : presets.find((p) => p.value === preset)!.cron,
          backupRetention: Math.max(1, Number(retention) || 7),
          s3DestinationId: dest === "local" ? null : dest,
        },
      }),
    { success: "Backup schedule saved" },
  );

  const backups = data?.backups ?? [];

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card className="overflow-hidden">
        <CardHeader
          title="Backups"
          description="Consistent dumps taken with the database's own tools."
          actions={
            <Button size="sm" variant="primary" onClick={() => run.run()} loading={run.pending}>
              <Play /> Back up now
            </Button>
          }
        />
        {backups.length === 0 ? (
          <EmptyState icon={<HardDrive />} title="No backups yet" description="Take a backup now or set a schedule." />
        ) : (
          <div className="divide-y divide-line">
            {backups.map((b) => (
              <div key={b.id} className="flex items-center gap-3 px-5 py-3">
                <Led color={b.status === "success" ? "var(--ok)" : b.status === "failed" ? "var(--bad)" : "var(--info)"} pulse={b.status === "running"} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[12.5px] text-fg-2">{b.filename ?? (b.status === "running" ? "Backing up…" : "Failed backup")}</span>
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                    <TimeAgo date={b.createdAt} />
                    {b.size !== null && <span>· {formatBytes(b.size)}</span>}
                    <span className="capitalize">· {b.trigger}</span>
                    {b.status === "failed" && b.error && <span className="truncate text-bad">· {b.error}</span>}
                  </span>
                </div>
                {b.destination !== "local" && <Badge tone="info"><Cloud /> S3</Badge>}
                {b.status !== "running" && (
                  <Menu>
                    <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Backup actions">
                      <MoreHorizontal className="size-4" />
                    </MenuTrigger>
                    <MenuContent>
                      {b.status === "success" && (
                        <>
                          <MenuLinkItem render={<Link href={`/api/backups/${b.id}/download`} prefetch={false} />}>
                            <Download /> Download
                          </MenuLinkItem>
                          {props.isAdmin && (
                            <MenuItem
                              onClick={async () => {
                                if (await confirm({ title: "Restore this backup?", description: "Current data in the database is replaced with the contents of this backup.", confirmLabel: "Restore", danger: true }))
                                  restore.run(b.id);
                              }}
                            >
                              <ArchiveRestore /> Restore
                            </MenuItem>
                          )}
                          <MenuSeparator />
                        </>
                      )}
                      <MenuItem danger onClick={() => remove.run(b.id)}>
                        <Trash2 /> Delete
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="h-fit">
        <CardHeader title="Schedule" description="Automatic backups with retention." />
        <CardBody className="flex flex-col gap-4 py-5">
          <Field label="Frequency">
            <Select value={preset} onValueChange={setPreset} options={presets.map((p) => ({ value: p.value, label: p.label }))} />
          </Field>
          {preset === "custom" && (
            <Field label="Cron expression" description="Minute hour day month weekday, in server time.">
              <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="30 2 * * *" className="font-mono" />
            </Field>
          )}
          <Field label="Keep the last">
            <div className="flex items-center gap-2">
              <Input value={retention} onChange={(e) => setRetention(e.target.value.replace(/\D/g, ""))} className="w-20" inputMode="numeric" />
              <span className="text-[13px] text-muted">backups</span>
            </div>
          </Field>
          <Field label="Store in" description={props.destinations.length ? undefined : <>Add S3-compatible storage in <Link href="/integrations/storage" className="text-accent hover:underline">S3 storage</Link>.</>}>
            <Select
              value={dest}
              onValueChange={setDest}
              options={[{ value: "local", label: "This server only" }, ...props.destinations.map((d) => ({ value: d.id, label: d.name, description: d.bucket }))]}
            />
          </Field>
        </CardBody>
        <CardFooter className="justify-end">
          <Button size="sm" variant="primary" onClick={() => saveSchedule.run()} loading={saveSchedule.pending}>
            Save schedule
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
