"use client";

import * as React from "react";
import useSWR from "swr";
import { CalendarClock, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Led } from "@/components/ui/status";
import { useConfirm } from "@/components/ui/confirm";
import { LogViewer } from "@/components/log-viewer";
import { useAction } from "@/hooks/use-action";
import { deleteTask, runTaskNow, saveTask, toggleTask } from "@/server/actions/tasks";
import { cn, formatDuration } from "@/lib/utils";

type Task = {
  id: string;
  name: string;
  schedule: string;
  command: string;
  composeService: string | null;
  enabled: boolean;
  timeoutSeconds: number;
  lastRunAt: string | null;
  lastStatus: string | null;
};
type Run = {
  id: string;
  taskId: string | null;
  command: string;
  trigger: string;
  status: string;
  exitCode: number | null;
  output: string;
  startedAt: string;
  finishedAt: string | null;
};

const presets = [
  { value: "*/5 * * * *", label: "Every 5 minutes" },
  { value: "0 * * * *", label: "Every hour" },
  { value: "0 0 * * *", label: "Every day at midnight" },
  { value: "0 3 * * 1", label: "Every Monday at 03:00" },
  { value: "custom", label: "Custom" },
];

function describe(cron: string) {
  return presets.find((p) => p.value === cron)?.label ?? cron;
}

function TaskDialog({
  open,
  onOpenChange,
  task,
  composeServices,
  onSave,
  pending,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  task: Task | null;
  composeServices: string[];
  onSave: (v: { name: string; schedule: string; command: string; composeService: string | null; timeoutSeconds: number }) => void;
  pending: boolean;
}) {
  const [name, setName] = React.useState(task?.name ?? "");
  const [preset, setPreset] = React.useState(task ? (presets.some((p) => p.value === task.schedule) ? task.schedule : "custom") : "0 * * * *");
  const [cron, setCron] = React.useState(task?.schedule ?? "0 * * * *");
  const [command, setCommand] = React.useState(task?.command ?? "");
  const [compose, setCompose] = React.useState(task?.composeService ?? composeServices[0] ?? null);
  const [timeout, setTimeoutValue] = React.useState(String(task?.timeoutSeconds ?? 3600));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave({
              name,
              schedule: preset === "custom" ? cron : preset,
              command,
              composeService: composeServices.length ? compose : null,
              timeoutSeconds: Number(timeout) || 3600,
            });
          }}
        >
          <DialogHeader title={task ? "Edit task" : "New scheduled task"} description="Runs a command inside the running service on a schedule." />
          <DialogBody>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Clear expired sessions" autoFocus />
            </Field>
            <Field label="Command">
              <Input value={command} onChange={(e) => setCommand(e.target.value)} required placeholder="npm run cron:cleanup" className="font-mono text-[13px]" />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Schedule">
                <Select value={preset} onValueChange={setPreset} options={presets} />
              </Field>
              {preset === "custom" ? (
                <Field label="Cron expression">
                  <Input value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" placeholder="30 2 * * *" />
                </Field>
              ) : (
                <Field label="Timeout (seconds)">
                  <Input value={timeout} onChange={(e) => setTimeoutValue(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
                </Field>
              )}
            </div>
            {composeServices.length > 0 && (
              <Field label="Run in">
                <Select value={compose} onValueChange={setCompose} options={composeServices.map((s) => ({ value: s, label: s }))} />
              </Field>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={pending}>
              {task ? "Save task" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TasksView({ serviceId, composeServices }: { serviceId: string; composeServices: string[] }) {
  const confirm = useConfirm();
  const { data, mutate } = useSWR<{ tasks: Task[]; runs: Run[] }>(`/api/services/${serviceId}/tasks`, {
    refreshInterval: (d) => (d?.runs.some((r) => r.status === "running") ? 1500 : 10000),
  });
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Task | null>(null);
  const [dialogKey, setDialogKey] = React.useState(0);
  const [selectedRun, setSelectedRun] = React.useState<string | null>(null);
  const save = useAction((v: Parameters<typeof saveTask>[2]) => saveTask(serviceId, editing?.id ?? null, v), {
    success: "Task saved",
    onSuccess: () => {
      setOpen(false);
      void mutate();
    },
  });
  const toggle = useAction((id: string, on: boolean) => toggleTask(id, on), { onSuccess: () => void mutate() });
  const remove = useAction(deleteTask, { success: "Task deleted", onSuccess: () => void mutate() });
  const runNow = useAction(runTaskNow, {
    success: "Task started",
    onSuccess: (d) => {
      setSelectedRun(d.id);
      void mutate();
    },
  });
  const tasks = data?.tasks ?? [];
  const runs = data?.runs ?? [];
  const run = runs.find((r) => r.id === selectedRun) ?? null;

  const openDialog = (t: Task | null) => {
    setEditing(t);
    setDialogKey((k) => k + 1);
    setOpen(true);
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex flex-col gap-6">
        <Card className="overflow-hidden">
          <CardHeader
            title="Scheduled tasks"
            description="Cron jobs that run commands inside this service."
            actions={
              <Button size="sm" variant="primary" onClick={() => openDialog(null)}>
                <Plus /> New task
              </Button>
            }
          />
          {tasks.length === 0 ? (
            <EmptyState icon={<CalendarClock />} title="No scheduled tasks" description="Run database cleanups, reports or cache warmers on a schedule." />
          ) : (
            <div className="divide-y divide-line">
              {tasks.map((t) => (
                <div key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <Led color={t.lastStatus === "failed" ? "var(--bad)" : t.lastStatus === "success" ? "var(--ok)" : "var(--idle)"} off={!t.enabled} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[14px] font-medium text-fg">{t.name}</span>
                    <span className="truncate text-xs text-muted">
                      <code className="font-mono">{t.command}</code> · {describe(t.schedule)}
                      {t.composeService && ` · ${t.composeService}`} ·{" "}
                      {t.lastRunAt ? (
                        <>
                          last run <TimeAgo date={t.lastRunAt} />
                        </>
                      ) : (
                        "never run"
                      )}
                    </span>
                  </div>
                  <Button size="icon-sm" variant="ghost" aria-label="Run now" onClick={() => runNow.run(t.id)}>
                    <Play />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => openDialog(t)}>
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Delete"
                    onClick={async () => {
                      if (await confirm({ title: `Delete ${t.name}?`, confirmLabel: "Delete task", danger: true })) remove.run(t.id);
                    }}
                  >
                    <Trash2 />
                  </Button>
                  <Switch checked={t.enabled} onCheckedChange={(on) => toggle.run(t.id, on)} />
                </div>
              ))}
            </div>
          )}
        </Card>
        {run && (
          <LogViewer
            lines={(run.output.replace(/\n+$/, "") || (run.status === "running" ? "" : "No output.")).split("\n").map((text) => ({ text }))}
            height="360px"
            emptyText="Running…"
            filename={`task-${run.id}.log`}
          />
        )}
      </div>
      <Card className="overflow-hidden">
        <CardHeader title="Recent runs" />
        {runs.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-muted">Runs appear here.</p>
        ) : (
          <div className="max-h-[560px] divide-y divide-line overflow-y-auto scrollbar-thin">
            {runs.map((r) => {
              const task = tasks.find((t) => t.id === r.taskId);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedRun(r.id)}
                  className={cn("flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-hover/50", selectedRun === r.id && "bg-accent-soft")}
                >
                  <Led color={r.status === "success" ? "var(--ok)" : r.status === "failed" ? "var(--bad)" : "var(--info)"} pulse={r.status === "running"} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] text-fg-2">{task?.name ?? r.command}</span>
                    <span className="text-xs text-faint">
                      <TimeAgo date={r.startedAt} />
                      {r.finishedAt && ` · ${formatDuration(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime())}`}
                    </span>
                  </span>
                  {r.exitCode !== null && <Badge tone={r.exitCode === 0 ? "ok" : "bad"}>exit {r.exitCode}</Badge>}
                </button>
              );
            })}
          </div>
        )}
      </Card>
      <TaskDialog key={dialogKey} open={open} onOpenChange={setOpen} task={editing} composeServices={composeServices} onSave={(v) => save.run(v)} pending={save.pending} />
    </div>
  );
}
