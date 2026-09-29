"use client";

import * as React from "react";
import { Download, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CopyField } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogBody } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { changeDatabasePassword, redeployServices, updateDatabaseSettings } from "@/server/actions/databases";
import { updateService } from "@/server/actions/services";
import type { RestartPolicy } from "@/server/services/types";
import { Section, digits, num } from "./section";

export type DatabaseSettingsProps = {
  serviceId: string;
  running: boolean;
  isAdmin: boolean;
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
  };
  password: string;
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
  restartPolicy: RestartPolicy;
  stopTimeout: number | null;
  /** Called after a save that needs the container recreated. */
  onNeedsRestart: (what: string) => void;
};

function useDbSave(props: DatabaseSettingsProps, what: string) {
  const save = useAction((patch: Parameters<typeof updateDatabaseSettings>[1]) => updateDatabaseSettings(props.serviceId, patch), { success: "Saved" });
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
    success: "Password changed. The database restarts with it.",
    onSuccess: (r) => {
      setOpen(false);
      setPassword("");
      setDependents(r.dependents);
    },
  });
  const redeploy = useAction((ids: string[]) => redeployServices(ids), { success: "Redeploying", onSuccess: () => setDependents(null) });
  const { engine, config } = props;
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
            <CopyField value={props.password} secret />
          </Field>
          {engine.hasDatabase && (
            <Field label="Database" description="Created on the first start.">
              <CopyField value={config.database} />
            </Field>
          )}
        </div>
        {dependents && dependents.length > 0 && (
          <div className="flex flex-col gap-2 rounded-xl bg-warn-soft px-3.5 py-3 text-[13px] text-fg-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {dependents.map((d) => d.name).join(", ")} {dependents.length === 1 ? "uses" : "use"} this password. Redeploy so {dependents.length === 1 ? "it picks" : "they pick"}{" "}
              up the new one.
            </span>
            <Button size="sm" variant="primary" loading={redeploy.pending} onClick={() => redeploy.run(dependents.map((d) => d.id))}>
              <RefreshCw /> Redeploy {dependents.length}
            </Button>
          </div>
        )}
      </CardBody>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader title="Change password" description={`Serve changes it inside the running ${engine.label}, saves it, and restarts the database.`} />
          <DialogBody>
            <Field label="New password" optional description="Leave empty to generate a strong one. 12 to 128 letters, numbers, dots, dashes, underscores or tildes.">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Generate" className="font-mono" />
            </Field>
            {!props.running && engine.label !== "ClickHouse" && (
              <p className="flex items-start gap-1.5 text-xs text-warn">
                <TriangleAlert className="mt-px size-3.5 flex-none" /> Start the database first.
              </p>
            )}
            <p className="text-xs leading-relaxed text-muted">Apps that connect with the old password lose access until they are redeployed. Serve lists them afterwards.</p>
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
          ? "postgresql.conf settings, one per line. Serve passes them as -c options, so they win over the file in the data directory."
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
  const save = useAction((patch: Parameters<typeof updateService>[1]) => updateService(props.serviceId, patch), { success: "Saved" });
  const { config, engine } = props;
  return (
    <Section
      id="network"
      title="Runtime and network"
      description="How the container restarts and who can reach it."
      initial={{
        access: config.publicPort ? "public" : "private",
        port: String(config.publicPort ?? engine.port + 10000),
        bind: config.publicBind,
        restartPolicy: props.restartPolicy,
        stopTimeout: props.stopTimeout?.toString() ?? "",
      }}
      onSave={async (v) => {
        const r = await save.run({
          database: { publicPort: v.access === "public" ? Number(v.port) : null, publicBind: v.bind },
          runtime: { restartPolicy: v.restartPolicy, stopTimeout: num(v.stopTimeout) },
        });
        if (r !== undefined) props.onNeedsRestart("Network");
        return r;
      }}
    >
      {(v, set) => (
        <>
          <Field label="Internal connection URL" description="For services in this environment, over the private network.">
            <CopyField value={props.internalUrl} secret />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Access">
              <Select
                value={v.access}
                onValueChange={(a) => set({ access: a as "public" | "private" })}
                options={[
                  { value: "private", label: "Private", description: "Only this environment" },
                  { value: "public", label: "Public", description: "Published on a server port" },
                ]}
              />
            </Field>
            {v.access === "public" && (
              <>
                <Field label="Public port">
                  <Input value={v.port} onChange={(e) => set({ port: digits(e.target.value) })} inputMode="numeric" className="font-mono" />
                </Field>
                <Field label="Listen on">
                  <Select
                    value={v.bind}
                    onValueChange={(b) => set({ bind: b as "0.0.0.0" | "127.0.0.1" })}
                    options={[
                      { value: "0.0.0.0", label: "All interfaces" },
                      { value: "127.0.0.1", label: "This server only", description: "localhost / SSH tunnel" },
                    ]}
                  />
                </Field>
              </>
            )}
          </div>
          {v.access === "public" && v.bind === "0.0.0.0" && (
            <p className="flex items-start gap-1.5 text-xs text-warn">
              <TriangleAlert className="mt-px size-3.5 flex-none" /> Anyone who can reach the server can try to log in. Use a strong password, TLS, and a firewall.
            </p>
          )}
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
      description="Encrypts connections with a certificate from a private authority Serve creates for this database. Applies on restart."
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
                  ? "Postgres always offers TLS; Require sets sslmode=require in the connection URLs Serve generates."
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
