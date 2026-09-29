"use client";

import * as React from "react";
import Link from "next/link";
import { Boxes, Container, MoreHorizontal, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { useAction } from "@/hooks/use-action";
import { addRegistry, deleteRegistry, testRegistry, updateRegistry } from "@/server/actions/registries";
import { registryPresets } from "@/server/registries/refs";
import type { RegistryKind } from "@/server/db/schema";

export type RegistryItem = {
  id: string;
  name: string;
  kind: RegistryKind;
  host: string;
  username: string;
  namespace: string | null;
  createdAt: string;
  services: { id: string; name: string; projectId: string }[];
};

const colors: Record<RegistryKind, string> = { dockerhub: "#1d63ed", ghcr: "#24292f", gitlab: "#fc6d26", generic: "#8e8e93" };
const kinds = Object.keys(registryPresets) as RegistryKind[];

function Mark({ kind }: { kind: RegistryKind }) {
  return (
    <span className="flex size-10 flex-none items-center justify-center rounded-xl text-white" style={{ background: colors[kind] }} aria-hidden>
      <Container className="size-[18px]" />
    </span>
  );
}

export function Registries({ registries, isAdmin }: { registries: RegistryItem[]; isAdmin: boolean }) {
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState<RegistryItem | "new" | null>(null);
  const [testing, setTesting] = React.useState<string | null>(null);
  const test = useAction(testRegistry, { success: "Login works", refresh: false });
  const remove = useAction(deleteRegistry, { success: "Registry removed" });

  return (
    <>
      <PageHeader
        title="Registries"
        description="Build an image once, push it to a registry, and run the same image on several servers."
        actions={
          isAdmin && (
            <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
              <Plus /> Add registry
            </Button>
          )
        }
      />
      <PageBody>
        {registries.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Container />}
              title="No registries yet"
              description="Add Docker Hub, GitHub, GitLab or your own registry. Then choose it in an app's Settings → Servers & registry."
              action={
                isAdmin && (
                  <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
                    <Plus /> Add registry
                  </Button>
                )
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {registries.map((r) => (
              <Card key={r.id} className="flex flex-col">
                <div className="flex items-start gap-3.5 p-5">
                  <Mark kind={r.kind} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="truncate text-[15px] font-semibold text-fg">{r.name}</h3>
                      <Badge>{registryPresets[r.kind].label}</Badge>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted">{r.host}</p>
                  </div>
                  <div className="flex flex-none items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={testing === r.id}
                      onClick={async () => {
                        setTesting(r.id);
                        await test.run(r.id);
                        setTesting(null);
                      }}
                    >
                      <Zap /> Test
                    </Button>
                    {isAdmin && (
                      <Menu>
                        <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More actions" />}>
                          <MoreHorizontal />
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onClick={() => setEditing(r)}>
                            <Pencil /> Edit
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            danger
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `Remove ${r.name}?`,
                                  description: "Images already pushed stay in the registry. Serve forgets the login.",
                                  confirmLabel: "Remove registry",
                                  danger: true,
                                })
                              )
                                remove.run(r.id);
                            }}
                          >
                            <Trash2 /> Remove
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    )}
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line px-5 py-4 text-[13px] sm:grid-cols-3">
                  <div className="min-w-0">
                    <dt className="text-xs text-faint">Username</dt>
                    <dd className="truncate text-fg-2">{r.username}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-faint">Namespace</dt>
                    <dd className="truncate font-mono text-[12px] text-fg-2">{r.namespace || r.username}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-faint">Added</dt>
                    <dd className="truncate text-fg-2">
                      <TimeAgo date={r.createdAt} />
                    </dd>
                  </div>
                </dl>
                <div className="mt-auto flex min-w-0 flex-wrap items-center gap-1.5 border-t border-line px-5 py-3 text-xs text-muted">
                  <Boxes className="size-3.5 flex-none text-faint" />
                  {r.services.length ? (
                    <>
                      <span className="mr-0.5">Used by</span>
                      {r.services.map((s) => (
                        <Link
                          key={s.id}
                          href={`/projects/${s.projectId}/services/${s.id}/settings/servers`}
                          className="rounded-md bg-surface-2 px-1.5 py-0.5 text-fg-2 transition-colors hover:text-fg"
                        >
                          {s.name}
                        </Link>
                      ))}
                    </>
                  ) : (
                    <span>Not used yet. Choose it in an app&apos;s Settings → Servers & registry.</span>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </PageBody>
      {editing && <RegistryDialog key={editing === "new" ? "new" : editing.id} registry={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RegistryDialog({ registry, onClose }: { registry: RegistryItem | null; onClose: () => void }) {
  const [form, setForm] = React.useState({
    kind: registry?.kind ?? ("dockerhub" as RegistryKind),
    name: registry?.name ?? registryPresets.dockerhub.label,
    host: registry?.host ?? "",
    username: registry?.username ?? "",
    password: "",
    namespace: registry?.namespace ?? "",
  });
  const preset = registryPresets[form.kind];
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useAction(() => (registry ? updateRegistry(registry.id, form) : addRegistry(form)), {
    success: registry ? "Registry updated" : "Registry added",
    onSuccess: onClose,
  });
  // Self-hosted GitLab and other registries need a host; the public services have a fixed one.
  const needsHost = form.kind === "generic" || form.kind === "gitlab";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
        >
          <DialogHeader title={registry ? `Edit ${registry.name}` : "Add a container registry"} description="Serve logs in to check the credentials before saving." />
          <DialogBody>
            <Field label="Registry" description={preset.hint}>
              <Select
                value={form.kind}
                onValueChange={(kind) =>
                  setForm((f) => {
                    const next = kind as RegistryKind;
                    const wasDefault = !f.name || f.name === registryPresets[f.kind].label;
                    return { ...f, kind: next, name: wasDefault ? registryPresets[next].label : f.name, host: next === "generic" || next === "gitlab" ? f.host : "" };
                  })
                }
                options={kinds.map((k) => ({ value: k, label: registryPresets[k].label }))}
              />
            </Field>
            <Field label="Name">
              <Input value={form.name} onChange={set("name")} required placeholder={preset.label} />
            </Field>
            {needsHost && (
              <Field
                label="Host"
                optional={form.kind === "gitlab"}
                description={form.kind === "gitlab" ? "Leave empty for gitlab.com. For self-hosted GitLab, its registry host." : undefined}
              >
                <Input
                  value={form.host}
                  onChange={set("host")}
                  required={form.kind === "generic"}
                  placeholder={preset.host || "registry.example.com"}
                  className="font-mono text-[13px]"
                />
              </Field>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Username">
                <Input value={form.username} onChange={set("username")} required autoComplete="off" />
              </Field>
              <Field label={form.kind === "generic" ? "Password or token" : "Access token"} description={registry ? "Leave empty to keep the stored one." : undefined}>
                <Input type="password" value={form.password} onChange={set("password")} required={!registry} autoComplete="new-password" />
              </Field>
            </div>
            <Field label="Namespace" optional description="User, organization or group that new repositories go under. Defaults to the username.">
              <Input value={form.namespace} onChange={set("namespace")} placeholder={form.username || "acme"} className="font-mono text-[13px]" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={save.pending}>
              {registry ? "Save changes" : "Add registry"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
