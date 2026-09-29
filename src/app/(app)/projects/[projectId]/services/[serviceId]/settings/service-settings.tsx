"use client";

import * as React from "react";
import { CodeEditor } from "@/components/code-editor";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { ArrowRightLeft, Check, LayoutTemplate, RefreshCw, Server as ServerIcon, Trash2, TriangleAlert } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, CopyField, TimeAgo } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { applyDatabaseChanges, deleteService, moveService, regenerateWebhookSecret, updateService } from "@/server/actions/services";
import { cn } from "@/lib/utils";
import type { BuildConfig, RepoWebhook, RuntimeConfig, VolumeMount } from "@/server/services/types";
import { registerServiceWebhook, removeServiceWebhook } from "@/server/actions/integrations";
import { Section } from "./section";
import { AdvancedSection, BuildSection, DeploySection, HealthSection, ResourcesSection, RuntimeSection } from "./config-sections";
import { ApplyBar, DatabaseSections, type DatabaseSettingsProps } from "./database-sections";
import type { SettingsNavItem } from "./settings-nav";
import { addPendingApply, clearPendingApply, usePendingApply } from "./pending-apply";
import { StorageSection } from "./storage-section";
import { updateDatabaseSettings } from "@/server/actions/databases";

type Source =
  | { type: "git"; repository: string; branch: string; credentialId?: string | null; webhook?: RepoWebhook | null }
  | { type: "image"; image: string; registryUsername: string | null; hasPassword: boolean };

type Props = {
  projectId: string;
  service: {
    id: string;
    name: string;
    slug: string;
    hostname: string | null;
    type: string;
    autoDeploy: boolean;
    previewsEnabled: boolean;
    isPreview: boolean;
    source: Source | null;
    build: BuildConfig | null;
    runtime: RuntimeConfig;
    compose: { mode: "inline" | "git"; content: string; path: string; isolated: boolean } | null;
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
  /** The git credential is a token or OAuth connection Serve can add repository webhooks with. */
  managedWebhook?: boolean;
  webhookSecret: string;
  deployHookUrl: string;
  /** Server the service runs on, and the servers it could move to. */
  server: { id: string; name: string; host: string; isLocal: boolean };
  servers: { id: string; name: string; host: string; status: string; isLocal: boolean }[];
  /** Admin of the Root organization: may grant host access (privileged, capabilities). */
  isRootAdmin: boolean;
  /** The settings sub-page shown, and all of them for the nav. */
  section: string;
  nav: SettingsNavItem[];
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
  // Kept outside the page so it survives moving between settings sub-pages.
  const pendingApply = usePendingApply(service.id);
  const needsRestart = React.useCallback((what: string) => addPendingApply(service.id, what), [service.id]);
  const applyDb = useAction(() => applyDatabaseChanges(service.id), { success: "Restarting the database with the new settings", onSuccess: () => clearPendingApply(service.id) });
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

  const { section, nav } = props;
  const show = (id: string) => section === id;
  const base = `/projects/${props.projectId}/services/${service.id}/settings`;

  return (
    <div className="flex flex-col gap-6 xl:flex-row xl:gap-10">
      <nav aria-label="Settings sections" className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto px-4 xl:sticky xl:top-6 xl:mx-0 xl:w-44 xl:flex-none xl:flex-col xl:gap-0.5 xl:self-start xl:overflow-visible xl:px-0">
        {nav.map((item) => {
          const active = item.id === section;
          return (
            <Link
              key={item.id}
              href={`${base}/${item.id}`}
              aria-current={active ? "page" : undefined}
              ref={active ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}
              className={cn(
                "flex-none rounded-lg px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors",
                active ? "bg-fg/[0.06] text-fg" : "text-fg-2/80 hover:bg-fg/[0.04] hover:text-fg",
                item.id === "danger" && (active ? "text-bad" : "text-bad/80 hover:text-bad"),
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    <div className="flex min-w-0 max-w-3xl flex-1 flex-col gap-6">
      {isDb && <ApplyBar pending={pendingApply} running={running} applying={applyDb.pending} onApply={() => applyDb.run()} />}
      {show("general") && (
      <Section
          id="general"
          title="General"
          initial={{ name: service.name, hostname: service.hostname ?? "" }}
          onSave={(v) => save.run({ name: v.name, ...(service.type !== "compose" ? { hostname: v.hostname.trim() || null } : {}) })}
          footerNote={service.type !== "compose" ? "A new hostname applies after redeploying this service and the services that reference it." : undefined}
        >
          {(v, set) => (
            <>
              <Field label="Service name">
                <Input value={v.name} onChange={(e) => set({ name: e.target.value })} required />
              </Field>
              {service.type === "compose" ? (
                <Field label="Private hostname" description="Other services in this environment reach this one at this hostname.">
                  <CopyField value={service.slug} />
                </Field>
              ) : (
                <Field
                  label="Private hostname"
                  optional
                  description={`Other services in this environment reach this one at this name. ${service.slug} keeps working as well.`}
                >
                  <Input
                    value={v.hostname}
                    onChange={(e) => set({ hostname: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })}
                    placeholder={service.slug}
                    maxLength={63}
                    className="font-mono text-[13px]"
                  />
                </Field>
              )}
            </>
          )}
        </Section>
      )}

      {show("server") && <ServerCard service={service} server={props.server} servers={props.servers} />}

      {props.db && (
        <DatabaseSections
          section={section}
          {...props.db}
          serviceId={service.id}
          running={running}
          restartPolicy={service.runtime.restartPolicy}
          stopTimeout={service.runtime.stopTimeout ?? null}
          onNeedsRestart={needsRestart}
        />
      )}

      {show("source") && service.source?.type === "git" && (
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

      {show("source") && service.source?.type === "image" && (
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

      {show("build") && service.build && service.source?.type === "git" && <BuildSection serviceId={service.id} build={service.build} nixpacks={props.nixpacks} save={save.run} />}

      {show("networking") && service.compose && (
        <Section
          id="networking"
          title="Network"
          description="Who the services of this stack can reach on the private network."
          initial={{ reach: !service.compose.isolated }}
          onSave={(v) => save.run({ compose: { isolated: !v.reach } })}
          footerNote="Applies on the next deploy."
        >
          {(v, set) => (
            <>
              <SwitchRow
                title="Reach other services in this environment"
                description={
                  v.reach
                    ? "The stack's services can connect to databases and apps of this environment, and they can connect to it."
                    : "The stack keeps to itself: its services reach only each other. Domains still work; the proxy joins the stack's own network."
                }
                checked={v.reach}
                onCheckedChange={(c) => set({ reach: c })}
              />
              {!v.reach && (
                <p className="rounded-xl border border-warn/25 bg-warn-soft px-3.5 py-2.5 text-xs leading-relaxed text-fg-2">
                  References like <span className="font-mono">{"${{postgres.DATABASE_URL}}"}</span> still resolve, but the address is not reachable from this stack. Add the database to the compose file instead.
                </p>
              )}
            </>
          )}
        </Section>
      )}

      {show("compose") && service.compose && (
        <Section
          id="compose"
          title="Compose file"
          description={service.compose.mode === "git" ? "Read from the repository on every deploy." : "Edit the stack and deploy to apply."}
          initial={{ content: service.compose.content, path: service.compose.path }}
          onSave={(v) => save.run({ compose: service.compose?.mode === "git" ? { path: v.path } : { content: v.content } })}
          footerAction={() =>
            service.compose?.mode === "inline" && (
              <Link href={`/templates/new?service=${service.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                <LayoutTemplate /> Save as template
              </Link>
            )
          }
        >
          {(v, set) =>
            service.compose?.mode === "git" ? (
              <Field label="Compose file path">
                <Input value={v.path} onChange={(e) => set({ path: e.target.value })} className="font-mono text-[13px]" />
              </Field>
            ) : (
              <CodeEditor value={v.content} onChange={(content) => set({ content })} minRows={14} maxHeight="40rem" aria-label="docker-compose.yml" />
            )
          }
        </Section>
      )}

      {service.type === "app" && (
        <>
          {show("deploy") && <DeploySection runtime={service.runtime} save={save.run} />}
          {show("health") && <HealthSection runtime={service.runtime} save={save.run} />}
          {show("runtime") && <RuntimeSection runtime={service.runtime} save={save.run} />}
        </>
      )}

      {show("storage") && props.db && (
        <StorageSection
          serviceId={service.id}
          volumes={service.runtime.volumes}
          running={running}
          isRootAdmin={props.isRootAdmin}
          onSave={saveStorage}
          data={{ mountPath: props.db.dataPath, defaultPath: props.db.defaultDataPath }}
        />
      )}

      {show("resources") && service.type !== "compose" && <ResourcesSection runtime={service.runtime} save={(p) => saveRuntime(p, "Resources")} />}

      {show("storage") && service.type === "app" && (
        <StorageSection serviceId={service.id} volumes={service.runtime.volumes} running={running} isRootAdmin={props.isRootAdmin} onSave={saveStorage} />
      )}

      {show("advanced") && service.type !== "compose" && <AdvancedSection runtime={service.runtime} save={(p) => saveRuntime(p, "Advanced")} isRootAdmin={props.isRootAdmin} />}

      {show("webhooks") && service.type !== "database" && (
        <Card id="webhooks" className="scroll-mt-6">
          <CardHeader title="Webhooks" description="Trigger deployments from your Git provider or CI." />
          <CardBody className="flex flex-col gap-4 py-5">
            {props.viaGithubApp ? (
              <p className="flex items-start gap-2 rounded-xl bg-ok-soft px-3.5 py-3 text-[13px] leading-relaxed text-fg-2">
                <Check className="mt-0.5 size-4 shrink-0 text-ok" />
                Push and pull request events arrive automatically through the GitHub App. No webhook setup is needed.
              </p>
            ) : (
              <>
                {props.managedWebhook && service.source?.type === "git" && <RepoWebhookStatus serviceId={service.id} webhook={service.source.webhook ?? null} />}
                <Field
                  label="Git webhook URL"
                  description={
                    props.managedWebhook
                      ? "Serve adds this to the repository for you. Add it yourself only if automatic setup is not possible."
                      : "Add to GitHub, GitLab, Gitea or Bitbucket as a push webhook. Use the secret below. Content type: application/json."
                  }
                >
                  <CopyField value={props.webhookUrl} />
                </Field>
              </>
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

      {show("danger") && (
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
      )}
    </div>
    </div>
  );
}

const hookProviderNames: Record<string, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea", bitbucket: "Bitbucket" };

/** Status of the repository webhook Serve manages through the provider API. */
function RepoWebhookStatus({ serviceId, webhook }: { serviceId: string; webhook: RepoWebhook | null }) {
  const register = useAction(() => registerServiceWebhook(serviceId), { success: "Webhook registered" });
  const remove = useAction(() => removeServiceWebhook(serviceId), { success: "Webhook removed" });
  const name = webhook ? hookProviderNames[webhook.provider] : "the provider";
  if (webhook?.id) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-ok-soft px-3.5 py-3 text-[13px] text-fg-2">
        <Check className="size-4 shrink-0 text-ok" />
        <span className="min-w-0 flex-1">
          Registered on {name} · hook <span className="font-mono">#{webhook.id.replace(/[{}]/g, "").slice(0, 12)}</span> · <TimeAgo date={webhook.createdAt} />
        </span>
        <Button size="sm" variant="ghost" onClick={() => register.run()} loading={register.pending}>
          <RefreshCw /> Re-register
        </Button>
        <Button size="sm" variant="ghost" onClick={() => remove.run()} loading={remove.pending}>
          Remove
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warn-soft px-3.5 py-3 text-[13px] text-fg-2">
      <TriangleAlert className="size-4 shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        {webhook?.error ? <>Could not add the webhook on {name}: {webhook.error}</> : "Deploy on push is not set up on the repository yet."}
      </span>
      <Button size="sm" onClick={() => register.run()} loading={register.pending}>
        <RefreshCw /> {webhook?.error ? "Retry" : "Register webhook"}
      </Button>
    </div>
  );
}
