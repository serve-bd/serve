"use client";

import * as React from "react";
import { Box, Download, FileText, Folder, HardDrive, Lock, MoreHorizontal, Plus, Rocket, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tab, Tabs, TabsList } from "@/components/ui/tabs";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuLinkItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { useCan } from "@/components/permissions";
import { type ComposeMount, readComposeMounts } from "@/lib/compose-mounts";
import { type ComposeVolumeUsage, composeVolumeUsage, saveComposeMounts } from "@/server/actions/compose-storage";
import { deleteVolumeData } from "@/server/actions/databases";
import { deployService } from "@/server/actions/services";
import { cn, formatBytes } from "@/lib/utils";

const KIND = {
  volume: { icon: HardDrive, label: "Volume" },
  bind: { icon: Folder, label: "Server path" },
  file: { icon: FileText, label: "File" },
  other: { icon: Box, label: "Other" },
} as const;

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[11px] font-medium text-faint">{label}</span>
      {children}
    </label>
  );
}

/**
 * Storage of a compose stack, per service: named volumes, files and server paths. Reads and edits
 * the compose file itself, so what the page shows is what the stack runs with.
 */
export function ComposeStorageSection({
  serviceId,
  mode,
  content,
  running,
  isRootAdmin,
}: {
  serviceId: string;
  mode: "inline" | "git";
  content: string;
  running: boolean;
  isRootAdmin: boolean;
}) {
  const confirm = useConfirm();
  const parsed = React.useMemo(() => {
    try {
      return readComposeMounts(content);
    } catch {
      return null;
    }
  }, [content]);
  const services = parsed?.map((s) => s.service) ?? [];
  const [selected, setSelected] = React.useState(services[0] ?? "");
  const current = services.includes(selected) ? selected : (services[0] ?? "");
  const saved = React.useMemo(() => parsed?.find((s) => s.service === current)?.mounts ?? [], [parsed, current]);
  const [draft, setDraft] = React.useState<ComposeMount[]>(saved);
  React.useEffect(() => setDraft(saved), [saved]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const readOnly = mode === "git";
  const [deployHint, setDeployHint] = React.useState(false);

  const [usage, setUsage] = React.useState<{ volumes: ComposeVolumeUsage[]; leftovers: ComposeVolumeUsage[] } | null>(null);
  const loadUsage = React.useCallback(() => {
    composeVolumeUsage(serviceId).then((r) => setUsage(r.ok ? r.data : null));
  }, [serviceId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload sizes whenever the file changes
  React.useEffect(loadUsage, [loadUsage, content]);

  const save = useAction((mounts: ComposeMount[]) => saveComposeMounts(serviceId, current, mounts), {
    success: "Storage saved",
    onSuccess: () => setDeployHint(true),
  });
  const deploy = useAction(() => deployService(serviceId), { onSuccess: () => setDeployHint(false) });
  const purge = useAction((name: string) => deleteVolumeData(serviceId, name), { success: "Volume data deleted", onSuccess: loadUsage });

  const update = (i: number, patch: Partial<ComposeMount>) => setDraft((d) => d.map((m, j) => (j === i ? ({ ...m, ...patch } as ComposeMount) : m)));
  const remove = (i: number) => setDraft((d) => d.filter((_, j) => j !== i));
  const add = (m: ComposeMount) => setDraft((d) => [...d, m]);
  const isSaved = (m: ComposeMount) => saved.some((s) => JSON.stringify(s) === JSON.stringify(m));
  const archive = (path: string) => `/api/services/${serviceId}/volumes/archive?container=${encodeURIComponent(current)}&path=${encodeURIComponent(path)}`;
  // The archive holds the files as they are, secrets included: the download needs to see them.
  const canDownload = useCan()("variables.view-secrets");
  const sizeOf = (volume: string) => usage?.volumes.find((u) => u.volume === volume);

  if (!parsed) {
    return (
      <Card id="storage">
        <CardHeader title="Persistent storage" description="The compose file could not be read. Fix it in Compose file first." />
      </Card>
    );
  }

  return (
    <Card id="storage" className="scroll-mt-6">
      <CardHeader
        title="Persistent storage"
        description={
          readOnly
            ? "Read from the compose file in the repository. Change storage there and deploy."
            : "Volumes, files and server paths of each service. Changes are written to the compose file."
        }
        actions={
          !readOnly && (
            <Menu>
              <MenuTrigger render={<Button size="sm" disabled={!current} />}>
                <Plus /> Add mount
              </MenuTrigger>
              <MenuContent align="end">
                <MenuLabel>Add to {current}</MenuLabel>
                <MenuItem onClick={() => add({ kind: "volume", source: "", target: "" })}>
                  <HardDrive /> Volume
                </MenuItem>
                <MenuItem onClick={() => add({ kind: "file", name: "", target: "", content: "" })}>
                  <FileText /> File with content
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={!isRootAdmin} onClick={() => add({ kind: "bind", source: "", target: "", hostType: "file" })}>
                  <FileText /> File on the server
                </MenuItem>
                <MenuItem disabled={!isRootAdmin} onClick={() => add({ kind: "bind", source: "", target: "", hostType: "directory" })}>
                  <Folder /> Directory on the server
                </MenuItem>
              </MenuContent>
            </Menu>
          )
        }
      />
      <CardBody className="flex flex-col gap-4 py-5">
        {services.length > 1 &&
          (services.length <= 5 ? (
            <Tabs value={current} onValueChange={(v) => !dirty && setSelected(v as string)}>
              <TabsList>
                {services.map((s) => (
                  <Tab key={s} value={s} disabled={dirty && s !== current}>
                    {s}
                  </Tab>
                ))}
              </TabsList>
            </Tabs>
          ) : (
            <Select value={current} onValueChange={setSelected} disabled={dirty} options={services.map((s) => ({ value: s, label: s }))} className="max-w-xs" size="sm" />
          ))}
        {dirty && services.length > 1 && <p className="-mt-2 text-[11px] text-faint">Save or discard to switch services.</p>}

        {draft.length === 0 && (
          <p className="text-[13px] text-muted">
            {current} has no storage. Files written inside its containers are lost when they are recreated.
            {!readOnly && " Add a volume to keep them."}
          </p>
        )}

        <div className="flex flex-col gap-2.5">
          {draft.map((m, i) => {
            const Icon = m.kind === "bind" && m.hostType === "file" ? FileText : KIND[m.kind].icon;
            const size = m.kind === "volume" ? sizeOf(m.source) : undefined;
            const locked = readOnly || m.kind === "other";
            return (
              <div key={i} className="flex flex-col gap-2.5 rounded-xl border border-line p-3">
                <div className="flex items-start gap-3">
                  <span className="mt-5 hidden size-8 flex-none place-items-center rounded-lg bg-surface-2 text-muted sm:grid">
                    <Icon className="size-4" />
                  </span>
                  <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                    {m.kind === "volume" && (
                      <Field label="Volume">
                        <Input
                          value={m.source}
                          onChange={(e) => update(i, { source: e.target.value })}
                          placeholder="data"
                          disabled={locked}
                          className="h-8 font-mono text-[12.5px]"
                        />
                      </Field>
                    )}
                    {m.kind === "bind" && (
                      <Field label={m.hostType === "file" ? "File on the server" : "Directory on the server"}>
                        <Input
                          value={m.source}
                          onChange={(e) => update(i, { source: e.target.value })}
                          placeholder={m.hostType === "file" ? "/etc/ssl/certs/ca.pem" : "/srv/media"}
                          disabled={locked || !isRootAdmin}
                          className="h-8 font-mono text-[12.5px]"
                        />
                      </Field>
                    )}
                    {m.kind === "file" && (
                      <Field label="File name">
                        <Input
                          value={m.name}
                          onChange={(e) => update(i, { name: e.target.value })}
                          placeholder="app.conf"
                          disabled={locked}
                          className="h-8 font-mono text-[12.5px]"
                        />
                      </Field>
                    )}
                    {m.kind === "other" && (
                      <Field label="Mount">
                        <Input value={m.label} readOnly disabled className="h-8 text-[12.5px]" />
                      </Field>
                    )}
                    <Field label="Mounted at">
                      <Input
                        value={m.target}
                        onChange={(e) => update(i, { target: e.target.value })}
                        placeholder="/var/lib/app"
                        disabled={locked}
                        className="h-8 font-mono text-[12.5px]"
                      />
                    </Field>
                  </div>
                  <div className="mt-5 flex flex-none items-center gap-1">
                    {!readOnly && (
                      <Menu>
                        <MenuTrigger render={<Button variant="ghost" size="icon" aria-label="Mount actions" />}>
                          <MoreHorizontal />
                        </MenuTrigger>
                        <MenuContent align="end">
                          {(m.kind === "volume" || m.kind === "bind") && (
                            <MenuItem onClick={() => update(i, { readOnly: !m.readOnly })}>{m.readOnly ? "Make writable" : "Make read-only"}</MenuItem>
                          )}
                          {m.kind === "volume" && running && canDownload && isSaved(m) && (
                            <MenuLinkItem render={<a href={archive(m.target)} download />}>
                              <Download /> Download as .tar
                            </MenuLinkItem>
                          )}
                          {m.kind !== "other" && <MenuSeparator />}
                          <MenuItem danger onClick={() => remove(i)}>
                            <Trash2 /> Remove mount
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted sm:pl-11">
                  <Badge>{m.kind === "bind" ? (m.hostType === "file" ? "Server file" : "Server directory") : KIND[m.kind].label}</Badge>
                  {(m.kind === "file" || ("readOnly" in m && m.readOnly)) && (
                    <span className="inline-flex items-center gap-1">
                      <Lock className="size-3" /> Read-only in the container
                    </span>
                  )}
                  {size?.exists && <span>{size.size != null ? formatBytes(size.size) : "Size unknown"}</span>}
                  {m.kind === "volume" && usage && isSaved(m) && !size?.exists && <span>Created on the next deploy</span>}
                  {size?.exists && <span className="font-mono text-faint">{size.dockerName}</span>}
                  {m.kind === "bind" && !isRootAdmin && !readOnly && <span>Only admins of the Root organization can change server paths.</span>}
                  {m.kind === "other" && !readOnly && <span>Edit it in the compose file.</span>}
                </div>
                {m.kind === "file" && (
                  <Textarea
                    value={m.content}
                    onChange={(e) => update(i, { content: e.target.value })}
                    rows={Math.min(16, Math.max(4, m.content.split("\n").length + 1))}
                    placeholder="File content"
                    spellCheck={false}
                    disabled={readOnly}
                    className="font-mono text-[12.5px] sm:ml-11 sm:w-[calc(100%-2.75rem)]"
                  />
                )}
              </div>
            );
          })}
        </div>

        {usage && usage.leftovers.length > 0 && (
          <div className="flex flex-col gap-2 rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-fg-2">
            <p className="font-medium text-fg">Volumes no longer in the compose file</p>
            {usage.leftovers.map((v) => (
              <div key={v.dockerName} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-mono">{v.dockerName}</span>
                  <span className="text-muted">
                    {" "}
                    · {v.size != null ? formatBytes(v.size) : "size unknown"}
                    {v.containers ? " · still used by a container" : ""}
                  </span>
                </span>
                <Button
                  size="xs"
                  variant="danger"
                  loading={purge.pending}
                  disabled={v.containers > 0}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Delete ${v.dockerName}?`,
                        description: "Its data is deleted from the server and cannot be recovered.",
                        confirmLabel: "Delete data",
                        danger: true,
                      })
                    )
                      purge.run(v.dockerName);
                  }}
                >
                  Delete data
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardBody>
      {!readOnly && (
        <CardFooter>
          {deployHint && !dirty ? (
            <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
              <span className="truncate">Saved. Deploy to apply.</span>
              <Button size="xs" onClick={() => deploy.run()} loading={deploy.pending}>
                <Rocket /> Deploy
              </Button>
            </span>
          ) : (
            <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : "Applies on the next deploy."}</span>
          )}
          <div className="flex flex-none gap-2">
            {dirty && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(saved)}>
                Discard
              </Button>
            )}
            <Button variant="primary" size="sm" disabled={!dirty} loading={save.pending} onClick={() => save.run(draft)}>
              Save
            </Button>
          </div>
        </CardFooter>
      )}
    </Card>
  );
}
