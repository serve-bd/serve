"use client";

import * as React from "react";
import { Check, ChevronDown, Database, Folder, HardDrive, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { cn } from "@/lib/utils";
import { addComposeBackup, type BackupOption, removeComposeBackup } from "@/server/actions/compose-backups";
import type { ComposeBackupConfig } from "@/server/services/types";
import { BackupsManager } from "./backups-manager";

const kindIcon = { db: Database, volume: HardDrive, dir: Folder } as const;
const kindLabel = { db: "Database", volume: "Volume", dir: "Folder" } as const;

/** Short name for a key: the compose service, the volume, or the last two parts of a folder. */
function shortName(o: { kind: BackupOption["kind"]; name: string }, slug?: string) {
  // Volumes an image declares without a name get a long random id.
  if (o.kind === "volume" && /^[0-9a-f]{64}$/.test(o.name)) return `Unnamed volume ${o.name.slice(0, 8)}`;
  // Compose names volumes <project>_<volume>; the project part is the same for all of them.
  if (o.kind === "volume" && slug && o.name.startsWith(`${slug}_`)) return o.name.slice(slug.length + 1);
  return o.kind === "dir" ? o.name.split("/").filter(Boolean).slice(-2).join("/") || o.name : o.name;
}

function describeSchedule(cfg: ComposeBackupConfig | undefined) {
  if (!cfg?.schedule) return "Manual";
  const [min, hour, dom, mon, dow] = cfg.schedule.split(/\s+/);
  if (dom === "*" && mon === "*" && dow === "*" && /^\d+$/.test(min)) {
    if (hour === "*" || /^\*\/\d+$/.test(hour)) return "Hourly";
    if (/^\d+$/.test(hour)) return "Daily";
  }
  if (dom === "*" && mon === "*" && /^[0-6](,[0-6])*$/.test(dow ?? "")) return "Weekly";
  return "Scheduled";
}

export function ComposeBackups(props: {
  serviceId: string;
  slug: string;
  /** A compose stack (database containers too); an app backs up only its volumes and folders. */
  stack: boolean;
  isAdmin: boolean;
  running: boolean;
  configs: Record<string, Omit<ComposeBackupConfig, "passphrase"> & { encrypted: boolean }>;
  /** Keys that still have backups after they were removed from the list. */
  orphaned: string[];
  databases: BackupOption[];
  storage: BackupOption[];
  destinations: { id: string; name: string; bucket: string }[];
  timezone: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const options = React.useMemo(() => new Map([...props.databases, ...props.storage].map((o) => [o.key, o])), [props.databases, props.storage]);
  const keys = React.useMemo(() => [...new Set([...Object.keys(props.configs), ...props.orphaned])], [props.configs, props.orphaned]);
  const [selected, setSelected] = React.useState<string | null>(keys[0] ?? null);
  const current = selected && keys.includes(selected) ? selected : (keys[0] ?? null);

  const add = useAction(addComposeBackup, {
    onSuccess: (r) => {
      setSelected(r.key);
      router.refresh();
    },
  });
  const remove = useAction(removeComposeBackup, { onSuccess: () => router.refresh() });

  const parse = (key: string) => {
    const i = key.indexOf(":");
    return { kind: key.slice(0, i) as BackupOption["kind"], name: key.slice(i + 1) };
  };

  const addMenu = (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="primary" loading={add.pending} />}>
        <Plus /> Add backup <ChevronDown className="opacity-70" />
      </MenuTrigger>
      <MenuContent align="end" className="max-w-[min(22rem,calc(100vw-2rem))]">
        {props.stack && (
          <>
            <MenuLabel>Database backup</MenuLabel>
            {props.databases.length === 0 && <p className="px-2.5 py-1.5 text-xs text-muted">No database containers found in the compose file.</p>}
            {props.databases.map((o) => (
              <OptionItem key={o.key} option={o} slug={props.slug} added={!!props.configs[o.key]} onPick={() => add.run(props.serviceId, o.key)} />
            ))}
            <MenuSeparator />
          </>
        )}
        <MenuLabel>Storage backup</MenuLabel>
        {props.storage.length === 0 && (
          <p className="px-2.5 py-1.5 text-xs text-muted">
            {props.stack ? "Start the stack once to list its volumes and folders." : "This app mounts no volumes or folders. Add one in Settings → Persistent storage."}
          </p>
        )}
        {props.storage.map((o) => (
          <OptionItem
            key={o.key}
            option={o}
            slug={props.slug}
            databases={props.databases.map((d) => d.name)}
            added={!!props.configs[o.key]}
            onPick={() => add.run(props.serviceId, o.key)}
          />
        ))}
      </MenuContent>
    </Menu>
  );

  if (!current) {
    const suggested = props.databases.filter((o) => !props.configs[o.key]);
    return (
      <Card>
        <CardHeader
          title="Backups"
          description={
            props.stack
              ? "Database dumps and copies of volumes and folders, on a schedule, kept here and in a bucket."
              : "Copies of this app's volumes and folders, on a schedule, kept here and in a bucket."
          }
          actions={props.isAdmin ? addMenu : null}
        />
        <div className="flex flex-col items-center gap-3 px-5 pt-6 pb-8 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl bg-fg/[0.05] text-muted [&_svg]:size-5">{props.stack ? <Database /> : <HardDrive />}</span>
          <div className="flex flex-col gap-1">
            <p className="text-[14px] font-medium text-fg">Nothing is backed up yet</p>
            <p className="max-w-md text-[13px] text-muted">
              {suggested.length
                ? `This stack runs ${suggested.map((o) => o.name).join(", ")}. Add a database backup to dump it on a schedule.`
                : props.stack
                  ? "Add a database or storage backup to protect this stack's data."
                  : "Add a storage backup to copy this app's volumes and folders on a schedule."}
            </p>
          </div>
          {props.isAdmin && suggested.length > 0 && (
            <div className="flex flex-wrap justify-center gap-2">
              {suggested.map((o) => (
                <Button key={o.key} size="sm" onClick={() => add.run(props.serviceId, o.key)} loading={add.pending}>
                  <Database /> Back up {o.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      </Card>
    );
  }

  const { kind, name } = parse(current);
  const option = options.get(current);
  const configured = !!props.configs[current];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Backups"
          description={
            props.stack
              ? "Database dumps and copies of volumes and folders, on a schedule, kept here and in a bucket."
              : "Copies of this app's volumes and folders, on a schedule, kept here and in a bucket."
          }
          actions={props.isAdmin ? addMenu : null}
        />
        <div className="flex gap-2 overflow-x-auto px-5 py-4 [scrollbar-width:none]">
          {keys.map((key) => {
            const p = parse(key);
            const Icon = kindIcon[p.kind] ?? HardDrive;
            const active = key === current;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelected(key)}
                title={p.name}
                className={cn(
                  "flex min-w-0 flex-none items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors",
                  active ? "border-accent/40 bg-accent-soft/50" : "border-line bg-surface hover:border-line-strong hover:bg-hover",
                )}
              >
                <Icon className={cn("size-4 flex-none", active ? "text-accent" : "text-muted")} />
                <span className="flex min-w-0 flex-col">
                  <span className="max-w-[12rem] truncate text-[13px] font-medium text-fg">{shortName(p, props.slug)}</span>
                  <span className="text-[11px] text-muted">
                    {kindLabel[p.kind]} · {props.configs[key] ? describeSchedule(props.configs[key]) : "Removed"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      <BackupsManager
        key={current}
        serviceId={props.serviceId}
        target={current}
        isAdmin={props.isAdmin}
        running={props.running && configured}
        engineLabel={name}
        extensions={[]}
        maxUpload={null}
        title={kind === "db" ? `${name} backups` : `Backups of ${shortName({ kind, name }, props.slug)}`}
        description={
          kind === "db"
            ? `Dumps of the ${name} container, taken with the database's own tools.${option ? ` Image ${option.detail}.` : ""}`
            : `A .tar.gz copy of ${kind === "volume" ? "the volume" : "the folder"} ${name}${option ? `, mounted at ${option.detail} in ${option.containers.join(", ")}` : ""}. Taken while it runs; restoring stops the containers that use it.`
        }
        restoreWhat={kind === "db" ? `The current data in ${name}` : `Everything in ${name}`}
        schedule={props.configs[current]?.schedule ?? null}
        retention={props.configs[current]?.retention ?? 7}
        retentionS3={props.configs[current]?.retentionS3 ?? null}
        keepLocal={props.configs[current]?.local !== false}
        timeoutMinutes={props.configs[current]?.timeoutMinutes ?? null}
        lowPriority={!!props.configs[current]?.lowPriority}
        encrypted={!!props.configs[current]?.encrypted}
        copyDestinationIds={props.configs[current]?.copyDestinationIds ?? []}
        keep={props.configs[current]?.keep ?? null}
        s3DestinationId={props.configs[current]?.s3DestinationId ?? null}
        destinations={props.destinations}
        timezone={props.timezone}
        aside={
          props.isAdmin && configured ? (
            <Button
              size="sm"
              variant="danger-ghost"
              className="self-start"
              loading={remove.pending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Stop backing up ${shortName({ kind, name }, props.slug)}?`,
                    description: "Its schedule is removed. Backups already taken stay until you delete them.",
                    confirmLabel: "Stop backing up",
                    danger: true,
                  })
                )
                  remove.run(props.serviceId, current);
              }}
            >
              <Trash2 /> Stop backing up
            </Button>
          ) : null
        }
      />
    </div>
  );
}

function OptionItem({ option, slug, added, databases, onPick }: { option: BackupOption; slug: string; added: boolean; databases?: string[]; onPick: () => void }) {
  const Icon = kindIcon[option.kind];
  // A database's own data volume: a copy of live files can be inconsistent, a dump is not.
  const dbFiles = option.kind !== "db" && option.containers.some((c) => databases?.includes(c));
  return (
    <MenuItem disabled={added} onClick={onPick} className="items-start">
      <Icon className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" title={option.name}>
          {option.kind === "db" ? `${option.name} database` : `${option.kind === "volume" ? "Volume" : "Folder"} ${shortName(option, slug)}`}
        </span>
        <span className="truncate text-[11px] text-muted">
          {option.kind === "db" ? (
            <span className="font-mono">{option.detail}</span>
          ) : (
            <>
              {option.containers.join(", ")} at <span className="font-mono">{option.detail}</span>
            </>
          )}
        </span>
        {dbFiles && <span className="text-[11px] text-warn">Live database files. Prefer the database backup.</span>}
      </span>
      {added && <Check className="mt-0.5 text-accent" />}
    </MenuItem>
  );
}
