"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, CopyField } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, InputGroup, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { applyDatabaseChanges, deleteService, regenerateWebhookSecret, updateService } from "@/server/actions/services";
import type { BuildConfig, RuntimeConfig, VolumeMount, PortMapping } from "@/server/services/types";

type Source =
  | { type: "git"; repository: string; branch: string; credentialId?: string | null }
  | { type: "image"; image: string; registryUsername: string | null; hasPassword: boolean };

type Props = {
  projectId: string;
  service: {
    id: string;
    name: string;
    slug: string;
    type: string;
    autoDeploy: boolean;
    previewsEnabled: boolean;
    isPreview: boolean;
    source: Source | null;
    build: BuildConfig | null;
    runtime: RuntimeConfig;
    compose: { mode: "inline" | "git"; content: string; path: string } | null;
    database: { engine: string; version: string } | null;
  };
  versions: string[];
  credentials: { id: string; name: string; provider: string }[];
  nixpacks: boolean;
  webhookUrl: string;
  viaGithubApp: boolean;
  webhookSecret: string;
  deployHookUrl: string;
};

/** A settings card with its own form state and save button. */
function Section<T>({
  title,
  description,
  initial,
  onSave,
  children,
  footerNote,
}: {
  title: string;
  description?: string;
  initial: T;
  onSave: (value: T) => Promise<unknown>;
  children: (value: T, set: (patch: Partial<T>) => void) => React.ReactNode;
  footerNote?: React.ReactNode;
}) {
  const [value, setValue] = React.useState<T>(initial);
  const [saved, setSaved] = React.useState(JSON.stringify(initial));
  const [pending, setPending] = React.useState(false);
  const dirty = JSON.stringify(value) !== saved;
  const set = (patch: Partial<T>) => setValue((v) => ({ ...v, ...patch }));
  return (
    <Card>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          const ok = await onSave(value);
          setPending(false);
          if (ok !== undefined) setSaved(JSON.stringify(value));
        }}
      >
        <CardHeader title={title} description={description} />
        <CardBody className="flex flex-col gap-4 py-5">{children(value, set)}</CardBody>
        <CardFooter>
          <span className="text-xs text-muted">{dirty ? "Unsaved changes" : footerNote}</span>
          <div className="flex gap-2">
            {dirty && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setValue(JSON.parse(saved))}>
                Discard
              </Button>
            )}
            <Button type="submit" variant="primary" size="sm" disabled={!dirty} loading={pending}>
              Save
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

const num = (v: string) => (v.trim() === "" ? null : Number(v));

export function ServiceSettings(props: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const { service } = props;
  const save = useAction((patch: Parameters<typeof updateService>[1]) => updateService(service.id, patch), {
    success: "Settings saved. Deploy to apply runtime changes.",
  });
  const applyDb = useAction(() => applyDatabaseChanges(service.id), { success: "Restarting the database with the new settings" });
  const regen = useAction(() => regenerateWebhookSecret(service.id), { success: "New secret generated" });
  const remove = useAction((volumes: boolean) => deleteService(service.id, volumes), {
    refresh: false,
    success: "Service deleted",
    onSuccess: () => router.replace(`/projects/${props.projectId}`),
  });
  const [removeVolumes, setRemoveVolumes] = React.useState(true);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Section title="General" initial={{ name: service.name }} onSave={(v) => save.run({ name: v.name })}>
        {(v, set) => (
          <>
            <Field label="Service name">
              <Input value={v.name} onChange={(e) => set({ name: e.target.value })} required />
            </Field>
            <Field label="Private hostname" description="Other services in this environment reach this one at this hostname.">
              <CopyField value={service.slug} />
            </Field>
          </>
        )}
      </Section>

      {service.source?.type === "git" && (
        <Section
          title="Source"
          description="The repository and branch Serve builds from."
          initial={{ repository: service.source.repository, branch: service.source.branch, credentialId: service.source.credentialId ?? "public", autoDeploy: service.autoDeploy, previewsEnabled: service.previewsEnabled }}
          onSave={(v) =>
            save.run({
              source: { type: "git", repository: v.repository, branch: v.branch, credentialId: v.credentialId === "public" ? null : v.credentialId },
              autoDeploy: v.autoDeploy,
              previewsEnabled: v.previewsEnabled,
            })
          }
        >
          {(v, set) => (
            <>
              <Field label="Repository">
                <Input value={v.repository} onChange={(e) => set({ repository: e.target.value })} className="font-mono text-[13px]" />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Branch">
                  <Input value={v.branch} onChange={(e) => set({ branch: e.target.value })} className="font-mono text-[13px]" />
                </Field>
                <Field label="Access">
                  <Select
                    value={v.credentialId}
                    onValueChange={(c) => set({ credentialId: c })}
                    options={[{ value: "public", label: "Public repository" }, ...props.credentials.map((c) => ({ value: c.id, label: c.name }))]}
                  />
                </Field>
              </div>
              <SwitchRow title="Deploy on push" description="Pushes to this branch trigger a deployment through the webhook below." checked={v.autoDeploy} onCheckedChange={(c) => set({ autoDeploy: c })} />
              {!service.isPreview && (
                <SwitchRow
                  title="Preview deployments"
                  description="Deploy every pull request to its own temporary URL, and remove it when the pull request closes. Enable pull request events on the webhook."
                  checked={v.previewsEnabled}
                  onCheckedChange={(c) => set({ previewsEnabled: c })}
                />
              )}
            </>
          )}
        </Section>
      )}

      {service.source?.type === "image" && (
        <Section
          title="Image"
          initial={{ image: service.source.image, registryUsername: service.source.registryUsername ?? "", registryPassword: "" }}
          onSave={(v) =>
            save.run({
              source: {
                type: "image",
                image: v.image,
                registryUsername: v.registryUsername || null,
                registryPassword: v.registryPassword ? v.registryPassword : v.registryUsername ? undefined : null,
              },
            })
          }
        >
          {(v, set) => (
            <>
              <Field label="Image">
                <Input value={v.image} onChange={(e) => set({ image: e.target.value })} className="font-mono text-[13px]" />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Registry username" optional>
                  <Input value={v.registryUsername} onChange={(e) => set({ registryUsername: e.target.value })} autoComplete="off" />
                </Field>
                <Field label="Registry password" optional description={service.source?.type === "image" && service.source.hasPassword ? "Leave empty to keep the saved password." : undefined}>
                  <Input type="password" value={v.registryPassword} onChange={(e) => set({ registryPassword: e.target.value })} autoComplete="new-password" />
                </Field>
              </div>
            </>
          )}
        </Section>
      )}

      {service.build && (
        <Section title="Build" description="How the image is built from your repository." initial={service.build} onSave={(v) => save.run({ build: v })}>
          {(v, set) => (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Builder">
                  <Select
                    value={v.builder}
                    onValueChange={(b) => set({ builder: b as BuildConfig["builder"] })}
                    options={[
                      { value: "auto", label: "Automatic", description: "Dockerfile if present, otherwise detect" },
                      { value: "dockerfile", label: "Dockerfile" },
                      { value: "nixpacks", label: "Nixpacks", disabled: !props.nixpacks, description: props.nixpacks ? undefined : "Not installed" },
                      { value: "static", label: "Static site" },
                    ]}
                  />
                </Field>
                <Field label="Root directory">
                  <InputGroup prefix="/">
                    <Input value={v.rootDir.replace(/^\//, "")} onChange={(e) => set({ rootDir: `/${e.target.value.replace(/^\//, "")}` })} placeholder="" />
                  </InputGroup>
                </Field>
                {(v.builder === "dockerfile" || v.builder === "auto") && (
                  <>
                    <Field label="Dockerfile path">
                      <Input value={v.dockerfile} onChange={(e) => set({ dockerfile: e.target.value })} className="font-mono text-[13px]" />
                    </Field>
                    <Field label="Target stage" optional>
                      <Input value={v.target ?? ""} onChange={(e) => set({ target: e.target.value || null })} className="font-mono text-[13px]" />
                    </Field>
                  </>
                )}
                <Field label="Install command" optional>
                  <Input value={v.installCommand ?? ""} onChange={(e) => set({ installCommand: e.target.value || null })} placeholder="npm ci" className="font-mono text-[13px]" />
                </Field>
                <Field label="Build command" optional>
                  <Input value={v.buildCommand ?? ""} onChange={(e) => set({ buildCommand: e.target.value || null })} placeholder="npm run build" className="font-mono text-[13px]" />
                </Field>
                <Field label="Start command" optional>
                  <Input value={v.startCommand ?? ""} onChange={(e) => set({ startCommand: e.target.value || null })} placeholder="npm start" className="font-mono text-[13px]" />
                </Field>
                <Field label="Output directory" optional description="For static sites.">
                  <Input value={v.publishDir ?? ""} onChange={(e) => set({ publishDir: e.target.value || null })} placeholder="dist" className="font-mono text-[13px]" />
                </Field>
              </div>
            </>
          )}
        </Section>
      )}

      {service.compose && (
        <Section
          title="Compose file"
          description={service.compose.mode === "git" ? "Read from the repository on every deploy." : "Edit the stack and deploy to apply."}
          initial={{ content: service.compose.content, path: service.compose.path }}
          onSave={(v) => save.run({ compose: service.compose?.mode === "git" ? { path: v.path } : { content: v.content } })}
        >
          {(v, set) =>
            service.compose?.mode === "git" ? (
              <Field label="Compose file path">
                <Input value={v.path} onChange={(e) => set({ path: e.target.value })} className="font-mono text-[13px]" />
              </Field>
            ) : (
              <Textarea value={v.content} onChange={(e) => set({ content: e.target.value })} rows={Math.min(30, Math.max(12, v.content.split("\n").length + 1))} className="font-mono text-[12.5px] leading-relaxed" spellCheck={false} />
            )
          }
        </Section>
      )}

      {service.type === "app" && (
        <Section
          title="Runtime"
          description="How containers run. Changes apply on the next deploy."
          initial={{
            port: String(service.runtime.port ?? ""),
            replicas: String(service.runtime.replicas),
            command: service.runtime.command ?? "",
            healthcheckPath: service.runtime.healthcheckPath ?? "",
            healthcheckTimeout: String(service.runtime.healthcheckTimeout ?? 120),
            restartPolicy: service.runtime.restartPolicy,
          }}
          onSave={(v) =>
            save.run({
              runtime: {
                port: num(v.port),
                replicas: Math.max(1, Number(v.replicas) || 1),
                command: v.command || null,
                healthcheckPath: v.healthcheckPath || null,
                healthcheckTimeout: num(v.healthcheckTimeout),
                restartPolicy: v.restartPolicy,
              },
            })
          }
        >
          {(v, set) => (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Port" description="The port your app listens on.">
                <Input value={v.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, "") })} inputMode="numeric" placeholder="3000" />
              </Field>
              <Field label="Replicas" description="Traffic is balanced across replicas.">
                <Input value={v.replicas} onChange={(e) => set({ replicas: e.target.value.replace(/\D/g, "") })} inputMode="numeric" />
              </Field>
              <Field label="Healthcheck path" optional description="Must answer before traffic switches over.">
                <Input value={v.healthcheckPath} onChange={(e) => set({ healthcheckPath: e.target.value })} placeholder="/health" className="font-mono text-[13px]" />
              </Field>
              <Field label="Healthcheck timeout" description="Seconds to wait for a healthy start.">
                <Input value={v.healthcheckTimeout} onChange={(e) => set({ healthcheckTimeout: e.target.value.replace(/\D/g, "") })} inputMode="numeric" />
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
              <Field label="Command override" optional>
                <Input value={v.command} onChange={(e) => set({ command: e.target.value })} placeholder="node server.js" className="font-mono text-[13px]" />
              </Field>
            </div>
          )}
        </Section>
      )}

      {service.type !== "compose" && (
        <Section
          title="Resources"
          description="Limits per container. Leave empty for no limit."
          initial={{ cpu: String(service.runtime.cpuLimit ?? ""), memory: String(service.runtime.memoryLimit ?? "") }}
          onSave={(v) => save.run({ runtime: { cpuLimit: v.cpu ? Number(v.cpu) : null, memoryLimit: num(v.memory) } })}
        >
          {(v, set) => (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="CPU limit">
                <InputGroup suffix="cores">
                  <Input value={v.cpu} onChange={(e) => set({ cpu: e.target.value.replace(/[^\d.]/g, "") })} placeholder="1.0" inputMode="decimal" />
                </InputGroup>
              </Field>
              <Field label="Memory limit">
                <InputGroup suffix="MB">
                  <Input value={v.memory} onChange={(e) => set({ memory: e.target.value.replace(/\D/g, "") })} placeholder="512" inputMode="numeric" />
                </InputGroup>
              </Field>
            </div>
          )}
        </Section>
      )}

      {service.type === "app" && (
        <Section
          title="Volumes"
          description="Persistent storage that survives deploys. Named volumes are managed by Serve."
          initial={{ volumes: service.runtime.volumes }}
          onSave={(v) => save.run({ runtime: { volumes: v.volumes.filter((x) => x.source && x.mountPath) } })}
        >
          {(v, set) => (
            <div className="flex flex-col gap-2">
              {v.volumes.map((vol, i) => {
                const update = (patch: Partial<VolumeMount>) => set({ volumes: v.volumes.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div key={i} className="grid grid-cols-[110px_1fr_1fr_32px] gap-2">
                    <Select size="sm" value={vol.kind} onValueChange={(k) => update({ kind: k as VolumeMount["kind"] })} options={[{ value: "volume", label: "Volume" }, { value: "bind", label: "Host path" }]} />
                    <Input value={vol.source} onChange={(e) => update({ source: e.target.value })} placeholder={vol.kind === "volume" ? "data" : "/srv/data"} className="h-8 font-mono text-[12.5px]" />
                    <Input value={vol.mountPath} onChange={(e) => update({ mountPath: e.target.value })} placeholder="/app/data" className="h-8 font-mono text-[12.5px]" />
                    <Button variant="ghost" size="icon" onClick={() => set({ volumes: v.volumes.filter((_, j) => j !== i) })} aria-label="Remove volume">
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
              <Button size="sm" variant="ghost" className="w-fit" onClick={() => set({ volumes: [...v.volumes, { kind: "volume", source: "", mountPath: "" }] })}>
                <Plus /> Add volume
              </Button>
            </div>
          )}
        </Section>
      )}

      {service.type === "app" && (
        <Section
          title="Published ports"
          description="Expose TCP/UDP ports directly on the server, for non-HTTP traffic. Only works with one replica."
          initial={{ ports: service.runtime.ports }}
          onSave={(v) => save.run({ runtime: { ports: v.ports.filter((p) => p.host && p.container) } })}
        >
          {(v, set) => (
            <div className="flex flex-col gap-2">
              {v.ports.map((p, i) => {
                const update = (patch: Partial<PortMapping>) => set({ ports: v.ports.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_84px_32px] gap-2">
                    <Input value={String(p.host || "")} onChange={(e) => update({ host: Number(e.target.value.replace(/\D/g, "")) })} placeholder="Host port" className="h-8" inputMode="numeric" />
                    <Input value={String(p.container || "")} onChange={(e) => update({ container: Number(e.target.value.replace(/\D/g, "")) })} placeholder="Container port" className="h-8" inputMode="numeric" />
                    <Select size="sm" value={p.protocol} onValueChange={(proto) => update({ protocol: proto as PortMapping["protocol"] })} options={[{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }]} />
                    <Button variant="ghost" size="icon" onClick={() => set({ ports: v.ports.filter((_, j) => j !== i) })} aria-label="Remove port">
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
              <Button size="sm" variant="ghost" className="w-fit" onClick={() => set({ ports: [...v.ports, { host: 0, container: 0, protocol: "tcp" }] })}>
                <Plus /> Add port
              </Button>
            </div>
          )}
        </Section>
      )}

      {service.database && (
        <Section
          title="Version"
          description="Changing the major version of a database may need a manual migration. Back up first."
          initial={{ version: service.database.version }}
          onSave={async (v) => {
            const r = await save.run({ database: { version: v.version } });
            if (r !== undefined) await applyDb.run();
            return r;
          }}
        >
          {(v, set) => (
            <Field label="Image tag">
              <Select value={v.version} onValueChange={(x) => set({ version: x })} options={props.versions.map((x) => ({ value: x, label: x }))} />
            </Field>
          )}
        </Section>
      )}

      {service.type !== "database" && (
        <Card>
          <CardHeader title="Webhooks" description="Trigger deployments from your Git provider or CI." />
          <CardBody className="flex flex-col gap-4 py-5">
            {props.viaGithubApp ? (
              <p className="flex items-start gap-2 rounded-xl bg-ok-soft px-3.5 py-3 text-[13px] leading-relaxed text-fg-2">
                <Check className="mt-0.5 size-4 shrink-0 text-ok" />
                Push and pull request events arrive automatically through the GitHub App. No webhook setup is needed.
              </p>
            ) : (
              <Field label="Git webhook URL" description="Add to GitHub, GitLab or Gitea as a push webhook. Use the secret below. Content type: application/json.">
                <CopyField value={props.webhookUrl} />
              </Field>
            )}
            <Field label="Webhook secret">
              <div className="flex gap-2">
                <CopyField value={props.webhookSecret} secret className="flex-1" />
                <Button
                  onClick={async () => {
                    if (await confirm({ title: "Generate a new secret?", description: "Existing webhooks and deploy hooks stop working until you update them.", confirmLabel: "Generate" })) regen.run();
                  }}
                  loading={regen.pending}
                >
                  <RefreshCw /> Rotate
                </Button>
              </div>
            </Field>
            <Field label="Deploy hook" description="POST to this URL from CI to deploy the latest commit.">
              <CopyField value={props.deployHookUrl} secret />
            </Field>
          </CardBody>
        </Card>
      )}

      <Card className="border-bad/30">
        <CardHeader title="Delete service" description="Stops and removes all containers, images and domains for this service." />
        <CardBody className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-[13px] text-fg-2">
            <Checkbox checked={removeVolumes} onCheckedChange={(c) => setRemoveVolumes(!!c)} />
            Also delete volumes and stored data
          </label>
        </CardBody>
        <CardFooter className="justify-end">
          <Button
            variant="danger"
            size="sm"
            loading={remove.pending}
            onClick={async () => {
              if (
                await confirm({
                  title: `Delete ${service.name}?`,
                  description: removeVolumes ? "All data stored in volumes is permanently deleted. This cannot be undone." : "Volumes are kept and can be reused by a new service with the same name.",
                  confirmLabel: "Delete service",
                  danger: true,
                  typeToConfirm: service.name,
                })
              )
                remove.run(removeVolumes);
            }}
          >
            <Trash2 /> Delete service
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
