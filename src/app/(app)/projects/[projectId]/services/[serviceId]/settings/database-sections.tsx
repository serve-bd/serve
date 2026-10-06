"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CopyField } from "@/components/ui/misc";
import { SecretField } from "@/components/ui/secret-field";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogBody } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import {
  changeDatabasePassword,
  mainDatabaseChoices,
  setMainDatabase,
  databaseAddonStatus,
  redeployServices,
  setDatabasePooler,
  promoteDatabaseReplica,
  setDatabaseReplicas,
  updateDatabaseSettings,
} from "@/server/actions/databases";
import { updateService } from "@/server/actions/services";
import type { RestartPolicy } from "@/server/services/types";
import { Section, digits, num } from "./section";
import { cn } from "@/lib/utils";

export type DatabaseSettingsProps = {
  serviceId: string;
  running: boolean;
  isAdmin: boolean;
  /** Choosing the main database needs services.manage, like on Overview. */
  canManage: boolean;
  config: {
    engine: string;
    version: string;
    username: string;
    database: string;
    description: string | null;
    image: string | null;
    initdbArgs: string | null;
    hostAuthMethod: "scram-sha-256" | "md5" | "trust" | null;
    charset: string | null;
    collation: string | null;
    initScripts: { name: string; content: string }[];
    customConfig: string | null;
    extraArgs: string | null;
    tls: { enabled: boolean; mode?: "prefer" | "require" } | null;
    healthcheck: { interval?: number | null; timeout?: number | null; retries?: number | null; startPeriod?: number | null } | null;
    publicPort: number | null;
    publicBind: "0.0.0.0" | "127.0.0.1";
    pooler: { enabled: boolean; mode: "transaction" | "session"; poolSize: number; maxClients: number } | null;
    replica: { enabled: boolean; instances: { id: string; serverId: string }[]; primed?: boolean } | null;
  };
  /** Servers a replica can run on: the database's own and those linked to it privately. */
  replicaServers: { id: string; name: string; home: boolean; linked: boolean }[];
  password: string;
  /** The role cannot see secret values: the password arrives masked. */
  hideSecrets?: boolean;
  engine: {
    label: string;
    image: string;
    versions: string[];
    port: number;
    hasUser: boolean;
    hasDatabase: boolean;
    initScripts: boolean;
    config: { kind: "pg-args" | "file"; placeholder: string; path: string | null };
    tls: boolean;
    healthcheck: string;
  };
  internalUrl: string;
  /** Connection URLs through the pooler (PostgreSQL) and to the read replicas. */
  poolerUrl: string;
  replicaUrl: string;
  /** The name other services use in references: ${{<refName>.DATABASE_URL}}. */
  refName: string;
  restartPolicy: RestartPolicy;
  stopTimeout: number | null;
  /** Called after a save that needs the container recreated. */
  onNeedsRestart: (what: string) => void;
};

function useDbSave(props: DatabaseSettingsProps, what: string) {
  const save = useAction((patch: Parameters<typeof updateDatabaseSettings>[1]) => updateDatabaseSettings(props.serviceId, patch));
  return async (patch: Parameters<typeof updateDatabaseSettings>[1]) => {
    const r = await save.run(patch);
    if (r?.restart) props.onNeedsRestart(what);
    return r;
  };
}

function DetailsSection(props: DatabaseSettingsProps) {
  const saveDb = useDbSave(props, "Image");
  const saveVersion = useAction((version: string) => updateService(props.serviceId, { database: { version } }), {});
  const { config, engine } = props;
  return (
    <Section
      id="details"
      title="Details"
      description={`The ${engine.label} image and a note for your team.`}
      initial={{ description: config.description ?? "", mode: config.image ? "custom" : "official", version: config.version, image: config.image ?? "" }}
      onSave={async (v) => {
        if (v.mode === "official" && v.version !== config.version) {
          if ((await saveVersion.run(v.version)) === undefined) return undefined;
          if (!config.image) props.onNeedsRestart("Version");
        }
        return saveDb({ description: v.description, image: v.mode === "custom" ? v.image : null });
      }}
    >
      {(v, set) => (
        <>
          <Field label="Description" optional>
            <Input value={v.description} onChange={(e) => set({ description: e.target.value })} placeholder="Primary database for the API" />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[200px_minmax(0,1fr)]">
            <Field label="Image">
              <Select
                value={v.mode}
                onValueChange={(m) => set({ mode: m as "official" | "custom" })}
                options={[
                  { value: "official", label: `Official ${engine.label}`, description: engine.image },
                  { value: "custom", label: "Custom image", description: "Extensions, forks or a pinned digest" },
                ]}
              />
            </Field>
            {v.mode === "official" ? (
              <Field label="Version" description="A new major version may need a manual upgrade. Back up first.">
                <Select value={v.version} onValueChange={(x) => set({ version: x })} options={engine.versions.map((x) => ({ value: x, label: `${engine.image}:${x}` }))} />
              </Field>
            ) : (
              <Field
                label="Image reference"
                description={`Must be a ${engine.label} image, like ${engine.image === "postgres" ? "pgvector/pgvector:pg17 or timescale/timescaledb:latest-pg17" : `${engine.image}:latest`}.`}
              >
                <Input value={v.image} onChange={(e) => set({ image: e.target.value })} placeholder={`${engine.image}:${config.version}`} className="font-mono text-[13px]" />
              </Field>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

function CredentialsSection(props: DatabaseSettingsProps) {
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [dependents, setDependents] = React.useState<{ id: string; name: string }[] | null>(null);
  const change = useAction((pw: string) => changeDatabasePassword(props.serviceId, pw || undefined), {
    onSuccess: (r) => {
      setOpen(false);
      setPassword("");
      setDependents(r.dependents);
    },
  });
  const redeploy = useAction((ids: string[]) => redeployServices(ids), { onSuccess: () => setDependents(null) });
  const { engine, config } = props;
  // The main database: the one the connection URL names. Another one on the server can take its place.
  const [picking, setPicking] = React.useState<string[] | null>(null);
  const [main, setMain] = React.useState(config.database);
  const loadChoices = useAction(() => mainDatabaseChoices(props.serviceId), {
    onSuccess: (r) => {
      setMain(r.main ?? config.database);
      setPicking(r.databases);
    },
  });
  const changeMain = useAction((name: string) => setMainDatabase(props.serviceId, name), {
    onSuccess: (r) => {
      setPicking(null);
      setDependents(r.dependents);
    },
  });
  const canPickMain = props.canManage && props.running && ["postgres", "mysql", "mariadb"].includes(config.engine);
  return (
    <Card id="credentials" className="scroll-mt-6">
      <CardHeader
        title="Credentials"
        description="Services in this environment get these through ${{name.PASSWORD}} and ${{name.DATABASE_URL}} references."
        actions={
          props.isAdmin && (
            <Button size="sm" onClick={() => setOpen(true)}>
              <KeyRound /> Change password
            </Button>
          )
        }
      />
      <CardBody className="flex flex-col gap-4 py-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {engine.hasUser && (
            <Field label="Username">
              <CopyField value={config.username} />
            </Field>
          )}
          <Field label="Password">
            <SecretField value={props.password} hidden={props.hideSecrets} />
          </Field>
          {engine.hasDatabase && (
            <Field
              label="Database"
              description={
                canPickMain ? (
                  <>
                    The one the connection URL names.{" "}
                    <button type="button" className="text-accent hover:underline" onClick={() => loadChoices.run()} disabled={loadChoices.pending}>
                      Use another
                    </button>
                  </>
                ) : (
                  "Created on the first start."
                )
              }
            >
              <CopyField value={config.database} />
            </Field>
          )}
        </div>
        {dependents && dependents.length > 0 && (
          <div className="flex flex-col gap-2 rounded-xl bg-warn-soft px-3.5 py-3 text-[13px] text-fg-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {dependents.map((d) => d.name).join(", ")} {dependents.length === 1 ? "connects" : "connect"} with these credentials. Redeploy so{" "}
              {dependents.length === 1 ? "it picks" : "they pick"} them up.
            </span>
            <Button size="sm" variant="primary" loading={redeploy.pending} onClick={() => redeploy.run(dependents.map((d) => d.id))}>
              <RefreshCw /> Redeploy {dependents.length}
            </Button>
          </div>
        )}
      </CardBody>
      <Dialog open={!!picking} onOpenChange={(o) => !o && setPicking(null)}>
        <DialogContent size="sm">
          <DialogHeader
            title="Main database"
            description="The connection URL and ${{name.DATABASE_URL}} name this database. Apps that use them pick it up when they are redeployed."
          />
          <DialogBody>
            <Field label="Database">
              <Select value={main} onValueChange={setMain} options={(picking ?? []).map((d) => ({ value: d, label: d }))} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPicking(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={changeMain.pending} disabled={main === config.database} onClick={() => changeMain.run(main)}>
              Use {main}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader title="Change password" description={`The password is changed inside the running ${engine.label} and saved, then the database restarts.`} />
          <DialogBody>
            {/* Choosing a password needs secret access; without it a strong one is generated. */}
            {!props.hideSecrets && (
              <Field label="New password" optional description="Leave empty to generate a strong one. 12 to 128 letters, numbers, dots, dashes, underscores or tildes.">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Generate" className="font-mono" />
              </Field>
            )}
            {!props.running && engine.label !== "ClickHouse" && (
              <p className="flex items-start gap-1.5 text-xs text-warn">
                <TriangleAlert className="mt-px size-3.5 flex-none" /> Start the database first.
              </p>
            )}
            <p className="text-xs leading-relaxed text-muted">Apps that connect with the old password lose access until they are redeployed. They are listed afterwards.</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={change.pending}
              onClick={async () => {
                if (
                  await confirm({
                    title: "Change the database password?",
                    description: "Connected apps keep working only after they are redeployed.",
                    confirmLabel: "Change password",
                  })
                )
                  change.run(password);
              }}
            >
              Change password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function InitializationSection(props: DatabaseSettingsProps) {
  const saveDb = useDbSave(props, "Initialization");
  const { config, engine } = props;
  const pg = config.engine === "postgres";
  const mysql = config.engine === "mysql" || config.engine === "mariadb";
  if (!pg && !mysql && !engine.initScripts) return null;
  return (
    <Section
      id="initialization"
      title="Initialization"
      description="Used when the database starts on an empty volume. Changing these later does not touch existing data."
      initial={{
        initdbArgs: config.initdbArgs ?? "",
        hostAuthMethod: config.hostAuthMethod ?? "default",
        charset: config.charset ?? "",
        collation: config.collation ?? "",
        initScripts: config.initScripts,
      }}
      onSave={(v) =>
        saveDb({
          ...(pg ? { initdbArgs: v.initdbArgs, hostAuthMethod: v.hostAuthMethod === "default" ? null : (v.hostAuthMethod as "md5") } : {}),
          ...(mysql ? { charset: v.charset, collation: v.collation } : {}),
          ...(engine.initScripts ? { initScripts: v.initScripts.filter((s) => s.name.trim() || s.content.trim()) } : {}),
        })
      }
      footerAction={
        engine.initScripts
          ? (v, set) => (
              <Button
                size="sm"
                onClick={() =>
                  set({
                    initScripts: [
                      ...v.initScripts,
                      { name: `${String(v.initScripts.length + 1).padStart(2, "0")}-init.${config.engine === "mongodb" ? "js" : "sql"}`, content: "" },
                    ],
                  })
                }
              >
                <Plus /> Add script
              </Button>
            )
          : undefined
      }
    >
      {(v, set) => (
        <>
          {pg && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="initdb arguments" optional description="POSTGRES_INITDB_ARGS, like --data-checksums --locale=en_US.UTF-8">
                <Input value={v.initdbArgs} onChange={(e) => set({ initdbArgs: e.target.value })} placeholder="--data-checksums" className="font-mono text-[13px]" />
              </Field>
              <Field label="Host authentication" description="POSTGRES_HOST_AUTH_METHOD for network connections.">
                <Select
                  value={v.hostAuthMethod}
                  onValueChange={(m) => set({ hostAuthMethod: m as typeof v.hostAuthMethod })}
                  options={[
                    { value: "default", label: "Image default (scram-sha-256)" },
                    { value: "scram-sha-256", label: "scram-sha-256" },
                    { value: "md5", label: "md5", description: "For old clients" },
                    { value: "trust", label: "trust", description: "No password. Unsafe" },
                  ]}
                />
              </Field>
            </div>
          )}
          {v.hostAuthMethod === "trust" && (
            <p className="flex items-start gap-1.5 text-xs text-bad">
              <TriangleAlert className="mt-px size-3.5 flex-none" /> trust lets anyone who reaches the database connect without a password.
            </p>
          )}
          {mysql && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Character set" optional description="--character-set-server (applies on every start)">
                <Input value={v.charset} onChange={(e) => set({ charset: e.target.value })} placeholder="utf8mb4" className="font-mono text-[13px]" />
              </Field>
              <Field label="Collation" optional description="--collation-server">
                <Input value={v.collation} onChange={(e) => set({ collation: e.target.value })} placeholder="utf8mb4_0900_ai_ci" className="font-mono text-[13px]" />
              </Field>
            </div>
          )}
          {engine.initScripts && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-fg-2">Initialization scripts</span>
                <span className="text-xs text-muted">
                  Run in name order from /docker-entrypoint-initdb.d, only when the data directory is empty. .sql, .sh{config.engine === "mongodb" ? " and .js" : " and .sql.gz"}{" "}
                  files.
                </span>
              </div>
              {v.initScripts.map((s, i) => {
                const update = (patch: Partial<typeof s>) => set({ initScripts: v.initScripts.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div key={i} className="flex flex-col gap-2 rounded-xl border border-line p-3">
                    <div className="flex gap-2">
                      <Input value={s.name} onChange={(e) => update({ name: e.target.value })} placeholder="01-schema.sql" className="h-8 font-mono text-[12.5px]" />
                      <Button variant="ghost" size="icon" onClick={() => set({ initScripts: v.initScripts.filter((_, j) => j !== i) })} aria-label="Remove script">
                        <Trash2 />
                      </Button>
                    </div>
                    <Textarea
                      value={s.content}
                      onChange={(e) => update({ content: e.target.value })}
                      rows={Math.min(18, Math.max(5, s.content.split("\n").length + 1))}
                      placeholder={config.engine === "mongodb" ? 'db.createCollection("events");' : "CREATE EXTENSION IF NOT EXISTS pg_trgm;"}
                      spellCheck={false}
                      className="font-mono text-[12.5px]"
                    />
                  </div>
                );
              })}
              {v.initScripts.length === 0 && <p className="text-[13px] text-muted">No scripts.</p>}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function ConfigurationSection(props: DatabaseSettingsProps) {
  const saveDb = useDbSave(props, "Configuration");
  const { config, engine } = props;
  const pg = engine.config.kind === "pg-args";
  return (
    <Section
      id="configuration"
      title="Configuration"
      description={
        pg
          ? "postgresql.conf settings, one per line. They are passed as -c options, so they win over the file in the data directory."
          : `Written to ${engine.config.path} and loaded on start.`
      }
      initial={{ customConfig: config.customConfig ?? "", extraArgs: config.extraArgs ?? "" }}
      onSave={(v) => saveDb({ customConfig: v.customConfig, extraArgs: v.extraArgs })}
    >
      {(v, set) => (
        <>
          <Field label={pg ? "Settings" : `Custom ${config.engine === "clickhouse" ? "configuration (XML)" : "configuration"}`} optional>
            <Textarea
              value={v.customConfig}
              onChange={(e) => set({ customConfig: e.target.value })}
              rows={Math.min(24, Math.max(8, v.customConfig.split("\n").length + 1))}
              placeholder={engine.config.placeholder}
              spellCheck={false}
              className="font-mono text-[12.5px]"
            />
          </Field>
          <Field label="Extra server arguments" optional description={`Appended to the ${engine.label} command. Quotes work like in a shell.`}>
            <Input
              value={v.extraArgs}
              onChange={(e) => set({ extraArgs: e.target.value })}
              placeholder={pg ? "-c log_statement=ddl" : config.engine.startsWith("m") ? "--max-connections=500" : ""}
              className="font-mono text-[13px]"
            />
          </Field>
        </>
      )}
    </Section>
  );
}

function NetworkSection(props: DatabaseSettingsProps) {
  const save = useAction((patch: Parameters<typeof updateService>[1]) => updateService(props.serviceId, patch));
  return (
    <Section
      id="network"
      title="Runtime and network"
      description="How the container restarts, and how services in this environment reach it."
      initial={{ restartPolicy: props.restartPolicy, stopTimeout: props.stopTimeout?.toString() ?? "" }}
      onSave={async (v) => {
        const r = await save.run({ runtime: { restartPolicy: v.restartPolicy, stopTimeout: num(v.stopTimeout) } });
        if (r !== undefined) props.onNeedsRestart("Network");
        return r;
      }}
    >
      {(v, set) => (
        <>
          <Field label="Internal connection URL" description="For services in this environment, over the private network. Reaching it from outside Serve is under Public access.">
            <CopyField value={props.internalUrl} secret />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Restart policy">
              <Select
                value={v.restartPolicy}
                onValueChange={(p) => set({ restartPolicy: p as RestartPolicy })}
                options={[
                  { value: "unless-stopped", label: "Unless stopped" },
                  { value: "always", label: "Always" },
                  { value: "on-failure", label: "On failure" },
                  { value: "no", label: "Never" },
                ]}
              />
            </Field>
            <Field label="Graceful stop timeout" optional description="Seconds to flush and shut down before being killed.">
              <Input value={v.stopTimeout} onChange={(e) => set({ stopTimeout: digits(e.target.value) })} inputMode="numeric" placeholder="10" />
            </Field>
          </div>
        </>
      )}
    </Section>
  );
}

function TlsSection(props: DatabaseSettingsProps) {
  const saveDb = useDbSave(props, "TLS");
  const { config, engine } = props;
  if (!engine.tls) return null;
  const redis = config.engine === "redis" || config.engine === "valkey";
  return (
    <Section
      id="tls"
      title="TLS"
      description={<>Encrypts connections with a certificate from a private authority made for this database. Applies on restart.</>}
      initial={{ enabled: !!config.tls?.enabled, mode: config.tls?.mode ?? "prefer" }}
      onSave={(v) => saveDb({ tls: v.enabled ? { enabled: true, mode: v.mode } : null })}
      footerNote={
        config.tls?.enabled ? (
          <a href={`/api/services/${props.serviceId}/database/ca`} className="inline-flex items-center gap-1 text-accent hover:underline">
            <Download className="size-3.5" /> Download CA certificate
          </a>
        ) : undefined
      }
    >
      {(v, set) => (
        <>
          <SwitchRow
            title="Enable TLS"
            description={redis ? "The database then only accepts TLS connections (rediss://)." : "Clients can then connect with TLS."}
            checked={v.enabled}
            onCheckedChange={(c) => set({ enabled: c })}
          />
          {v.enabled && !redis && (
            <Field
              label="Mode"
              description={
                config.engine === "postgres"
                  ? "Postgres always offers TLS. Require refuses plain connections from outside the private network; inside it, apps connect with or without TLS."
                  : "Require rejects connections without TLS."
              }
            >
              <Select
                value={v.mode}
                onValueChange={(m) => set({ mode: m as "prefer" | "require" })}
                options={[
                  { value: "prefer", label: "Prefer", description: "TLS when the client supports it" },
                  { value: "require", label: "Require", description: "Only TLS connections" },
                ]}
              />
            </Field>
          )}
          {v.enabled && (
            <p className="flex items-start gap-1.5 rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-muted">
              <ShieldCheck className="mt-px size-3.5 flex-none text-ok" />
              Clients that verify certificates need the CA certificate (download it after the first restart). The certificate is valid for the private hostname and the server
              address.
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function HealthSection(props: DatabaseSettingsProps) {
  const saveDb = useDbSave(props, "Health check");
  const h = props.config.healthcheck ?? {};
  return (
    <Section
      id="health"
      title="Health check"
      description="Docker runs this check inside the container. Deploys wait until it passes."
      initial={{ interval: h.interval?.toString() ?? "", timeout: h.timeout?.toString() ?? "", retries: h.retries?.toString() ?? "", startPeriod: h.startPeriod?.toString() ?? "" }}
      onSave={(v) => saveDb({ healthcheck: { interval: num(v.interval), timeout: num(v.timeout), retries: num(v.retries), startPeriod: num(v.startPeriod) } })}
    >
      {(v, set) => (
        <>
          <Field label="Command">
            <code className="block overflow-x-auto rounded-lg bg-sunken px-3 py-2 font-mono text-[12px] whitespace-pre text-fg-2">{props.engine.healthcheck}</code>
          </Field>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Interval" description="Seconds">
              <Input value={v.interval} onChange={(e) => set({ interval: digits(e.target.value) })} inputMode="numeric" placeholder="5" />
            </Field>
            <Field label="Timeout" description="Seconds">
              <Input value={v.timeout} onChange={(e) => set({ timeout: digits(e.target.value) })} inputMode="numeric" placeholder="5" />
            </Field>
            <Field label="Retries">
              <Input value={v.retries} onChange={(e) => set({ retries: digits(e.target.value) })} inputMode="numeric" placeholder="10" />
            </Field>
            <Field label="Start period" description="Seconds">
              <Input value={v.startPeriod} onChange={(e) => set({ startPeriod: digits(e.target.value) })} inputMode="numeric" placeholder="10" />
            </Field>
          </div>
        </>
      )}
    </Section>
  );
}

/** One database settings sub-page (storage is rendered by the shared storage section). */
/** Polls how the pooler and the replica are doing, while the page is open. */
function useAddonStatus(serviceId: string, active: boolean) {
  const [status, setStatus] = React.useState<{ pooler: string | null; replicas: { id: string; state: string; lagSeconds: number | null; error?: string | null }[] } | null>(null);
  React.useEffect(() => {
    if (!active) return;
    let stop = false;
    const load = async () => {
      const r = await databaseAddonStatus(serviceId).catch(() => null);
      if (!stop && r?.ok) setStatus(r.data);
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [serviceId, active]);
  return status;
}

function PoolingSection(props: DatabaseSettingsProps) {
  const router = useRouter();
  const save = useAction((v: { enabled: boolean; mode: "transaction" | "session"; poolSize: number; maxClients: number }) => setDatabasePooler(props.serviceId, v), {
    onSuccess: () => router.refresh(),
  });
  const p = props.config.pooler;
  const status = useAddonStatus(props.serviceId, !!p?.enabled);
  return (
    <Section
      id="pooling"
      title="Connection pooling"
      description="PgBouncer in front of the database: many app connections share a few real ones. The database keeps running and its URL stays the same; apps opt in with the pooled URL."
      initial={{ enabled: !!p?.enabled, mode: p?.mode ?? ("transaction" as const), poolSize: String(p?.poolSize ?? 20), maxClients: String(p?.maxClients ?? 1000) }}
      onSave={(v) => save.run({ enabled: v.enabled, mode: v.mode, poolSize: Number(v.poolSize) || 20, maxClients: Number(v.maxClients) || 1000 })}
      footerNote={p?.enabled ? (status?.pooler === "running" ? "Running" : status ? "Not running" : undefined) : undefined}
    >
      {(v, set) => (
        <>
          <SwitchRow
            title="Enable connection pooling"
            description="Starts a pooler next to the database. No restart, no data touched."
            checked={v.enabled}
            onCheckedChange={(c) => set({ enabled: c })}
          />
          {v.enabled && (
            <>
              <Field label="Pooled URL" description={`Use \${{${props.refName}.POOLED_DATABASE_URL}} in the app's variables. Run migrations over the direct URL.`}>
                {props.hideSecrets ? <CopyField value={props.poolerUrl} /> : <SecretField value={props.poolerUrl} />}
              </Field>
              <Field
                label="Mode"
                description={
                  v.mode === "transaction"
                    ? "Most efficient. Session features (LISTEN/NOTIFY, session advisory locks, SET for the whole connection) do not work through it."
                    : "Each app connection keeps one database connection while it is open: everything works, with less saving."
                }
              >
                <Select
                  value={v.mode}
                  onValueChange={(m) => set({ mode: m as "transaction" | "session" })}
                  options={[
                    { value: "transaction", label: "Transaction", description: "A connection per transaction" },
                    { value: "session", label: "Session", description: "A connection per app connection" },
                  ]}
                />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Database connections" description="Per database and login.">
                  <Input value={v.poolSize} onChange={(e) => set({ poolSize: digits(e.target.value).slice(0, 3) })} inputMode="numeric" />
                </Field>
                <Field label="App connections" description="The most the pooler accepts.">
                  <Input value={v.maxClients} onChange={(e) => set({ maxClients: digits(e.target.value).slice(0, 5) })} inputMode="numeric" />
                </Field>
              </div>
            </>
          )}
        </>
      )}
    </Section>
  );
}

/** What each engine's replicas do and cost, in the words of the replicas card. */
function replicaFacts(engine: string) {
  switch (engine) {
    case "mysql":
      return {
        how: "it copies the database once (with every user), then follows it by GTID",
        restart: null,
        cost: "Each replica uses as much disk as the database. A replica stopped for longer than the database keeps its binary log (30 days) must be copied again: remove it and add it back.",
      };
    case "mariadb":
      return {
        how: "it copies the database once (with every user), then follows it by GTID",
        restart: "The first replica restarts the database once, for a few seconds, to turn on its binary log.",
        cost: "Each replica uses as much disk as the database. The database keeps 7 days of its binary log for replicas; one stopped for longer must be copied again: remove it and add it back.",
      };
    case "mongodb":
      return {
        how: "it joins the database's replica set, copies it, then follows every change. It takes reads but never votes or becomes the primary",
        restart: "The first replica restarts the database once, for a few seconds, to start its replica set.",
        cost: "Each replica uses as much disk as the database. Connection URLs carry directConnection=true from then on: update URLs you copied before.",
      };
    case "redis":
    case "valkey":
      return {
        how: "it copies the data once, then follows every write",
        restart: null,
        cost: "Each replica holds the whole data set in memory, like the database.",
      };
    default:
      return {
        how: "it copies the database once, then follows every change within about a second",
        restart: null,
        cost: "Each replica uses as much disk as the database. If one stops, the database keeps at most 4 GB of changes for it, so the disk cannot fill up.",
      };
  }
}

function replicaLabel(state: { state: string; lagSeconds: number | null } | undefined) {
  if (!state) return "Checking…";
  if (state.state === "following") return state.lagSeconds ? `Following, ${state.lagSeconds}s behind` : "Following, up to date";
  if (state.state === "copying") return "Copying the database";
  if (state.state === "failed") return "Not running: see its logs";
  return "Not running";
}

function ReplicaSection(props: DatabaseSettingsProps) {
  const confirm = useConfirm();
  const router = useRouter();
  const save = useAction((instances: { id?: string; serverId: string }[]) => setDatabaseReplicas(props.serviceId, instances), {
    // The saved replicas come back with their numbers: the list shows them with their status.
    onSuccess: () => router.refresh(),
  });
  const saved = props.config.replica?.enabled ? props.config.replica.instances : [];
  const promote = useAction((id: string) => promoteDatabaseReplica(props.serviceId, id), {
    onSuccess: () => router.refresh(),
  });
  const status = useAddonStatus(props.serviceId, saved.length > 0);
  const home = props.replicaServers.find((s) => s.home)?.id ?? props.replicaServers[0]?.id ?? "";
  const homeName = props.replicaServers.find((s) => s.home)?.name ?? "the database's server";
  const facts = replicaFacts(props.config.engine);
  return (
    <Section
      key={JSON.stringify(saved)}
      id="replica"
      title="Read replicas"
      description="Live read-only copies of the database, for heavy reads like reports and search. Writes still go to the database, and its URL stays the same."
      initial={{ instances: saved as { id?: string; serverId: string }[] }}
      onSave={async (v) => {
        // MariaDB and MongoDB restart once, the first time, to be ready for replicas.
        if (facts.restart && !props.config.replica?.primed && v.instances.length && props.running) {
          const ok = await confirm({
            title: "Restart the database once?",
            description: `${facts.restart} Replicas start after it.`,
            confirmLabel: "Restart and add",
          });
          if (!ok) return undefined;
        }
        const removed = saved.filter((r) => !v.instances.some((x) => x.id === r.id && x.serverId === r.serverId));
        if (removed.length) {
          const ok = await confirm({
            title: removed.length === 1 ? `Remove replica ${removed[0].id}?` : `Remove ${removed.length} replicas?`,
            description: "Their copies are deleted. Apps reading from them move to the others, or lose the read URL if none are left. The database itself is not touched.",
            confirmLabel: "Remove",
            danger: true,
          });
          if (!ok) return undefined;
        }
        return save.run(v.instances);
      }}
      footerAction={(v, set) => (
        <Button type="button" size="sm" disabled={!home} onClick={() => set({ instances: [...v.instances, { serverId: home }] })}>
          <Plus /> Add replica
        </Button>
      )}
    >
      {(v, set) => (
        <>
          {v.instances.length === 0 ? (
            <p className="text-[13px] text-muted">
              No replicas. Add one: {facts.how}. {facts.restart && !props.config.replica?.primed ? facts.restart : "The database keeps running and its data is not touched."}
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-line rounded-xl border border-line">
              {v.instances.map((r, i) => {
                const live = r.id ? status?.replicas.find((x) => x.id === r.id) : undefined;
                const tone = !r.id ? "bg-faint" : live?.state === "following" ? "bg-ok" : live?.state === "copying" || !live ? "bg-info" : "bg-bad";
                return (
                  <div key={r.id ?? `new-${i}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[13.5px] font-medium text-fg">{r.id ? `Replica ${r.id}` : "New replica"}</span>
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        <span className={cn("size-1.5 flex-none rounded-full", tone)} />
                        {r.id ? replicaLabel(live) : "Starts after you save"}
                      </span>
                      {live?.error && <span className="line-clamp-2 text-xs text-bad">{live.error}</span>}
                    </div>
                    <Select
                      size="sm"
                      aria-label="Server"
                      className="w-full sm:w-56"
                      value={r.serverId}
                      onValueChange={(serverId) => set({ instances: v.instances.map((x, j) => (j === i ? { ...x, serverId } : x)) })}
                      options={props.replicaServers.map((s) => ({
                        value: s.id,
                        label: s.name,
                        disabled: !s.linked,
                        description: s.home
                          ? "The database's server"
                          : s.linked
                            ? "Over the private network"
                            : `Not on a private network with ${homeName}. Add it under Servers → ${s.name} → Private network.`,
                      }))}
                    />
                    {r.id && saved.some((x) => x.id === r.id && x.serverId === r.serverId) && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        loading={promote.pending}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Make replica ${r.id} the database?`,
                              description: `For when the database's server is lost. The database stops (if its server answers) and starts again on ${props.replicaServers.find((s) => s.id === r.serverId)?.name ?? "the replica's server"} with this replica's data: changes it had not received yet are lost. The old data stays in its volume. Other replicas copy the new database again; public access of the pooler and replicas is turned off.`,
                              confirmLabel: "Promote",
                              danger: true,
                            })
                          )
                            promote.run(r.id!);
                        }}
                      >
                        Promote
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="ghost" aria-label="Remove replica" onClick={() => set({ instances: v.instances.filter((_, j) => j !== i) })}>
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          {v.instances.length > 0 && (
            <>
              <Field
                label="Read URL"
                description={`Use \${{${props.refName}.READ_DATABASE_URL}} for reads: it spreads them over every replica. Writes to it are refused; send them to the database URL.`}
              >
                {props.hideSecrets ? <CopyField value={props.replicaUrl} /> : <SecretField value={props.replicaUrl} />}
              </Field>
              <p className="text-xs leading-relaxed text-muted">
                One replica only: <code className="font-mono">{`\${{${props.refName}.READ_DATABASE_URL_${v.instances.find((r) => r.id)?.id ?? "1"}}}`}</code> and so on.
                {v.instances.some((r) => r.serverId !== home) &&
                  ` Replicas on another server reach the database over the private network, and apps on ${homeName} reach them the same way.`}
              </p>
              <p className="flex items-start gap-1.5 rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-muted">
                <TriangleAlert className="mt-px size-3.5 flex-none text-warn" />
                {facts.cost}
              </p>
            </>
          )}
        </>
      )}
    </Section>
  );
}

export function DatabaseSections({ section, ...props }: DatabaseSettingsProps & { section: string }) {
  switch (section) {
    case "details":
      return <DetailsSection {...props} />;
    case "credentials":
      return <CredentialsSection {...props} />;
    case "initialization":
      return <InitializationSection {...props} />;
    case "configuration":
      return <ConfigurationSection {...props} />;
    case "network":
      return <NetworkSection {...props} />;
    case "tls":
      return <TlsSection {...props} />;
    case "health":
      return <HealthSection {...props} />;
    case "pooling":
      return <PoolingSection {...props} />;
    case "replica":
      return <ReplicaSection {...props} />;
    default:
      return null;
  }
}

/** Sticky bar shown after saving settings that need the database container recreated. */
export function ApplyBar({ pending, running, onApply, applying }: { pending: string[]; running: boolean; onApply: () => void; applying: boolean }) {
  if (!pending.length) return null;
  return (
    <div className="sticky top-3 z-20 flex flex-col gap-2 rounded-xl border border-accent/30 bg-surface/95 px-4 py-3 shadow-md backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col">
        <span className="text-[13px] font-medium text-fg">Restart to apply</span>
        <span className="truncate text-xs text-muted">
          {pending.join(", ")} changed. {running ? "The database restarts with a short downtime." : "Applies on the next start."}
        </span>
      </div>
      {running && (
        <Button size="sm" variant="primary" loading={applying} onClick={onApply}>
          <RefreshCw /> Apply and restart
        </Button>
      )}
    </div>
  );
}
