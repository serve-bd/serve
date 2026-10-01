"use client";

import * as React from "react";
import Link from "next/link";
import { Cloud, Infinity as InfinityIcon, KeySquare, MoreHorizontal, Pencil, Plus, SlidersHorizontal, Trash2, Vault, Zap } from "lucide-react";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { HelpTip } from "@/components/ui/help-tip";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Card, CopyButton, EmptyState } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import {
  CREDENTIAL_KEYS,
  SECRET_PROVIDER_KINDS,
  SECRET_PROVIDERS,
  type SecretProviderAccess,
  type SecretProviderConfig,
  type SecretProviderKind,
  secretReference,
} from "@/lib/secret-providers";
import { createSecretProvider, deleteSecretProvider, testSecretProvider, updateSecretProvider } from "@/server/actions/secret-providers";

type Project = { id: string; name: string; environments: { id: string; name: string }[] };
type Provider = {
  id: string;
  name: string;
  kind: SecretProviderKind;
  config: SecretProviderConfig;
  access: SecretProviderAccess;
  createdAt: string;
  usedBy: { id: string; name: string; projectId: string }[];
};

const ICONS: Record<SecretProviderKind, React.ComponentType<{ className?: string }>> = {
  vault: Vault,
  infisical: InfinityIcon,
  doppler: KeySquare,
  "aws-secrets": Cloud,
  "aws-parameters": SlidersHorizontal,
};

function KindIcon({ kind, className }: { kind: SecretProviderKind; className?: string }) {
  const Icon = ICONS[kind];
  return <Icon className={className} />;
}

/** "All projects", or the projects and environments a provider is limited to. */
function accessText(access: SecretProviderAccess, projects: Project[]) {
  if (!access.projectIds.length) return "All projects";
  return access.projectIds
    .map((id) => {
      const p = projects.find((x) => x.id === id);
      if (!p) return null;
      const envs = p.environments.filter((e) => access.environmentIds.includes(e.id)).map((e) => e.name);
      return envs.length ? `${p.name} (${envs.join(", ")})` : p.name;
    })
    .filter(Boolean)
    .join(", ");
}

export function SecretProviders({ providers, projects }: { providers: Provider[]; projects: Project[] }) {
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState<Provider | "new" | null>(null);
  const remove = useAction(deleteSecretProvider, { success: "Secret manager removed" });

  return (
    <>
      <PageHeader
        crumb="Secret managers"
        title={
          <span className="flex items-center gap-1.5">
            Secret managers
            <HelpTip label="About secret managers">
              Reference secrets in any variable, like <span className="font-mono text-fg">{"${{secrets.prod-vault.app/db:password}}"}</span>. Serve reads them from the provider
              each time a service deploys and never stores them.
            </HelpTip>
          </span>
        }
        description={`${providers.length} connected`}
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
            <Plus /> <span className="hidden sm:inline">Add secret manager</span>
          </Button>
        }
      />
      <PageBody>
        {providers.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Vault />}
              title="No secret managers yet"
              description="Connect HashiCorp Vault, OpenBao, Infisical, Doppler or AWS. Then reference its secrets in a service's variables."
              action={
                <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
                  <Plus /> Add secret manager
                </Button>
              }
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {providers.map((p) => {
                const meta = SECRET_PROVIDERS[p.kind];
                const example = secretReference(p.name, meta.example);
                return (
                  <li key={p.id} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
                    <span className="mt-0.5 flex size-8 flex-none items-center justify-center rounded-lg bg-sunken text-fg-2">
                      <KindIcon kind={p.kind} className="size-4" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-[14px] font-medium text-fg">{p.name}</span>
                        <span className="hidden truncate text-xs text-muted sm:inline">{meta.label}</span>
                      </span>
                      <span className="flex min-w-0 items-center gap-1">
                        <code className="min-w-0 truncate font-mono text-[12px] text-fg-2">{example}</code>
                        <CopyButton value={example} label="Copy an example reference" className="size-6 flex-none" />
                      </span>
                      <span className="truncate text-xs text-muted">
                        <span className="sm:hidden">{meta.label} · </span>
                        {accessText(p.access, projects)}
                        {" · "}
                        {p.usedBy.length ? (
                          <>
                            used by{" "}
                            {p.usedBy.slice(0, 3).map((s, i) => (
                              <React.Fragment key={s.id}>
                                {i > 0 && ", "}
                                <Link href={`/projects/${s.projectId}/services/${s.id}/variables`} className="text-fg-2 hover:text-fg">
                                  {s.name}
                                </Link>
                              </React.Fragment>
                            ))}
                            {p.usedBy.length > 3 && ` and ${p.usedBy.length - 3} more`}
                          </>
                        ) : (
                          "not used yet"
                        )}
                      </span>
                    </div>
                    <Menu>
                      <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${p.name}`} />}>
                        <MoreHorizontal />
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem onClick={() => setEditing(p)}>
                          <Pencil /> Edit
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          danger
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Remove ${p.name}?`,
                              description: p.usedBy.length
                                ? `${p.usedBy.length} service${p.usedBy.length === 1 ? " references" : "s reference"} it. Their next deploy stops until the references are changed. Running containers keep their values.`
                                : "Nothing references it. The secrets stay in the provider.",
                              confirmLabel: "Remove",
                              danger: true,
                              typeToConfirm: p.usedBy.length ? p.name : undefined,
                            });
                            if (ok) remove.run(p.id);
                          }}
                        >
                          <Trash2 /> Remove
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </PageBody>
      {editing && (
        <ProviderDialog key={editing === "new" ? "new" : editing.id} provider={editing === "new" ? null : editing} projects={projects} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function ProviderDialog({ provider, projects, onClose }: { provider: Provider | null; projects: Project[]; onClose: () => void }) {
  const [name, setName] = React.useState(provider?.name ?? "");
  const [kind, setKind] = React.useState<SecretProviderKind>(provider?.kind ?? "vault");
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(provider?.config ?? {}).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : []))),
  );
  const [kvVersion, setKvVersion] = React.useState<1 | 2>(provider?.config.kvVersion ?? 2);
  const [access, setAccess] = React.useState<SecretProviderAccess>(provider?.access ?? { projectIds: [], environmentIds: [] });
  const [tested, setTested] = React.useState<{ ok: boolean; message: string } | null>(null);
  const meta = SECRET_PROVIDERS[kind];

  const input = () => {
    const config: Record<string, unknown> = {};
    const credentials: Record<string, string> = {};
    for (const f of meta.fields) {
      const v = values[f.key] ?? "";
      if (CREDENTIAL_KEYS.has(f.key)) credentials[f.key] = v;
      else config[f.key] = v;
    }
    if (kind === "vault") config.kvVersion = kvVersion;
    return { name, kind, config, credentials, access };
  };
  const save = useAction(() => (provider ? updateSecretProvider(provider.id, input()) : createSecretProvider(input())), {
    success: provider ? "Secret manager updated" : "Secret manager added",
    onSuccess: onClose,
  });
  const [testing, setTesting] = React.useState(false);
  const test = async () => {
    setTesting(true);
    const res = await testSecretProvider(input(), provider?.id).finally(() => setTesting(false));
    setTested(res.ok ? { ok: true, message: res.data.message } : { ok: false, message: res.error });
  };

  const toggleProject = (id: string, on: boolean) =>
    setAccess((a) => {
      const project = projects.find((p) => p.id === id);
      return on
        ? { ...a, projectIds: [...a.projectIds, id] }
        : { projectIds: a.projectIds.filter((x) => x !== id), environmentIds: a.environmentIds.filter((e) => !project?.environments.some((pe) => pe.id === e)) };
    });
  const toggleEnv = (id: string) =>
    setAccess((a) => ({ ...a, environmentIds: a.environmentIds.includes(id) ? a.environmentIds.filter((x) => x !== id) : [...a.environmentIds, id] }));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
        >
          <DialogHeader
            title={provider ? `Edit ${provider.name}` : "Add a secret manager"}
            description="Serve reads secrets when a service deploys. Values are never saved in Serve, and they are hidden in build logs."
          />
          <DialogBody>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Name" description="Used in references.">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                  placeholder="prod-vault"
                  maxLength={40}
                  required
                  autoFocus={!provider}
                />
              </Field>
              <Field label="Provider">
                <Select
                  value={kind}
                  onValueChange={(v) => {
                    setKind(v as SecretProviderKind);
                    setTested(null);
                  }}
                  options={SECRET_PROVIDER_KINDS.map((k) => ({ value: k, label: SECRET_PROVIDERS[k].label, icon: <KindIcon kind={k} className="size-3.5 text-muted" /> }))}
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {meta.fields.map((f) => {
                const secret = CREDENTIAL_KEYS.has(f.key) && f.secret;
                const keep = provider && provider.kind === kind && CREDENTIAL_KEYS.has(f.key);
                // Long values (addresses, tokens) get the full width.
                const wide = f.key === "url" || f.key === "token" || f.key === "clientSecret" || f.key === "secretAccessKey" || f.key === "sessionToken";
                return (
                  <Field key={f.key} label={f.label} optional={f.optional} description={f.help} className={cn(wide && "sm:col-span-2")}>
                    <Input
                      type={secret ? "password" : "text"}
                      value={values[f.key] ?? ""}
                      onChange={(e) => {
                        setValues((v) => ({ ...v, [f.key]: e.target.value }));
                        setTested(null);
                      }}
                      placeholder={keep ? "Unchanged" : f.placeholder}
                      autoComplete="off"
                      spellCheck={false}
                      className={cn(secret || f.key === "url" ? "font-mono text-[13px]" : undefined)}
                    />
                  </Field>
                );
              })}
              {kind === "vault" && (
                <Field label="KV version">
                  <div role="radiogroup" aria-label="KV version" className="flex w-fit items-center rounded-lg border border-line bg-surface-2 p-0.5">
                    {([2, 1] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={kvVersion === v}
                        onClick={() => setKvVersion(v)}
                        className={cn(
                          "h-7 rounded-md px-3 text-[13px] font-medium transition-colors",
                          kvVersion === v ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
                        )}
                      >
                        Version {v}
                      </button>
                    ))}
                  </div>
                </Field>
              )}
            </div>

            <p className="text-xs leading-relaxed text-muted">
              Reference format: <span className="font-mono text-fg-2">{secretReference(name || "<name>", meta.format)}</span>
            </p>

            <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-medium text-fg">Access</span>
                {access.projectIds.length > 0 && (
                  <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setAccess({ projectIds: [], environmentIds: [] })}>
                    Allow all projects
                  </button>
                )}
              </div>
              <p className="text-xs leading-relaxed text-muted">
                {access.projectIds.length
                  ? "Only the checked projects may use it. Pick environments to narrow it further; none picked means every environment of that project."
                  : "Every project may use it. Check projects to limit it."}
              </p>
              {projects.length > 0 && (
                <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                  {projects.map((p) => {
                    const on = access.projectIds.includes(p.id);
                    return (
                      <li key={p.id} className="flex flex-col gap-1.5 rounded-lg px-1 py-1">
                        <label className="flex items-center gap-2 text-[13px] text-fg-2">
                          <Checkbox checked={on} onCheckedChange={(v) => toggleProject(p.id, !!v)} />
                          {p.name}
                        </label>
                        {on && p.environments.length > 1 && (
                          <div className="flex flex-wrap gap-1.5 pl-6">
                            {p.environments.map((e) => {
                              const picked = access.environmentIds.includes(e.id);
                              return (
                                <button
                                  key={e.id}
                                  type="button"
                                  aria-pressed={picked}
                                  onClick={() => toggleEnv(e.id)}
                                  className={cn(
                                    "h-6 rounded-md border px-2 text-xs transition-colors",
                                    picked ? "border-accent bg-accent/10 text-fg" : "border-line text-muted hover:border-line-strong hover:text-fg",
                                  )}
                                >
                                  {e.name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {tested && (
              <p className={cn("rounded-xl px-3.5 py-2.5 text-[13px]", tested.ok ? "bg-ok-soft text-fg-2" : "border border-bad/20 bg-bad-soft text-fg-2")}>{tested.message}</p>
            )}
          </DialogBody>
          <DialogFooter className="sm:justify-between">
            <Button type="button" onClick={() => void test()} loading={testing}>
              <Zap /> Test connection
            </Button>
            <Button type="submit" variant="primary" loading={save.pending}>
              {provider ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
