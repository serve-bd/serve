"use client";

import * as React from "react";
import { Download, FileText, Folder, HardDrive, MoreHorizontal, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tab, Tabs, TabsList, TabsPanel } from "@/components/ui/tabs";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuLinkItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { deleteVolumeData } from "@/server/actions/databases";
import { cn } from "@/lib/utils";
import type { VolumeMount } from "@/server/services/types";

type StorageTab = "volumes" | "files" | "directories";

const tabOf = (v: VolumeMount): StorageTab => (v.kind === "volume" ? "volumes" : v.kind === "file" || v.hostType === "file" ? "files" : "directories");

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[11px] font-medium text-faint sm:hidden">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}

/**
 * Persistent storage: Docker volumes, files whose content
 * Serve writes, and host paths. Used by apps and databases.
 */
export function StorageSection({
  serviceId,
  volumes,
  running,
  isRootAdmin,
  onSave,
  data,
}: {
  serviceId: string;
  volumes: VolumeMount[];
  running: boolean;
  isRootAdmin: boolean;
  onSave: (volumes: VolumeMount[], dataMountPath?: string | null) => Promise<unknown>;
  /** Databases: the data volume, whose destination can move. */
  data?: { mountPath: string; defaultPath: string };
}) {
  const confirm = useConfirm();
  const initial = React.useMemo(
    () => ({ volumes: volumes.filter((v) => !(data && v.kind === "volume" && v.source === "data")), dataPath: data?.mountPath ?? "" }),
    [volumes, data],
  );
  const [value, setValue] = React.useState(initial);
  const [saved, setSaved] = React.useState(JSON.stringify(initial));
  const [pending, setPending] = React.useState(false);
  const [tab, setTab] = React.useState<StorageTab>("volumes");
  const [removed, setRemoved] = React.useState<string[]>([]);
  const dirty = JSON.stringify(value) !== saved;
  const purging = React.useRef("");
  const purge = useAction((source: string) => ((purging.current = source), deleteVolumeData(serviceId, source)), {
    success: "Volume data deleted",
    onSuccess: () => setRemoved((r) => r.filter((x) => x !== purging.current)),
  });

  const rows = value.volumes.map((v, i) => ({ v, i })).filter(({ v }) => tabOf(v) === tab);
  const count = (t: StorageTab) => value.volumes.filter((v) => tabOf(v) === t).length + (t === "volumes" && data ? 1 : 0);
  const update = (i: number, patch: Partial<VolumeMount>) => setValue((s) => ({ ...s, volumes: s.volumes.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const remove = (i: number) => setValue((s) => ({ ...s, volumes: s.volumes.filter((_, j) => j !== i) }));
  const add = (v: VolumeMount) => {
    setValue((s) => ({ ...s, volumes: [...s.volumes, v] }));
    setTab(tabOf(v));
  };
  const archive = (path: string) => `/api/services/${serviceId}/volumes/archive?path=${encodeURIComponent(path)}`;
  const savedVolumes = (JSON.parse(saved) as typeof initial).volumes;
  const isSaved = (v: VolumeMount) => savedVolumes.some((s) => s.kind === v.kind && s.source === v.source && s.mountPath === v.mountPath);

  const submit = async () => {
    const clean = value.volumes.filter((v) => v.source.trim() && v.mountPath.trim());
    const dataPath = data ? (value.dataPath.trim() && value.dataPath.trim() !== data.defaultPath ? value.dataPath.trim() : null) : undefined;
    setPending(true);
    const ok = await onSave(clean, dataPath);
    setPending(false);
    if (ok === undefined) return;
    const gone = savedVolumes.filter((s) => s.kind === "volume" && !clean.some((c) => c.kind === "volume" && c.source === s.source)).map((s) => s.source);
    setRemoved((r) => [...new Set([...r, ...gone])]);
    const next = { ...value, volumes: clean };
    setValue(next);
    setSaved(JSON.stringify(next));
  };

  return (
    <Card id="storage" className="scroll-mt-6">
      <CardHeader
        title="Persistent storage"
        description="Data that survives restarts and deploys. Volumes are managed by Docker; files and host paths are mounted into the container."
        actions={
          <Menu>
            <MenuTrigger render={<Button size="sm" />}>
              <Plus /> Add mount
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>Add</MenuLabel>
              <MenuItem onClick={() => add({ kind: "volume", source: "", mountPath: "" })}>
                <HardDrive /> Volume
              </MenuItem>
              <MenuItem onClick={() => add({ kind: "file", source: "", mountPath: "", content: "" })}>
                <FileText /> File with content
              </MenuItem>
              <MenuSeparator />
              <MenuItem disabled={!isRootAdmin} onClick={() => add({ kind: "bind", source: "", mountPath: "", hostType: "file" })}>
                <FileText /> File on the server
              </MenuItem>
              <MenuItem disabled={!isRootAdmin} onClick={() => add({ kind: "bind", source: "", mountPath: "", hostType: "directory", create: true })}>
                <Folder /> Directory on the server
              </MenuItem>
            </MenuContent>
          </Menu>
        }
      />
      <CardBody className="flex flex-col gap-4 py-5">
        <Tabs value={tab} onValueChange={(t) => setTab(t as StorageTab)}>
          <TabsList>
            <Tab value="volumes">Volumes ({count("volumes")})</Tab>
            <Tab value="files">Files ({count("files")})</Tab>
            <Tab value="directories">Directories ({count("directories")})</Tab>
          </TabsList>

          <TabsPanel value="volumes" className="mt-4 flex flex-col gap-2">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2 px-1 text-[11px] font-medium text-faint sm:grid">
              <span>Volume</span>
              <span>Mounted at</span>
              <span className="w-16" />
            </div>
            {data && (
              <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2/40 p-2.5 sm:border-0 sm:bg-transparent sm:p-0">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-center">
                  <Cell label="Volume">
                    <Input value="data" readOnly className="h-8 font-mono text-[12.5px] text-muted" />
                  </Cell>
                  <Cell label="Mounted at">
                    <Input
                      value={value.dataPath}
                      onChange={(e) => setValue((s) => ({ ...s, dataPath: e.target.value }))}
                      placeholder={data.defaultPath}
                      className="h-8 font-mono text-[12.5px]"
                    />
                  </Cell>
                  <div className="flex w-16 justify-end gap-1">
                    {running ? (
                      <a href={archive(data.mountPath)} download title="Download as .tar" className={buttonVariants({ variant: "ghost", size: "icon" })}>
                        <Download />
                      </a>
                    ) : (
                      <Button variant="ghost" size="icon" disabled title="Start the database to download">
                        <Download />
                      </Button>
                    )}
                  </div>
                </div>
                {value.dataPath.trim() && value.dataPath.trim() !== data.mountPath && (
                  <p className="flex items-start gap-1.5 text-xs text-warn">
                    <TriangleAlert className="mt-px size-3.5 flex-none" />
                    The database looks for its files at {data.defaultPath}. Moving the volume only helps with images that use another data directory; otherwise the database starts
                    empty.
                  </p>
                )}
              </div>
            )}
            {rows.map(({ v, i }) => (
              <div
                key={i}
                className="grid grid-cols-1 gap-2 rounded-xl border border-line p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-center sm:border-0 sm:p-0"
              >
                <Cell label="Volume">
                  <Input value={v.source} onChange={(e) => update(i, { source: e.target.value })} placeholder="uploads" className="h-8 font-mono text-[12.5px]" />
                </Cell>
                <Cell label="Mounted at">
                  <Input value={v.mountPath} onChange={(e) => update(i, { mountPath: e.target.value })} placeholder="/app/uploads" className="h-8 font-mono text-[12.5px]" />
                </Cell>
                <div className="flex w-16 justify-end gap-1">
                  <Menu>
                    <MenuTrigger render={<Button variant="ghost" size="icon" aria-label="Volume actions" />}>
                      <MoreHorizontal />
                    </MenuTrigger>
                    <MenuContent align="end">
                      <MenuItem onClick={() => update(i, { readOnly: !v.readOnly })}>{v.readOnly ? "Make writable" : "Make read-only"}</MenuItem>
                      {running && isSaved(v) && (
                        <MenuLinkItem render={<a href={archive(v.mountPath)} download />}>
                          <Download /> Download as .tar
                        </MenuLinkItem>
                      )}
                      <MenuSeparator />
                      <MenuItem danger onClick={() => remove(i)}>
                        <Trash2 /> Remove mount
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
                {v.readOnly && <span className="text-[11px] text-muted sm:col-span-3">Read-only</span>}
              </div>
            ))}
            {!data && rows.length === 0 && <p className="text-[13px] text-muted">No volumes. Files written inside the container are lost on every deploy.</p>}
            {removed.length > 0 && (
              <div className="flex flex-col gap-2 rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-fg-2">
                {removed.map((source) => (
                  <div key={source} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      The volume <span className="font-mono">{source}</span> is no longer mounted. Its data is kept until you delete it.
                    </span>
                    <Button
                      size="xs"
                      variant="danger"
                      loading={purge.pending}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Delete the data of ${source}?`,
                            description: "Redeploy first so no container uses it. The data cannot be recovered.",
                            confirmLabel: "Delete data",
                            danger: true,
                          })
                        )
                          purge.run(source);
                      }}
                    >
                      Delete data
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </TabsPanel>

          <TabsPanel value="files" className="mt-4 flex flex-col gap-3">
            {rows.map(({ v, i }) => (
              <div key={i} className="flex flex-col gap-2.5 rounded-xl border border-line p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-end">
                  {v.kind === "file" ? (
                    <Cell label="File name">
                      <span className="hidden text-[11px] font-medium text-faint sm:block">File name</span>
                      <Input value={v.source} onChange={(e) => update(i, { source: e.target.value })} placeholder="app.conf" className="h-8 font-mono text-[12.5px]" />
                    </Cell>
                  ) : (
                    <Cell label="Path on the server">
                      <span className="hidden text-[11px] font-medium text-faint sm:block">Path on the server</span>
                      <Input
                        value={v.source}
                        onChange={(e) => update(i, { source: e.target.value })}
                        placeholder="/etc/ssl/certs/ca.pem"
                        className="h-8 font-mono text-[12.5px]"
                        disabled={!isRootAdmin}
                      />
                    </Cell>
                  )}
                  <Cell label="Mounted at">
                    <span className="hidden text-[11px] font-medium text-faint sm:block">Mounted at</span>
                    <Input value={v.mountPath} onChange={(e) => update(i, { mountPath: e.target.value })} placeholder="/etc/app/app.conf" className="h-8 font-mono text-[12.5px]" />
                  </Cell>
                  <Button variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove file">
                    <Trash2 />
                  </Button>
                </div>
                {v.kind === "file" && (
                  <Textarea
                    value={v.content ?? ""}
                    onChange={(e) => update(i, { content: e.target.value })}
                    rows={Math.min(16, Math.max(4, (v.content ?? "").split("\n").length + 1))}
                    placeholder="File content"
                    spellCheck={false}
                    className="font-mono text-[12.5px]"
                  />
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Toggle label="Read-only" checked={!!v.readOnly} onChange={(c) => update(i, { readOnly: c })} />
                  <span className="text-[11px] text-faint">
                    {v.kind === "file" ? "Serve writes this file on the server before each start." : "An existing file on the server."}
                  </span>
                </div>
              </div>
            ))}
            {rows.length === 0 && (
              <p className="text-[13px] text-muted">No files. Add a configuration file and edit its content here, or mount a file that already exists on the server.</p>
            )}
          </TabsPanel>

          <TabsPanel value="directories" className="mt-4 flex flex-col gap-2">
            {!isRootAdmin && <p className="text-xs text-muted">Only admins of the Root organization can mount paths from the server.</p>}
            {rows.map(({ v, i }) => (
              <div key={i} className="flex flex-col gap-2 rounded-xl border border-line p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                  <Cell label="Directory on the server">
                    <span className="hidden text-[11px] font-medium text-faint sm:block">Directory on the server</span>
                    <Input
                      value={v.source}
                      onChange={(e) => update(i, { source: e.target.value })}
                      placeholder="/srv/media"
                      className="h-8 font-mono text-[12.5px]"
                      disabled={!isRootAdmin}
                    />
                  </Cell>
                  <Cell label="Mounted at">
                    <span className="hidden text-[11px] font-medium text-faint sm:block">Mounted at</span>
                    <Input value={v.mountPath} onChange={(e) => update(i, { mountPath: e.target.value })} placeholder="/media" className="h-8 font-mono text-[12.5px]" />
                  </Cell>
                  <Button variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove directory">
                    <Trash2 />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-4">
                  <Toggle label="Create if missing" checked={!!v.create} onChange={(c) => update(i, { create: c, hostType: "directory" })} />
                  <Toggle label="Read-only" checked={!!v.readOnly} onChange={(c) => update(i, { readOnly: c })} />
                </div>
              </div>
            ))}
            {rows.length === 0 && <p className="text-[13px] text-muted">No directories. Mount a directory from the server, for example shared media or backups.</p>}
          </TabsPanel>
        </Tabs>
      </CardBody>
      <CardFooter>
        <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : "Applies on the next deploy or restart."}</span>
        <div className="flex flex-none gap-2">
          {dirty && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setValue(JSON.parse(saved))}>
              Discard
            </Button>
          )}
          <Button variant="primary" size="sm" disabled={!dirty} loading={pending} onClick={submit}>
            Save
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
