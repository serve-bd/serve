"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, Check, RefreshCw, Server as ServerIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, CopyField } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { applyDatabaseChanges, deleteService, moveService, regenerateWebhookSecret, updateService } from "@/server/actions/services";
import { cn } from "@/lib/utils";
import type { BuildConfig, RuntimeConfig, VolumeMount } from "@/server/services/types";
import { Section } from "./section";
import { AdvancedSection, BuildSection, DeploySection, HealthSection, ResourcesSection, RuntimeSection } from "./config-sections";
import { ApplyBar, DatabaseSections, databaseNav, type DatabaseSettingsProps } from "./database-sections";
import { StorageSection } from "./storage-section";
import { updateDatabaseSettings } from "@/server/actions/databases";

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
    status: string;
  };
  /** Database services: everything the database sections need. */
  db: Omit<DatabaseSettingsProps, "onNeedsRestart" | "serviceId" | "running" | "restartPolicy" | "stopTimeout"> & { dataPath: string; defaultDataPath: string } | null;
  versions: string[];
  credentials: { id: string; name: string; provider: string }[];
  nixpacks: boolean;
  webhookUrl: string;
  viaGithubApp: boolean;
  webhookSecret: string;
  deployHookUrl: string;
  /** Server the service runs on, and the servers it could move to. */
  server: { id: string; name: string; host: string; isLocal: boolean };
  servers: { id: string; name: string; host: string; status: string; isLocal: boolean }[];
  /** Admin of the Root organization: may grant host access (privileged, capabilities). */
  isRootAdmin: boolean;
};

function ServerCard({ service, server, servers }: { service: Props["service"]; server: Props["server"]; servers: Props["servers"] }) {
  const router = useRouter();
  const confirm = useConfirm();
  const others = servers.filter((s) => s.id !== server.id);
  const [target, setTarget] = React.useState<string | null>(null);
  const move = useAction((force: boolean) => moveService(service.id, target!, { force }), {
    success: "Moving. The service redeploys on the new server.",
    onSuccess: () => {
      setTarget(null);
      router.refresh();
    },
  });
  const to = servers.find((s) => s.id === target);
  return (
    <Card id="server" className="scroll-mt-6">
      <CardHeader title="Server" description="The machine this service runs on." />
      <CardBody className="flex flex-col gap-4 py-5">
        <div className="flex items-center gap-3">
          <span className={cn("flex size-9 flex-none items-center justify-center rounded-[10px]", server.isLocal ? "bg-fg text-bg" : "bg-surface-2 text-fg-2 ring-1 ring-line")}>
            <ServerIcon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[14px] font-medium text-fg">{server.name}</span>
            <span className="truncate font-mono text-[12px] text-muted">{server.isLocal ? "The server Serve runs on" : server.host}</span>
          </div>
        </div>
        {!service.isPreview && others.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-end">
            <Field label="Move to" className="min-w-0 flex-1">
              <Select
                value={target}
                onValueChange={setTarget}
                placeholder="Choose a server"
                options={others.map((s) => ({
                  value: s.id,
                  label: s.isLocal ? `${s.name} (this server)` : s.name,
                  description: s.isLocal ? "Where Serve runs" : s.host,
                  disabled: !s.isLocal && s.status !== "ready",
                }))}
              />
            </Field>
            <Button
              disabled={!target}
              loading={move.pending}
              onClick={async () => {
                if (!to) return;
                const isDb = service.type === "database";
                const ok = await confirm({
                  title: `Move ${service.name} to ${to.name}?`,
                  description: isDb
                    ? `The database starts empty on ${to.name}. Its data stays in a volume on ${server.name}. Back it up first and restore the backup after the move.`
                    : `Serve stops the containers on ${server.name} and deploys again on ${to.name}. Expect a short downtime. Volumes are not copied, and domains pointing at ${server.name} must be pointed at ${to.name}.`,
                  confirmLabel: isDb ? "Move without data" : "Move service",
                  danger: isDb,
                });
                if (ok) await move.run(isDb);
              }}
            >
              <ArrowRightLeft /> Move
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function ServiceSettings(props: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const { service } = props;
  const save = useAction((patch: Parameters<typeof updateService>[1]) => updateService(service.id, patch), {
    success: "Settings saved. Deploy to apply runtime changes.",
  });
  const [pendingApply, setPendingApply] = React.useState<string[]>([]);
  const needsRestart = React.useCallback((what: string) => setPendingApply((p) => (p.includes(what) ? p : [...p, what])), []);
  const applyDb = useAction(() => applyDatabaseChanges(service.id), { success: "Restarting the database with the new settings", onSuccess: () => setPendingApply([]) });
  const isDb = service.type === "database";
  const running = service.status === "running" || service.status === "deploying" || service.status === "restarting";
  /** Runtime saves on a database also need a restart. */
  const saveRuntime = async (patch: Parameters<typeof updateService>[1], what: string) => {
    const r = await save.run(patch);
    if (r !== undefined && isDb) needsRestart(what);
    return r;
  };
  const saveStorage = async (volumes: VolumeMount[], dataMountPath?: string | null) => {
    const r = await save.run({ runtime: { volumes } });
    if (r === undefined) return undefined;
    if (isDb && dataMountPath !== undefined) {
      const d = await updateDatabaseSettings(service.id, { dataMountPath });
      if (!d.ok) return undefined;
    }
    if (isDb) needsRestart("Storage");
    return r;
  };
  const regen = useAction(() => regenerateWebhookSecret(service.id), { success: "New secret generated" });
  const remove = useAction((volumes: boolean) => deleteService(service.id, volumes), {
    refresh: false,
    success: "Service deleted",
    onSuccess: () => router.replace(`/projects/${props.projectId}`),
  });
  const [removeVolumes, setRemoveVolumes] = React.useState(true);

  const nav = [
    { id: "general", label: "General" },
    { id: "server", label: "Server" },
    ...(service.source ? [{ id: "source", label: "Source" }] : []),
    ...(service.build && service.source?.type === "git" ? [{ id: "build", label: "Build" }] : []),
    ...(service.compose ? [{ id: "compose", label: "Compose file" }] : []),
    ...(service.type === "app"
      ? [
          { id: "deploy", label: "Deploy" },
          { id: "health", label: "Health check" },
          { id: "runtime", label: "Runtime" },
        ]
      : []),
    ...(props.db ? databaseNav(props.db) : []),
    ...(service.type === "app" ? [{ id: "storage", label: "Persistent storage" }] : []),
    ...(service.type !== "compose" ? [{ id: "resources", label: "Resources" }] : []),
    ...(service.type !== "compose" ? [{ id: "advanced", label: "Advanced" }] : []),
    ...(service.type !== "database" ? [{ id: "webhooks", label: "Webhooks" }] : []),
    { id: "danger", label: "Danger zone" },
  ];

  return (
    <div className="flex gap-10">
      <nav aria-label="Settings sections" className="sticky top-6 hidden w-40 flex-none flex-col gap-0.5 self-start xl:flex">
        {nav.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-fg-2/80 transition-colors hover:bg-fg/[0.04] hover:text-fg",
              item.id === "danger" && "text-bad/80 hover:text-bad",
            )}
          >
            {item.label}
          </a>
        ))}
      </nav>
    <div className="flex min-w-0 max-w-3xl flex-1 flex-col gap-6">
      {isDb && <ApplyBar pending={pendingApply} running={running} applying={applyDb.pending} onApply={() => applyDb.run()} />}
      <Section id="general" title="General" initial={{ name: service.name }} onSave={(v) => save.run({ name: v.name })}>
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

      <ServerCard service={service} server={props.server} servers={props.servers} />

      {props.db && (
        <DatabaseSections
          {...props.db}
          serviceId={service.id}
          running={running}
          restartPolicy={service.runtime.restartPolicy}
          stopTimeout={service.runtime.stopTimeout ?? null}
          onNeedsRestart={needsRestart}
        />
      )}

      {service.source?.type === "git" && (
        <Section
          id="source"
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
          id="source"
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

      {service.build && service.source?.type === "git" && <BuildSection serviceId={service.id} build={service.build} nixpacks={props.nixpacks} save={save.run} />}

      {service.compose && (
        <Section
          id="compose"
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
        <>
          <DeploySection runtime={service.runtime} save={save.run} />
          <HealthSection runtime={service.runtime} save={save.run} />
          <RuntimeSection runtime={service.runtime} save={save.run} />
        </>
      )}

      {props.db && (
        <StorageSection
          serviceId={service.id}
          volumes={service.runtime.volumes}
          running={running}
          isRootAdmin={props.isRootAdmin}
          onSave={saveStorage}
          data={{ mountPath: props.db.dataPath, defaultPath: props.db.defaultDataPath }}
        />
      )}

      {service.type !== "compose" && <ResourcesSection runtime={service.runtime} save={(p) => saveRuntime(p, "Resources")} />}

      {service.type === "app" && (
        <StorageSection serviceId={service.id} volumes={service.runtime.volumes} running={running} isRootAdmin={props.isRootAdmin} onSave={saveStorage} />
      )}

      {service.type !== "compose" && <AdvancedSection runtime={service.runtime} save={(p) => saveRuntime(p, "Advanced")} isRootAdmin={props.isRootAdmin} />}

      {service.type !== "database" && (
        <Card id="webhooks" className="scroll-mt-6">
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

      <Card id="danger" className="scroll-mt-6 border-bad/30">
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
    </div>
  );
}
