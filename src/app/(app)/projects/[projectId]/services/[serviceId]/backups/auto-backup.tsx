"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Switch, SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { updateService } from "@/server/actions/services";
import { Section, digits } from "../settings/section";
import { type DatabaseChoices, DatabasePicker, defaultDatabases, savedChoice } from "./database-picker";
import { PlanEditor, StoragePlaces, fromCron, nextRuns, toCron } from "./schedule-card";

type Database = Parameters<typeof updateService>[1]["database"];

/**
 * A database's Auto backup page: cards like the settings pages, each saved on its own. The switch
 * turns the schedule on and off at once; the rest shows while it is on.
 */
export function AutoBackup(props: {
  serviceId: string;
  canEdit: boolean;
  timezone: string;
  schedule: string | null;
  retention: number;
  retentionS3: number | null;
  s3DestinationId: string | null;
  keepLocal: boolean;
  copyDestinationIds: string[];
  destinations: { id: string; name: string; bucket: string }[];
  databaseChoices: DatabaseChoices | null;
  timeoutMinutes: number | null;
  lowPriority: boolean;
  /** Left out: the engine has no users to include. */
  users?: boolean;
  verify: boolean;
  encrypted: boolean;
}) {
  const save = useAction((database: Database) => updateService(props.serviceId, { database }), {});
  const store = async (database: Database) => ((await save.run(database)) === undefined ? undefined : true);
  const on = !!props.schedule;
  const choices = props.databaseChoices;

  return (
    <div className="flex flex-col gap-6">
      <ScheduleSection {...props} save={save} />

      {on && choices && (
        <Section
          title="Databases"
          description="The databases each backup takes. Back up now can pick others."
          initial={{ dbs: choices.selected?.length ? choices.selected : defaultDatabases(choices) }}
          onSave={(v) => store({ backupDatabases: savedChoice(choices, v.dbs) })}
        >
          {(v, set) => <DatabasePicker choices={choices} value={v.dbs} onChange={(dbs) => set({ dbs })} disabled={!props.canEdit} scheduled />}
        </Section>
      )}

      {on && (
        <Section
          title="Storage"
          description="Where backups are kept, and how many."
          initial={{
            places: { bucket: props.s3DestinationId, local: !props.s3DestinationId || props.keepLocal, copies: props.copyDestinationIds },
            retention: String(props.retention),
            retentionS3: String(props.retentionS3 ?? props.retention),
          }}
          onSave={(v) =>
            store({
              s3DestinationId: v.places.bucket,
              backupLocal: !v.places.bucket || v.places.local,
              backupCopyDestinationIds: v.places.bucket ? v.places.copies.filter((c) => c !== v.places.bucket) : [],
              backupRetention: Math.max(1, Math.min(365, Number(v.retention) || 7)),
              backupRetentionS3: v.places.bucket ? Math.max(1, Math.min(3650, Number(v.retentionS3) || 7)) : null,
            })
          }
        >
          {(v, set) => (
            <>
              <StoragePlaces destinations={props.destinations} value={v.places} onChange={(places) => set({ places })} disabled={!props.canEdit} />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {v.places.local && (
                  <Field label={v.places.bucket ? "Keep on this server" : "Keep the latest"} description="Older backups are deleted.">
                    <InputGroup suffix="backups">
                      <Input value={v.retention} onChange={(e) => set({ retention: digits(e.target.value).slice(0, 3) })} inputMode="numeric" className="font-mono" />
                    </InputGroup>
                  </Field>
                )}
                {v.places.bucket && (
                  <Field label={v.places.local ? "Keep in buckets" : "Keep the latest"} description="Older copies are deleted from the buckets.">
                    <InputGroup suffix="backups">
                      <Input value={v.retentionS3} onChange={(e) => set({ retentionS3: digits(e.target.value).slice(0, 4) })} inputMode="numeric" className="font-mono" />
                    </InputGroup>
                  </Field>
                )}
              </div>
            </>
          )}
        </Section>
      )}

      {on && (
        <Section
          title="Options"
          description="How backups run."
          initial={{ timeout: props.timeoutMinutes ? String(props.timeoutMinutes) : "", lowPriority: props.lowPriority, users: !!props.users, verify: props.verify }}
          onSave={(v) =>
            store({
              backupTimeoutMinutes: v.timeout ? Math.max(1, Math.min(10080, Number(v.timeout))) : null,
              backupLowPriority: v.lowPriority,
              backupVerify: v.verify,
              ...(props.users !== undefined ? { backupUsers: v.users } : {}),
            })
          }
        >
          {(v, set) => (
            <div className="flex flex-col divide-y divide-line [&>*]:py-3 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
              <div className="flex items-start justify-between gap-6">
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-fg">Time limit</span>
                  <span className="text-[13px] text-muted">A backup that runs longer is stopped and marked failed.</span>
                </span>
                <InputGroup suffix="min" className="w-36 flex-none">
                  <Input
                    value={v.timeout}
                    onChange={(e) => set({ timeout: digits(e.target.value).slice(0, 5) })}
                    placeholder="No limit"
                    inputMode="numeric"
                    disabled={!props.canEdit}
                    aria-label="Time limit in minutes"
                  />
                </InputGroup>
              </div>
              <SwitchRow
                title="Low CPU priority"
                description="Apps get the CPU first. Backups take longer."
                checked={v.lowPriority}
                onCheckedChange={(lowPriority) => set({ lowPriority })}
                disabled={!props.canEdit}
              />
              {props.users !== undefined && (
                <SwitchRow
                  title="Include users and passwords"
                  description="Also save the server's database users, passwords and rights. A restore brings them back only when you ask."
                  checked={v.users}
                  onCheckedChange={(users) => set({ users })}
                  disabled={!props.canEdit}
                />
              )}
              <SwitchRow
                title="Test backups daily"
                description="Each day the newest backup is restored into a throwaway database to prove it works. You are notified when one fails."
                checked={v.verify}
                onCheckedChange={(verify) => set({ verify })}
                disabled={!props.canEdit}
              />
            </div>
          )}
        </Section>
      )}

      {on && (
        <Section
          title="Encryption"
          description="Backups are encrypted with your passphrase before they are stored or uploaded."
          initial={{ encrypt: props.encrypted, passphrase: "" }}
          onSave={async (v) => {
            if (!v.encrypt) return store({ backupPassphrase: null });
            // Already encrypted, no new passphrase: the current one stays.
            if (props.encrypted && !v.passphrase) return true;
            return store({ backupPassphrase: v.passphrase });
          }}
        >
          {(v, set) => (
            <>
              <SwitchRow title="Encrypt backups" checked={v.encrypt} onCheckedChange={(encrypt) => set({ encrypt })} disabled={!props.canEdit} />
              {v.encrypt && (
                <>
                  <Field
                    label={props.encrypted ? "New passphrase" : "Passphrase"}
                    optional={props.encrypted}
                    description={props.encrypted ? "Leave empty to keep the current one. Older backups keep the passphrase they were made with." : "At least 8 characters."}
                  >
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={v.passphrase}
                      onChange={(e) => set({ passphrase: e.target.value })}
                      placeholder={props.encrypted ? "••••••••" : ""}
                      disabled={!props.canEdit}
                    />
                  </Field>
                  <p className="text-xs leading-relaxed text-muted">
                    Keep it somewhere safe: without it no one can restore these backups. To open one without Serve:{" "}
                    <code className="font-mono text-[11.5px] text-fg-2">openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in FILE.enc -out FILE</code>
                  </p>
                </>
              )}
            </>
          )}
        </Section>
      )}
    </div>
  );
}

/** The schedule: its switch saves at once; a changed plan is saved with Save. */
function ScheduleSection(props: { canEdit: boolean; timezone: string; schedule: string | null; save: { run: (database: Database) => Promise<unknown>; pending: boolean } }) {
  const initial = React.useMemo(() => fromCron(props.schedule ?? "0 3 * * *"), [props.schedule]);
  const [plan, setPlan] = React.useState(initial);
  const cron = toCron(plan);
  const dirty = !!props.schedule && cron !== toCron(initial);
  const invalid = !cron || !nextRuns(cron, props.timezone, 1);
  return (
    <Card>
      <CardHeader
        title="Automatic backups"
        description={props.schedule ? "Backups run on this schedule." : "Off. Backups only run when you click Back up now."}
        actions={
          <Switch
            checked={!!props.schedule}
            onCheckedChange={(on) => void props.save.run({ backupSchedule: on ? cron : null })}
            disabled={!props.canEdit || props.save.pending}
            aria-label="Automatic backups"
          />
        }
      />
      {props.schedule && (
        <>
          <CardBody className="flex flex-col gap-5 py-5">
            <PlanEditor plan={plan} onChange={setPlan} timezone={props.timezone} />
          </CardBody>
          {props.canEdit && (
            <CardFooter>
              <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : ""}</span>
              <div className="flex flex-none gap-2">
                {dirty && (
                  <Button size="sm" variant="ghost" onClick={() => setPlan(initial)}>
                    Discard
                  </Button>
                )}
                <Button size="sm" variant="primary" onClick={() => void props.save.run({ backupSchedule: cron })} loading={props.save.pending} disabled={!dirty || invalid}>
                  Save
                </Button>
              </div>
            </CardFooter>
          )}
        </>
      )}
    </Card>
  );
}
