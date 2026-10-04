"use client";

import { TimeInput } from "@/components/ui/time-input";
import * as React from "react";
import Link from "next/link";
import { CronExpressionParser } from "cron-parser";
import { CalendarClock, Check, Cloud, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { useNow } from "@/hooks/use-client";
import { updateService } from "@/server/actions/services";
import { saveComposeBackup } from "@/server/actions/compose-backups";
import { cn } from "@/lib/utils";
import { type DatabaseChoices, DatabasePicker, defaultDatabases, savedChoice } from "./database-picker";

type Mode = "hourly" | "daily" | "weekly" | "custom";
type Plan = { mode: Mode; everyHours: number; minute: number; time: string; days: number[]; cron: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = [1, 2, 3, 4, 6, 8, 12];
const pad = (n: number) => String(n).padStart(2, "0");

/** Cron for a plan. */
function toCron(p: Plan) {
  const [h, m] = p.time.split(":").map(Number);
  if (p.mode === "hourly") return `${p.minute} ${p.everyHours === 1 ? "*" : `*/${p.everyHours}`} * * *`;
  if (p.mode === "daily") return `${m} ${h} * * *`;
  if (p.mode === "weekly") return `${m} ${h} * * ${[...p.days].sort().join(",") || "0"}`;
  return p.cron.trim();
}

/** Best-effort reverse of toCron so saved schedules open in the friendly editor. */
function fromCron(cron: string | null): Plan {
  const base: Plan = { mode: "daily", everyHours: 6, minute: 0, time: "03:00", days: [0], cron: cron ?? "" };
  if (!cron) return base;
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  const num = (v: string) => /^\d+$/.test(v);
  if (dom === "*" && mon === "*" && dow === "*" && num(min)) {
    if (hour === "*") return { ...base, mode: "hourly", everyHours: 1, minute: Number(min) };
    const every = hour.match(/^\*\/(\d+)$/);
    if (every && HOURS.includes(Number(every[1]))) return { ...base, mode: "hourly", everyHours: Number(every[1]), minute: Number(min) };
    if (num(hour)) return { ...base, mode: "daily", time: `${pad(Number(hour))}:${pad(Number(min))}` };
  }
  if (dom === "*" && mon === "*" && num(min) && num(hour) && /^[0-6](,[0-6])*$/.test(dow)) {
    return { ...base, mode: "weekly", time: `${pad(Number(hour))}:${pad(Number(min))}`, days: dow.split(",").map(Number) };
  }
  return { ...base, mode: "custom" };
}

function nextRuns(cron: string, tz: string, count = 3, from?: number): Date[] | null {
  try {
    const it = CronExpressionParser.parse(cron, { tz, currentDate: from });
    return Array.from({ length: count }, () => it.next().toDate());
  } catch {
    return null;
  }
}

export function ScheduleCard(props: {
  serviceId: string;
  /** A compose stack's backup key; saved on the stack instead of the database service. */
  target?: string | null;
  /** "copies" for volumes and folders, "dumps" for databases. */
  noun?: string;
  schedule: string | null;
  retention: number;
  retentionS3: number | null;
  s3DestinationId: string | null;
  /** With a bucket: copies stay on the server too (default). */
  keepLocal?: boolean;
  destinations: { id: string; name: string; bucket: string }[];
  timezone: string;
  canEdit: boolean;
  /** A database service whose backups can take several databases: which ones the schedule takes. */
  databaseChoices?: DatabaseChoices | null;
  /** Database dumps: minutes a backup may take (null: no limit), and whether it runs at low CPU priority. */
  timeoutMinutes?: number | null;
  lowPriority?: boolean;
}) {
  const dumps = props.noun !== "copies";
  const choices = props.databaseChoices ?? null;
  const [dbs, setDbs] = React.useState<string[]>(() => (choices ? (choices.selected?.length ? choices.selected : defaultDatabases(choices)) : []));
  const initial = React.useMemo(
    () => ({
      enabled: !!props.schedule,
      plan: fromCron(props.schedule),
      retention: String(props.retention),
      retentionS3: String(props.retentionS3 ?? props.retention),
      bucket: props.s3DestinationId,
      // Without a bucket, the server is the only place.
      local: !props.s3DestinationId || props.keepLocal !== false,
      timeout: props.timeoutMinutes ? String(props.timeoutMinutes) : "",
      lowPriority: !!props.lowPriority,
    }),
    [props.schedule, props.retention, props.retentionS3, props.s3DestinationId, props.keepLocal, props.timeoutMinutes, props.lowPriority],
  );
  const [enabled, setEnabled] = React.useState(initial.enabled);
  const [plan, setPlan] = React.useState<Plan>(initial.plan);
  const [retention, setRetention] = React.useState(initial.retention);
  const [retentionS3, setRetentionS3] = React.useState(initial.retentionS3);
  const [bucket, setBucket] = React.useState(initial.bucket);
  const [local, setLocal] = React.useState(initial.local);
  const [timeout, setTimeoutValue] = React.useState(initial.timeout);
  const [lowPriority, setLowPriority] = React.useState(initial.lowPriority);
  // The plan only counts while the schedule is on: turned off, the saved schedule has none.
  const [saved, setSaved] = React.useState(() =>
    JSON.stringify({ ...initial, plan: initial.enabled ? initial.plan : null, dbs: props.databaseChoices?.selected?.length ? [...props.databaseChoices.selected].sort() : null }),
  );

  const cron = toCron(plan);
  // The run times wait for the browser clock, so the server render matches the first client one.
  const now = useNow();
  const runs = enabled && now ? nextRuns(cron, props.timezone, 3, now) : null;
  const invalid = enabled && (!cron || !nextRuns(cron, props.timezone, 1));
  const snapshot = JSON.stringify({
    enabled,
    plan: enabled ? plan : null,
    retention,
    retentionS3,
    bucket,
    local,
    timeout,
    lowPriority,
    dbs: choices ? savedChoice(choices, dbs) : null,
  });
  const dirty = snapshot !== saved;
  const set = (patch: Partial<Plan>) => setPlan((p) => ({ ...p, ...patch }));

  const save = useAction(
    () => {
      const keep = Math.max(1, Math.min(365, Number(retention) || 7));
      const keepS3 = bucket ? Math.max(1, Math.min(3650, Number(retentionS3) || Number(retention) || 7)) : null;
      const onServer = !bucket || local;
      const minutes = timeout ? Math.max(1, Math.min(10080, Number(timeout))) : null;
      if (props.target)
        return saveComposeBackup(props.serviceId, props.target, {
          schedule: enabled ? cron : null,
          retention: keep,
          retentionS3: keepS3,
          s3DestinationId: bucket,
          local: onServer,
          timeoutMinutes: minutes,
          lowPriority,
        });
      return updateService(props.serviceId, {
        database: {
          backupSchedule: enabled ? cron : null,
          backupRetention: keep,
          backupRetentionS3: keepS3,
          s3DestinationId: bucket,
          backupLocal: onServer,
          backupTimeoutMinutes: minutes,
          backupLowPriority: lowPriority,
          ...(choices ? { backupDatabases: savedChoice(choices, dbs) } : {}),
        },
      });
    },
    { onSuccess: () => setSaved(snapshot) },
  );

  const fmt = new Intl.DateTimeFormat(undefined, { timeZone: props.timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <Card className="h-fit">
      <CardHeader
        title="Automatic backups"
        description={`Scheduled ${props.noun ?? "dumps"} with automatic cleanup.`}
        actions={<Switch checked={enabled} onCheckedChange={setEnabled} disabled={!props.canEdit} aria-label="Automatic backups" />}
      />
      <CardBody className="flex flex-col gap-5 py-5">
        {!enabled ? (
          <p className="text-[13px] leading-relaxed text-muted">Off. Backups only run when you click Back up now. Turn this on to take them on a schedule.</p>
        ) : (
          <>
            <Field label="How often">
              <div className="grid grid-cols-4 gap-1 rounded-xl bg-sunken p-1">
                {(["hourly", "daily", "weekly", "custom"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => set({ mode: m, cron: m === "custom" && plan.mode !== "custom" ? cron : plan.cron })}
                    className={cn(
                      "h-8 rounded-lg text-[12.5px] font-medium capitalize transition-all",
                      plan.mode === m ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </Field>

            {plan.mode === "hourly" && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Every">
                  <Select
                    size="sm"
                    value={String(plan.everyHours)}
                    onValueChange={(v) => set({ everyHours: Number(v) })}
                    options={HOURS.map((h) => ({ value: String(h), label: h === 1 ? "hour" : `${h} hours` }))}
                  />
                </Field>
                <Field label="At minute">
                  <Select
                    size="sm"
                    value={String(plan.minute)}
                    onValueChange={(v) => set({ minute: Number(v) })}
                    options={[0, 15, 30, 45].map((m) => ({ value: String(m), label: `:${pad(m)}` }))}
                  />
                </Field>
              </div>
            )}

            {(plan.mode === "daily" || plan.mode === "weekly") && (
              <>
                {plan.mode === "weekly" && (
                  <Field label="On">
                    <div className="grid grid-cols-7 gap-1">
                      {DAYS.map((d, i) => {
                        const on = plan.days.includes(i);
                        return (
                          <button
                            key={d}
                            type="button"
                            onClick={() => set({ days: on ? plan.days.filter((x) => x !== i) : [...plan.days, i] })}
                            className={cn(
                              "h-8 rounded-lg text-[12px] font-medium ring-1 transition-colors",
                              on ? "bg-accent text-accent-fg ring-accent" : "text-fg-2 ring-line hover:bg-hover",
                            )}
                            aria-pressed={on}
                            aria-label={d}
                            title={d}
                          >
                            {d.slice(0, 2)}
                          </button>
                        );
                      })}
                    </div>
                  </Field>
                )}
                <Field label="At" description={`Time in ${props.timezone.replace(/_/g, " ")}. Change it in Settings → General.`}>
                  <TimeInput value={plan.time} onChange={(time) => set({ time })} />
                </Field>
              </>
            )}

            {plan.mode === "custom" && (
              <Field label="Cron expression" description="minute hour day-of-month month day-of-week" error={invalid ? "This is not a valid cron expression." : undefined}>
                <Input value={plan.cron} onChange={(e) => set({ cron: e.target.value })} placeholder="30 2 * * *" className="font-mono" />
              </Field>
            )}

            {runs && (
              <div className="flex gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3 text-[12.5px]">
                <CalendarClock className="mt-0.5 size-4 flex-none text-accent" />
                <div className="min-w-0">
                  <p className="font-medium text-fg">Next backup {fmt.format(runs[0])}</p>
                  <p className="text-muted">
                    Then{" "}
                    {runs
                      .slice(1)
                      .map((d) => fmt.format(d))
                      .join(", ")}
                  </p>
                </div>
              </div>
            )}

            {/* Two columns only when there are two fields: one alone takes the full width. */}
            <div className={cn("grid grid-cols-1 gap-4", bucket && local && "sm:grid-cols-2")}>
              {local && (
                <Field label={bucket ? "Keep on this server" : "Keep the latest"} description="Older copies are deleted automatically.">
                  <InputGroup suffix="backups" className="w-full">
                    <Input
                      value={retention}
                      onChange={(e) => setRetention(e.target.value.replace(/\D/g, "").slice(0, 3))}
                      inputMode="numeric"
                      className="min-w-0 flex-1 font-mono"
                    />
                  </InputGroup>
                </Field>
              )}
              {bucket && (
                <Field
                  label={local ? "Keep in bucket" : "Keep the latest"}
                  description={local ? "Usually longer: off-site history." : "Older copies are deleted from the bucket automatically."}
                >
                  <InputGroup suffix="backups" className="w-full">
                    <Input
                      value={retentionS3}
                      onChange={(e) => setRetentionS3(e.target.value.replace(/\D/g, "").slice(0, 4))}
                      inputMode="numeric"
                      className="min-w-0 flex-1 font-mono"
                    />
                  </InputGroup>
                </Field>
              )}
            </div>
          </>
        )}

        {choices && (
          <Field label="Databases to back up" description="Every backup takes these, also Back up now (which can pick others).">
            <DatabasePicker choices={choices} value={dbs} onChange={setDbs} disabled={!props.canEdit} scheduled />
          </Field>
        )}

        <Field label="Store backups in">
          <div className="flex flex-col gap-2">
            {[{ id: "local", name: "This server", bucket: null as string | null }, ...props.destinations].map((d) => {
              // The server and one bucket can both be on; at least one place is always kept.
              const on = d.id === "local" ? local : bucket === d.id;
              const toggle = () => {
                if (d.id === "local") {
                  if (local && !bucket) return;
                  setLocal(!local);
                } else if (bucket === d.id) {
                  setBucket(null);
                  setLocal(true);
                } else setBucket(d.id);
              };
              const last = on && (d.id === "local" ? !bucket : !local);
              return (
                <button
                  key={d.id}
                  type="button"
                  disabled={!props.canEdit}
                  onClick={toggle}
                  title={last ? "Backups are kept somewhere: pick another place first." : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    on ? "border-accent bg-accent-soft/40" : "border-line hover:bg-hover",
                  )}
                  aria-pressed={on}
                >
                  <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-surface-2 text-fg-2">
                    {d.id === "local" ? <HardDrive className="size-4" /> : <Cloud className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-fg">{d.name}</span>
                    <span className="block truncate text-xs text-muted">{d.bucket ? `Bucket ${d.bucket}` : "Kept in the data directory; lost if the server is lost"}</span>
                  </span>
                  {on && <Check className="size-4 flex-none text-accent" />}
                </button>
              );
            })}
            {bucket && !local && (
              <p className="text-xs leading-relaxed text-muted">In the bucket only: each copy leaves the server once it is uploaded. Restores download it first.</p>
            )}
            {props.destinations.length === 0 && (
              <p className="text-xs text-muted">
                Add S3, R2 or B2 in{" "}
                <Link href="/integrations/storage" className="text-accent hover:underline">
                  S3 storage
                </Link>{" "}
                for off-site copies.
              </p>
            )}
          </div>
        </Field>
        {dumps && (
          <div className="grid grid-cols-1 gap-4 border-t border-line pt-5 sm:grid-cols-2">
            <Field label="Time limit" optional description="A backup running longer is stopped and marked failed. Also for Back up now.">
              <InputGroup suffix="minutes">
                <Input
                  value={timeout}
                  onChange={(e) => setTimeoutValue(e.target.value.replace(/\D/g, "").slice(0, 5))}
                  placeholder="No limit"
                  inputMode="numeric"
                  disabled={!props.canEdit}
                />
              </InputGroup>
            </Field>
            <Field label="Low CPU priority" description="The dump and its compression get the CPU only when the database and apps leave it free. Slower backups, steadier apps.">
              <Switch checked={lowPriority} onCheckedChange={setLowPriority} disabled={!props.canEdit} aria-label="Low CPU priority" />
            </Field>
          </div>
        )}
      </CardBody>
      {props.canEdit && (
        <CardFooter>
          <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : ""}</span>
          <div className="flex flex-none gap-2">
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEnabled(initial.enabled);
                  setPlan(initial.plan);
                  setRetention(initial.retention);
                  setRetentionS3(initial.retentionS3);
                  setBucket(initial.bucket);
                  setLocal(initial.local);
                  setTimeoutValue(initial.timeout);
                  setLowPriority(initial.lowPriority);
                }}
              >
                Discard
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => save.run()} loading={save.pending} disabled={!dirty || invalid}>
              Save
            </Button>
          </div>
        </CardFooter>
      )}
    </Card>
  );
}
