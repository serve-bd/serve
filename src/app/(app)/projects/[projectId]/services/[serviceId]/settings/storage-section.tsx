"use client";

import * as React from "react";
import { ArrowRight, Download, FileText, Folder, HardDrive, Lock, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge, Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { useCan } from "@/components/permissions";
import { deleteVolumeData } from "@/server/actions/databases";
import type { VolumeMount } from "@/server/services/types";

type MountType = "volume" | "file" | "directory" | "serverFile";

const typeOf = (v: VolumeMount): MountType => (v.kind === "volume" ? "volume" : v.kind === "file" ? "file" : v.hostType === "file" ? "serverFile" : "directory");

/** What each type of mount is, and a blank one to start from. Server paths are for Root admins only. */
const TYPES: Record<MountType, { icon: typeof HardDrive; label: string; hint: string; root?: boolean; blank: () => VolumeMount }> = {
  volume: { icon: HardDrive, label: "Volume", hint: "Managed by Docker, kept across deploys", blank: () => ({ kind: "volume", source: "", mountPath: "" }) },
  file: { icon: FileText, label: "File", hint: "A config file you write here", blank: () => ({ kind: "file", source: "", mountPath: "", content: "" }) },
  directory: {
    icon: Folder,
    label: "Directory",
    hint: "A folder on the server",
    root: true,
    blank: () => ({ kind: "bind", source: "", mountPath: "", hostType: "directory", create: true }),
  },
  serverFile: {
    icon: FileText,
    label: "Server file",
    hint: "A file that already exists on the server",
    root: true,
    blank: () => ({ kind: "bind", source: "", mountPath: "", hostType: "file" }),
  },
};

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-[13px] text-fg-2">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}

/** One mount as a row: type, where its data comes from, and where the container sees it. */
function MountRow({
  type,
  source,
  mountPath,
  readOnly,
  unsaved,
  actions,
}: {
  type: MountType;
  source: string;
  mountPath: string;
  readOnly?: boolean;
  unsaved?: boolean;
  actions: React.ReactNode;
}) {
  const { icon: Icon, label } = TYPES[type];
  return (
    <li className="flex items-center gap-3 px-3.5 py-3 sm:px-4">
      <span className="grid size-9 flex-none place-items-center rounded-[10px] bg-surface-2 text-muted ring-1 ring-line">
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          {label}
          {readOnly && (
            <Badge>
              <Lock /> Read-only
            </Badge>
          )}
          {unsaved && (
            <span title="Not saved yet" className="size-1.5 rounded-full bg-accent">
              <span className="sr-only">Not saved</span>
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 font-mono text-[12.5px] text-fg">
          <span className="max-w-full truncate" title={source}>
            {source}
          </span>
          <ArrowRight aria-label="mounted at" className="size-3 flex-none text-faint" />
          <span className="max-w-full truncate" title={mountPath}>
            {mountPath}
          </span>
        </span>
      </div>
      <div className="flex flex-none items-center">{actions}</div>
    </li>
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
  /** The mount in the editor: a row of the list, a new one, or the database's data volume. */
  const [editing, setEditing] = React.useState<{ at: number | "new" | "data"; draft: VolumeMount } | null>(null);
  const [removed, setRemoved] = React.useState<string[]>([]);
  const dirty = JSON.stringify(value) !== saved;
  const purging = React.useRef("");
  const purge = useAction((source: string) => ((purging.current = source), deleteVolumeData(serviceId, source)), {
    success: "Volume data deleted",
    onSuccess: () => setRemoved((r) => r.filter((x) => x !== purging.current)),
  });

  const remove = (i: number) => setValue((s) => ({ ...s, volumes: s.volumes.filter((_, j) => j !== i) }));
  const startAdding = (type: MountType) => setEditing({ at: "new", draft: TYPES[type].blank() });
  const archive = (path: string) => `/api/services/${serviceId}/volumes/archive?path=${encodeURIComponent(path)}`;
  // The archive holds the files as they are, secrets included: the download needs to see them.
  const canDownload = useCan()("variables.view-secrets");
  const savedVolumes = (JSON.parse(saved) as typeof initial).volumes;
  const isSaved = (v: VolumeMount) => savedVolumes.some((s) => s.kind === v.kind && s.source === v.source && s.mountPath === v.mountPath);
  const canAdd = (type: MountType) => !TYPES[type].root || isRootAdmin;

  const finishEditing = () => {
    if (!editing) return;
    const { at, draft } = editing;
    const next = { ...draft, source: draft.source.trim(), mountPath: draft.mountPath.trim() };
    if (at === "data") setValue((s) => ({ ...s, dataPath: next.mountPath }));
    else if (at === "new") setValue((s) => ({ ...s, volumes: [...s.volumes, next] }));
    else setValue((s) => ({ ...s, volumes: s.volumes.map((x, j) => (j === at ? next : x)) }));
    setEditing(null);
  };

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

  const empty = !data && value.volumes.length === 0;
  const moved = !!data && !!value.dataPath.trim() && value.dataPath.trim() !== data.mountPath;

  return (
    <Card id="storage" className="scroll-mt-6">
      <CardHeader
        title="Persistent storage"
        description="Data that survives restarts and deploys. Volumes are managed by Docker; files and server paths are mounted into the container."
        actions={
          !empty && (
            <Menu>
              <MenuTrigger render={<Button size="sm" />}>
                <Plus /> Add mount
              </MenuTrigger>
              <MenuContent align="end" className="w-72">
                {(["volume", "file", "directory", "serverFile"] as const).map((type) => {
                  const { icon: Icon, label, hint, root } = TYPES[type];
                  return (
                    <MenuItem key={type} disabled={!canAdd(type)} onClick={() => startAdding(type)} className="items-start py-2">
                      <Icon className="mt-0.5" />
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium text-fg">{label}</span>
                        <span className="text-[12px] text-muted">
                          {hint}
                          {root && ". Root admins only"}
                        </span>
                      </span>
                    </MenuItem>
                  );
                })}
              </MenuContent>
            </Menu>
          )
        }
      />
      <CardBody className="flex flex-col gap-4 py-5">
        {empty ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[13px] text-muted">No storage yet. Files written inside the container are lost on every deploy.</p>
            <div className="flex flex-wrap gap-2">
              {(["volume", "file", "directory"] as const).map((type) => {
                const { icon: Icon, label } = TYPES[type];
                return (
                  <Button
                    key={type}
                    size="sm"
                    onClick={() => startAdding(type)}
                    disabled={!canAdd(type)}
                    title={canAdd(type) ? undefined : "Only admins of the Root organization can mount paths from the server."}
                  >
                    <Icon /> Add {label.toLowerCase()}
                  </Button>
                );
              })}
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {data && (
              <MountRow
                type="volume"
                source="data"
                mountPath={value.dataPath.trim() || data.defaultPath}
                unsaved={moved}
                actions={
                  <>
                    {!canDownload ? null : running ? (
                      <a
                        href={archive(data.mountPath)}
                        download
                        title="Download as .tar"
                        aria-label="Download as .tar"
                        className={buttonVariants({ variant: "ghost", size: "icon" })}
                      >
                        <Download />
                      </a>
                    ) : (
                      <Button variant="ghost" size="icon" disabled title="Start the database to download" aria-label="Download as .tar">
                        <Download />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Edit data volume"
                      onClick={() => setEditing({ at: "data", draft: { kind: "volume", source: "data", mountPath: value.dataPath } })}
                    >
                      <Pencil />
                    </Button>
                  </>
                }
              />
            )}
            {value.volumes.map((v, i) => (
              <MountRow
                key={i}
                type={typeOf(v)}
                source={v.source}
                mountPath={v.mountPath}
                readOnly={v.readOnly}
                unsaved={!isSaved(v)}
                actions={
                  <>
                    {v.kind === "volume" && running && canDownload && isSaved(v) && (
                      <a href={archive(v.mountPath)} download title="Download as .tar" aria-label="Download as .tar" className={buttonVariants({ variant: "ghost", size: "icon" })}>
                        <Download />
                      </a>
                    )}
                    <Button variant="ghost" size="icon" aria-label="Edit mount" onClick={() => setEditing({ at: i, draft: v })}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="Remove mount" onClick={() => remove(i)} className="hover:text-bad">
                      <Trash2 />
                    </Button>
                  </>
                }
              />
            ))}
          </ul>
        )}
        {moved && data && (
          <p className="flex items-start gap-1.5 text-xs text-warn">
            <TriangleAlert className="mt-px size-3.5 flex-none" />
            The database looks for its files at {data.defaultPath}. Moving the volume only helps with images that use another data directory; otherwise the database starts empty.
          </p>
        )}
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

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent size={editing && editing.draft.kind === "file" ? "lg" : "md"}>
          {editing && (
            <MountEditor
              editing={editing}
              isRootAdmin={isRootAdmin}
              data={data}
              taken={[
                ...(data && editing.at !== "data" ? [value.dataPath.trim() || data.defaultPath] : []),
                ...value.volumes.filter((_, j) => j !== editing.at).map((x) => x.mountPath),
              ]}
              onChange={(patch) => setEditing((e) => e && { ...e, draft: { ...e.draft, ...patch } })}
              onDone={finishEditing}
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** The fields of one mount, in a dialog. Changes join the card's unsaved changes; Save applies them. */
function MountEditor({
  editing,
  isRootAdmin,
  data,
  taken,
  onChange,
  onDone,
}: {
  editing: { at: number | "new" | "data"; draft: VolumeMount };
  isRootAdmin: boolean;
  data?: { mountPath: string; defaultPath: string };
  /** Container paths other mounts use. */
  taken: string[];
  onChange: (patch: Partial<VolumeMount>) => void;
  onDone: () => void;
}) {
  const { at, draft: v } = editing;
  const type = typeOf(v);
  const { label, hint } = TYPES[type];
  const isData = at === "data";
  const server = v.kind === "bind";
  const norm = (p: string) => (p.trim().length > 1 ? p.trim().replace(/\/+$/, "") : p.trim());
  const clash = !!v.mountPath.trim() && taken.some((p) => norm(p) === norm(v.mountPath));
  const complete = !clash && (isData || (v.source.trim() && v.mountPath.trim()));
  const mono = "font-mono text-[13px]";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (complete) onDone();
      }}
    >
      <DialogHeader
        title={isData ? "Database data" : `${at === "new" ? "Add" : "Edit"} ${label.toLowerCase()}`}
        description={isData ? "The volume that holds the database files." : `${hint}.`}
      />
      <DialogBody>
        {!isData && (
          <Field
            label={v.kind === "volume" ? "Volume name" : v.kind === "file" ? "File name" : type === "serverFile" ? "File on the server" : "Directory on the server"}
            description={server && !isRootAdmin ? "Only admins of the Root organization can change server paths." : undefined}
          >
            <Input
              value={v.source}
              onChange={(e) => onChange({ source: e.target.value })}
              placeholder={v.kind === "volume" ? "uploads" : v.kind === "file" ? "app.conf" : type === "serverFile" ? "/etc/ssl/certs/ca.pem" : "/srv/media"}
              disabled={server && !isRootAdmin}
              autoFocus={at === "new"}
              className={mono}
            />
          </Field>
        )}
        <Field label="Mounted at" description="The path inside the container." error={clash ? "Another mount already uses this path." : undefined}>
          <Input
            value={v.mountPath}
            onChange={(e) => onChange({ mountPath: e.target.value })}
            placeholder={
              isData ? data?.defaultPath : v.kind === "volume" ? "/app/uploads" : v.kind === "file" ? "/etc/app/app.conf" : type === "serverFile" ? "/etc/ssl/ca.pem" : "/media"
            }
            autoFocus={isData}
            className={mono}
          />
        </Field>
        {isData && data && v.mountPath.trim() && v.mountPath.trim() !== data.mountPath && (
          <p className="flex items-start gap-1.5 text-xs text-warn">
            <TriangleAlert className="mt-px size-3.5 flex-none" />
            The database looks for its files at {data.defaultPath}. Moving the volume only helps with images that use another data directory.
          </p>
        )}
        {v.kind === "file" && (
          <Field label="Content" description="Written on the server before each start.">
            <Textarea
              value={v.content ?? ""}
              onChange={(e) => onChange({ content: e.target.value })}
              rows={Math.min(16, Math.max(6, (v.content ?? "").split("\n").length + 1))}
              placeholder="File content"
              spellCheck={false}
              className="font-mono text-[12.5px]"
            />
          </Field>
        )}
        {!isData && (
          <div className="flex flex-wrap gap-x-5 gap-y-3">
            <Toggle label="Read-only" checked={!!v.readOnly} onChange={(c) => onChange({ readOnly: c })} />
            {type === "directory" && <Toggle label="Create if missing" checked={!!v.create} onChange={(c) => onChange({ create: c, hostType: "directory" })} />}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" size="sm" />}>Cancel</DialogClose>
        <Button type="submit" variant="primary" size="sm" disabled={!complete}>
          {at === "new" ? "Add" : "Done"}
        </Button>
      </DialogFooter>
    </form>
  );
}
