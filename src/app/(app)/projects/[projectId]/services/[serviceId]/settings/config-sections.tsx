"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, InputGroup, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { useConfirm } from "@/components/ui/confirm";
import { deployWithoutCache, type updateService } from "@/server/actions/services";
import { type BuildConfig, DEFAULT_CRASH_LIMIT, type KeyValue, type RuntimeConfig } from "@/server/services/types";
import { CAPABILITIES } from "@/server/deploy/options";
import { digits, KeyValueEditor, linesOf, num, Section } from "./section";
import { NixpacksHint } from "@/components/nixpacks-hint";

type Save = (patch: Parameters<typeof updateService>[1]) => Promise<unknown>;

const REDEPLOY = "Applies on the next deploy";

/* ---------------------------------- Build --------------------------------- */

export function BuildSection({
  serviceId,
  build,
  nixpacks,
  save,
  composeHref,
}: {
  serviceId: string;
  build: BuildConfig;
  nixpacks: boolean;
  save: Save;
  /** New-service form filled in with this repository, to deploy its compose file as a stack. */
  composeHref?: string;
}) {
  const fresh = useAction(() => deployWithoutCache(serviceId), { success: "Deploying without cache" });
  const router = useRouter();
  const confirm = useConfirm();
  return (
    <>
      <Section
        id="build"
        title="Build"
        description="How the image is built from your repository."
        footerNote={REDEPLOY}
        initial={{ builder: build.builder, rootDir: build.rootDir, dockerfile: build.dockerfile, target: build.target ?? "" }}
        onSave={(v) => save({ build: { builder: v.builder, rootDir: v.rootDir, dockerfile: v.dockerfile, target: v.target || null } })}
      >
        {(v, set) => (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Builder" description={nixpacks ? undefined : <NixpacksHint />}>
              <Select
                value={v.builder}
                onValueChange={async (b) => {
                  if (b !== "compose") return set({ builder: b as BuildConfig["builder"] });
                  if (
                    composeHref &&
                    (await confirm({
                      title: "Deploy the compose file as a new service?",
                      description:
                        "A compose file runs as its own service, with every container shown on its own. The new service form opens with this repository filled in. This app stays as it is until you delete it.",
                      confirmLabel: "Continue",
                    }))
                  )
                    router.push(composeHref);
                }}
                options={[
                  { value: "auto", label: "Automatic", description: "Dockerfile if present, otherwise detect" },
                  { value: "dockerfile", label: "Dockerfile" },
                  { value: "nixpacks", label: "Nixpacks", disabled: !nixpacks, description: nixpacks ? undefined : "Not installed (how to add it is below)" },
                  { value: "static", label: "Static site" },
                  ...(composeHref ? [{ value: "compose", label: "Docker Compose", description: "Runs the repository's compose file as a new service" }] : []),
                ]}
              />
            </Field>
            <Field label="Root directory" description="Build context inside the repository.">
              <InputGroup prefix="/">
                <Input value={v.rootDir.replace(/^\//, "")} onChange={(e) => set({ rootDir: `/${e.target.value.replace(/^\//, "")}` })} />
              </InputGroup>
            </Field>
            {(v.builder === "dockerfile" || v.builder === "auto") && (
              <>
                <Field label="Dockerfile path">
                  <Input value={v.dockerfile} onChange={(e) => set({ dockerfile: e.target.value })} className="font-mono text-[13px]" />
                </Field>
                <Field label="Target stage" optional>
                  <Input value={v.target} onChange={(e) => set({ target: e.target.value })} className="font-mono text-[13px]" />
                </Field>
              </>
            )}
          </div>
        )}
      </Section>

      {build.builder !== "dockerfile" && (
        <Section
          id="commands"
          title="Commands"
          description={build.builder === "auto" ? "Used when the repository has no Dockerfile. Leave empty to detect them." : "Leave empty to detect them from the project."}
          footerNote={REDEPLOY}
          initial={{
            installCommand: build.installCommand ?? "",
            buildCommand: build.buildCommand ?? "",
            startCommand: build.startCommand ?? "",
            publishDir: build.publishDir ?? "",
          }}
          onSave={(v) =>
            save({
              build: { installCommand: v.installCommand || null, buildCommand: v.buildCommand || null, startCommand: v.startCommand || null, publishDir: v.publishDir || null },
            })
          }
        >
          {(v, set) => (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Install command" optional>
                <Input value={v.installCommand} onChange={(e) => set({ installCommand: e.target.value })} placeholder="npm ci" className="font-mono text-[13px]" />
              </Field>
              <Field label="Build command" optional>
                <Input value={v.buildCommand} onChange={(e) => set({ buildCommand: e.target.value })} placeholder="npm run build" className="font-mono text-[13px]" />
              </Field>
              {build.builder !== "static" && (
                <Field label="Start command" optional>
                  <Input value={v.startCommand} onChange={(e) => set({ startCommand: e.target.value })} placeholder="npm start" className="font-mono text-[13px]" />
                </Field>
              )}
              {build.builder !== "nixpacks" && (
                <Field label="Output directory" optional description="For static sites.">
                  <Input value={v.publishDir} onChange={(e) => set({ publishDir: e.target.value })} placeholder="dist" className="font-mono text-[13px]" />
                </Field>
              )}
            </div>
          )}
        </Section>
      )}

      <Section
        id="build-options"
        title="Build options"
        description="Arguments, when to build, and the build cache."
        footerNote={REDEPLOY}
        initial={{
          buildArgs: build.buildArgs ?? ([] as KeyValue[]),
          noCache: build.noCache ?? false,
          submodules: build.submodules ?? true,
          buildTimeoutMinutes: String(build.buildTimeoutMinutes ?? ""),
          watchPaths: (build.watchPaths ?? []).join("\n"),
        }}
        onSave={(v) =>
          save({
            build: {
              buildArgs: v.buildArgs.filter((a) => a.key.trim()),
              noCache: v.noCache,
              submodules: v.submodules,
              buildTimeoutMinutes: num(v.buildTimeoutMinutes),
              watchPaths: linesOf(v.watchPaths),
            },
          })
        }
        footerAction={() => (
          <Button size="sm" onClick={() => fresh.run()} loading={fresh.pending}>
            <RefreshCw /> Deploy without cache
          </Button>
        )}
      >
        {(v, set) => (
          <>
            <Field label="Build arguments" optional description="Passed as --build-arg. Use variables marked Build time for secrets.">
              <KeyValueEditor value={v.buildArgs} onChange={(buildArgs) => set({ buildArgs })} keyPlaceholder="NODE_VERSION" valuePlaceholder="22" addLabel="Add argument" />
            </Field>
            <Field label="Watch paths" optional description="One glob per line, like src/** or !docs/**. Pushes that change none of them do not deploy. Applies to push webhooks.">
              <Textarea
                value={v.watchPaths}
                onChange={(e) => set({ watchPaths: e.target.value })}
                rows={3}
                placeholder={"apps/web/**\npackages/ui/**"}
                className="font-mono text-[12.5px]"
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Build timeout" optional description="Stop builds that run longer.">
                <InputGroup suffix="minutes">
                  <Input value={v.buildTimeoutMinutes} onChange={(e) => set({ buildTimeoutMinutes: digits(e.target.value) })} placeholder="No limit" inputMode="numeric" />
                </InputGroup>
              </Field>
            </div>
            <SwitchRow title="Git submodules" description="Clone submodules together with the repository." checked={v.submodules} onCheckedChange={(c) => set({ submodules: c })} />
            <SwitchRow
              title="Always build without cache"
              description="Slower, but every build starts from fresh base images."
              checked={v.noCache}
              onCheckedChange={(c) => set({ noCache: c })}
            />
          </>
        )}
      </Section>
    </>
  );
}

/* --------------------------------- Deploy --------------------------------- */

export function DeploySection({ runtime, save }: { runtime: RuntimeConfig; save: Save }) {
  return (
    <Section
      id="deploy"
      title="Deploy"
      description="What happens between a successful build and live traffic. A failed step keeps the previous version running."
      footerNote={REDEPLOY}
      initial={{
        preDeployCommand: runtime.preDeployCommand ?? "",
        deployStrategy: runtime.deployStrategy ?? "rolling",
        drainSeconds: String(runtime.drainSeconds ?? 3),
        restartSchedule: runtime.restartSchedule ?? "",
      }}
      onSave={(v) =>
        save({
          runtime: {
            preDeployCommand: v.preDeployCommand.trim() || null,
            deployStrategy: v.deployStrategy,
            drainSeconds: num(v.drainSeconds),
            restartSchedule: v.restartSchedule.trim() || null,
          },
        })
      }
    >
      {(v, set) => (
        <>
          <Field label="Pre-deploy command" optional description="Runs once in a container from the new image, with its variables, before traffic switches. For migrations.">
            <Input value={v.preDeployCommand} onChange={(e) => set({ preDeployCommand: e.target.value })} placeholder="npm run migrate" className="font-mono text-[13px]" />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Strategy">
              <Select
                value={v.deployStrategy}
                onValueChange={(s) => set({ deployStrategy: s as "rolling" | "recreate" })}
                options={[
                  { value: "rolling", label: "Rolling", description: "Start new, then stop old. No downtime" },
                  { value: "recreate", label: "Recreate", description: "Stop old first. For single-writer apps" },
                ]}
              />
            </Field>
            <Field label="Drain time" description="Old containers finish in-flight requests.">
              <InputGroup suffix="seconds">
                <Input
                  value={v.drainSeconds}
                  onChange={(e) => set({ drainSeconds: digits(e.target.value) })}
                  inputMode="numeric"
                  disabled={v.deployStrategy === "recreate" || runtime.ports.length > 0}
                />
              </InputGroup>
            </Field>
          </div>
          {runtime.ports.length > 0 && v.deployStrategy === "rolling" && (
            <p className="text-xs leading-relaxed text-warn">
              This app publishes host ports, and two containers cannot hold the same port: each deploy stops the old version first, like Recreate. Route traffic through a domain
              instead to deploy with no downtime.
            </p>
          )}
          <Field label="Scheduled restart" optional description="Cron expression in the server timezone, like 0 4 * * * for 04:00 every day.">
            <Input value={v.restartSchedule} onChange={(e) => set({ restartSchedule: e.target.value })} placeholder="0 4 * * *" className="font-mono text-[13px]" />
          </Field>
          <p className="text-xs leading-relaxed text-muted">
            Rollback is automatic: when the pre-deploy command or a health check fails, the new containers are removed and the previous version keeps serving.
          </p>
        </>
      )}
    </Section>
  );
}

/* ------------------------------ Health check ------------------------------ */

export function HealthSection({ runtime, save }: { runtime: RuntimeConfig; save: Save }) {
  return (
    <Section
      id="health"
      title="Health check"
      description="New containers must pass this before they get traffic."
      footerNote={REDEPLOY}
      initial={{
        path: runtime.healthcheckPath ?? "",
        port: String(runtime.healthcheckPort ?? ""),
        status: runtime.healthcheckStatus ?? "",
        timeout: String(runtime.healthcheckTimeout ?? 120),
        interval: String(runtime.healthcheckInterval ?? 1),
        startPeriod: String(runtime.healthcheckStartPeriod ?? 0),
        successes: String(runtime.healthcheckSuccesses ?? 1),
      }}
      onSave={(v) =>
        save({
          runtime: {
            healthcheckPath: v.path.trim() || null,
            healthcheckPort: num(v.port),
            healthcheckStatus: v.status.trim() || null,
            healthcheckTimeout: num(v.timeout),
            healthcheckInterval: num(v.interval),
            healthcheckStartPeriod: num(v.startPeriod),
            healthcheckSuccesses: num(v.successes),
          },
        })
      }
    >
      {(v, set) => (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Path" optional description={<>Without a path, the deploy waits for the port to accept connections.</>}>
            <Input value={v.path} onChange={(e) => set({ path: e.target.value })} placeholder="/health" className="font-mono text-[13px]" />
          </Field>
          <Field label="Port" optional description="Defaults to the app port.">
            <Input value={v.port} onChange={(e) => set({ port: digits(e.target.value) })} placeholder={String(runtime.port ?? 3000)} inputMode="numeric" />
          </Field>
          <Field label="Expected status" optional description="Default: any status below 500.">
            <Input value={v.status} onChange={(e) => set({ status: e.target.value })} placeholder="200-399" className="font-mono text-[13px]" />
          </Field>
          <Field label="Timeout" description="Give up and roll back after this long.">
            <InputGroup suffix="seconds">
              <Input value={v.timeout} onChange={(e) => set({ timeout: digits(e.target.value) })} inputMode="numeric" />
            </InputGroup>
          </Field>
          <Field label="Interval" description="Time between checks.">
            <InputGroup suffix="seconds">
              <Input value={v.interval} onChange={(e) => set({ interval: digits(e.target.value) })} inputMode="numeric" />
            </InputGroup>
          </Field>
          <Field label="Start period" description="Wait before the first check.">
            <InputGroup suffix="seconds">
              <Input value={v.startPeriod} onChange={(e) => set({ startPeriod: digits(e.target.value) })} inputMode="numeric" />
            </InputGroup>
          </Field>
          <Field label="Successes needed" description="Consecutive passing checks.">
            <Input value={v.successes} onChange={(e) => set({ successes: digits(e.target.value) })} inputMode="numeric" />
          </Field>
        </div>
      )}
    </Section>
  );
}

/* --------------------------------- Runtime -------------------------------- */

export function RuntimeSection({ runtime, save }: { runtime: RuntimeConfig; save: Save }) {
  return (
    <Section
      id="runtime"
      title="Runtime"
      description="How containers run."
      footerNote={REDEPLOY}
      initial={{
        port: String(runtime.port ?? ""),
        replicas: String(runtime.replicas),
        command: runtime.command ?? "",
        workingDir: runtime.workingDir ?? "",
        user: runtime.user ?? "",
        restartPolicy: runtime.restartPolicy,
        crashLimit: runtime.crashLimit === undefined ? String(DEFAULT_CRASH_LIMIT) : String(runtime.crashLimit ?? ""),
        stopSignal: runtime.stopSignal ?? "SIGTERM",
        stopTimeout: String(runtime.stopTimeout ?? 10),
      }}
      onSave={(v) =>
        save({
          runtime: {
            port: num(v.port),
            replicas: Math.max(1, Number(v.replicas) || 1),
            command: v.command.trim() || null,
            workingDir: v.workingDir.trim() || null,
            user: v.user.trim() || null,
            restartPolicy: v.restartPolicy,
            // Empty: never stopped for crashing.
            crashLimit: Number(v.crashLimit) > 0 ? Number(v.crashLimit) : null,
            stopSignal: v.stopSignal as RuntimeConfig["stopSignal"],
            stopTimeout: num(v.stopTimeout),
          },
        })
      }
    >
      {(v, set) => (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Port" description="The port your app listens on.">
            <Input value={v.port} onChange={(e) => set({ port: digits(e.target.value) })} inputMode="numeric" placeholder="3000" />
          </Field>
          <Field label="Replicas" description="Traffic is balanced across replicas.">
            <Input value={v.replicas} onChange={(e) => set({ replicas: digits(e.target.value) })} inputMode="numeric" />
          </Field>
          <Field label="Start command" optional description="Overrides the image's command.">
            <Input value={v.command} onChange={(e) => set({ command: e.target.value })} placeholder="node server.js" className="font-mono text-[13px]" />
          </Field>
          <Field label="Working directory" optional>
            <Input value={v.workingDir} onChange={(e) => set({ workingDir: e.target.value })} placeholder="/app" className="font-mono text-[13px]" />
          </Field>
          <Field label="User" optional description="Name or uid:gid.">
            <Input value={v.user} onChange={(e) => set({ user: e.target.value })} placeholder="1000:1000" className="font-mono text-[13px]" />
          </Field>
          <Field label="Restart policy">
            <Select
              value={v.restartPolicy}
              onValueChange={(r) => set({ restartPolicy: r as RuntimeConfig["restartPolicy"] })}
              options={[
                { value: "unless-stopped", label: "Unless stopped" },
                { value: "always", label: "Always" },
                { value: "on-failure", label: "On failure" },
                { value: "no", label: "Never" },
              ]}
            />
          </Field>
          {(v.restartPolicy === "always" || v.restartPolicy === "unless-stopped") && (
            <Field label="Stop after crashes" optional description="A replica that crashes this many times in a row stops until the next deploy or start. Empty: restart forever.">
              <InputGroup suffix="crashes">
                <Input value={v.crashLimit} onChange={(e) => set({ crashLimit: digits(e.target.value) })} inputMode="numeric" placeholder="Never" />
              </InputGroup>
            </Field>
          )}
          <Field label="Stop signal" description="Sent when a container stops.">
            <Select
              value={v.stopSignal}
              onValueChange={(s) => set({ stopSignal: s as NonNullable<RuntimeConfig["stopSignal"]> })}
              options={["SIGTERM", "SIGINT", "SIGQUIT", "SIGHUP", "SIGUSR1", "SIGUSR2"].map((s) => ({ value: s, label: s }))}
            />
          </Field>
          <Field label="Graceful stop timeout" description="Time to shut down before being killed.">
            <InputGroup suffix="seconds">
              <Input value={v.stopTimeout} onChange={(e) => set({ stopTimeout: digits(e.target.value) })} inputMode="numeric" />
            </InputGroup>
          </Field>
        </div>
      )}
    </Section>
  );
}

/* -------------------------------- Resources ------------------------------- */

export function ResourcesSection({ runtime, save }: { runtime: RuntimeConfig; save: Save }) {
  return (
    <Section
      id="resources"
      title="Resources"
      description="Per container. Leave empty for no limit."
      footerNote={REDEPLOY}
      initial={{
        cpu: String(runtime.cpuLimit ?? ""),
        memory: String(runtime.memoryLimit ?? ""),
        reservation: String(runtime.memoryReservation ?? ""),
        shm: String(runtime.shmSize ?? ""),
      }}
      onSave={(v) => save({ runtime: { cpuLimit: v.cpu ? Number(v.cpu) : null, memoryLimit: num(v.memory), memoryReservation: num(v.reservation), shmSize: num(v.shm) } })}
    >
      {(v, set) => (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="CPU limit">
            <InputGroup suffix="cores">
              <Input value={v.cpu} onChange={(e) => set({ cpu: e.target.value.replace(/[^\d.]/g, "") })} placeholder="1.0" inputMode="decimal" />
            </InputGroup>
          </Field>
          <Field label="Memory limit" description="The container is stopped above this.">
            <InputGroup suffix="MB">
              <Input value={v.memory} onChange={(e) => set({ memory: digits(e.target.value) })} placeholder="512" inputMode="numeric" />
            </InputGroup>
          </Field>
          <Field label="Memory reservation" optional description="Soft limit kept free under memory pressure.">
            <InputGroup suffix="MB">
              <Input value={v.reservation} onChange={(e) => set({ reservation: digits(e.target.value) })} placeholder="256" inputMode="numeric" />
            </InputGroup>
          </Field>
          <Field label="Shared memory" optional description="/dev/shm size, for browsers and databases.">
            <InputGroup suffix="MB">
              <Input value={v.shm} onChange={(e) => set({ shm: digits(e.target.value) })} placeholder="64" inputMode="numeric" />
            </InputGroup>
          </Field>
        </div>
      )}
    </Section>
  );
}

/* -------------------------------- Advanced -------------------------------- */

export function AdvancedSection({ runtime, save, isRootAdmin }: { runtime: RuntimeConfig; save: Save; isRootAdmin: boolean }) {
  return (
    <Section
      id="advanced"
      title="Advanced"
      description="Container options most apps never need."
      footerNote={REDEPLOY}
      initial={{
        init: runtime.init ?? true,
        extraHosts: (runtime.extraHosts ?? []).join("\n"),
        labels: runtime.labels ?? ([] as KeyValue[]),
        logMaxSizeMb: String(runtime.logMaxSizeMb ?? 20),
        logMaxFiles: String(runtime.logMaxFiles ?? 5),
        privileged: runtime.privileged ?? false,
        capAdd: runtime.capAdd ?? ([] as string[]),
      }}
      onSave={(v) =>
        save({
          runtime: {
            init: v.init,
            extraHosts: linesOf(v.extraHosts),
            labels: v.labels.filter((l) => l.key.trim()),
            logMaxSizeMb: num(v.logMaxSizeMb),
            logMaxFiles: num(v.logMaxFiles),
            ...(isRootAdmin ? { privileged: v.privileged, capAdd: v.capAdd as (typeof CAPABILITIES)[number][] } : {}),
          },
        })
      }
    >
      {(v, set) => (
        <>
          <SwitchRow
            title="Init process"
            description="Runs a tiny init as PID 1 that forwards signals and reaps zombie processes."
            checked={v.init}
            onCheckedChange={(c) => set({ init: c })}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Log file size" description="Per file, before rotating.">
              <InputGroup suffix="MB">
                <Input value={v.logMaxSizeMb} onChange={(e) => set({ logMaxSizeMb: digits(e.target.value) })} inputMode="numeric" />
              </InputGroup>
            </Field>
            <Field label="Log files kept">
              <Input value={v.logMaxFiles} onChange={(e) => set({ logMaxFiles: digits(e.target.value) })} inputMode="numeric" />
            </Field>
          </div>
          <Field label="Extra hosts" optional description="Entries added to /etc/hosts, one hostname:ip per line.">
            <Textarea value={v.extraHosts} onChange={(e) => set({ extraHosts: e.target.value })} rows={2} placeholder="db.internal:10.0.0.5" className="font-mono text-[12.5px]" />
          </Field>
          <Field label="Container labels" optional description="For external tools. Labels starting with serve. are reserved.">
            <KeyValueEditor value={v.labels} onChange={(labels) => set({ labels })} keyPlaceholder="com.example.team" valuePlaceholder="web" addLabel="Add label" />
          </Field>
          {isRootAdmin && (
            <div className="flex flex-col gap-3 rounded-xl border border-warn/25 bg-warn-soft/40 p-4">
              <p className="text-xs font-medium text-warn">Host access · Root organization only</p>
              <SwitchRow
                title="Privileged"
                description="Full access to the host's devices. Only for tools that need it, like Docker-in-Docker."
                checked={v.privileged}
                onCheckedChange={(c) => set({ privileged: c })}
              />
              <Field label="Linux capabilities" optional description="Added on top of Docker's defaults.">
                <div className="flex flex-wrap gap-1.5">
                  {CAPABILITIES.map((cap) => {
                    const on = v.capAdd.includes(cap);
                    return (
                      <button
                        key={cap}
                        type="button"
                        onClick={() => set({ capAdd: on ? v.capAdd.filter((c) => c !== cap) : [...v.capAdd, cap] })}
                        className={`rounded-md px-2 py-1 font-mono text-[11.5px] ring-1 transition-colors ${on ? "bg-accent-soft text-accent ring-accent/40" : "text-muted ring-line hover:text-fg"}`}
                      >
                        {cap}
                      </button>
                    );
                  })}
                </div>
              </Field>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
