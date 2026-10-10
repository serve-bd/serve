"use client";

import * as React from "react";
import useSWR from "swr";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUp,
  ChevronRight,
  Download,
  File as FileIcon,
  FileSymlink,
  Folder,
  FolderPlus,
  FolderSymlink,
  HardDrive,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PenLine,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, EmptyState, Skeleton } from "@/components/ui/misc";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { cn, formatBytes } from "@/lib/utils";
import { FileEditor } from "./file-editor";
import { NameDialog } from "./name-dialog";
import { type Entry, joinPath, type Listing, parentOf, request, segmentsOf } from "./files-api";

type Target = { name: string; composeService: string | null; key: string; server: string | null };

const when = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

type UploadItem = { id: number; name: string; dest: string; size: number; loaded: number; state: "sending" | "done" | "failed"; error?: string; xhr?: XMLHttpRequest };

/**
 * Browse, upload, download, edit, rename and delete files: on a server (its whole disk) or in a
 * service's container. `endpoint` is /api/servers/{id}/files or /api/services/{id}/files; for a
 * service, `containers` lists its running containers (the console's list) to pick one.
 */
export function FileManager({
  endpoint,
  title,
  containers,
  ownServer,
}: {
  endpoint: string;
  /** The server's or the service's name, shown for the top folder. */
  title: string;
  /** A service: where its running containers are listed (/api/services/{id}/exec). */
  containers?: string;
  ownServer?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const path = params.get("path") || "/";
  const container = params.get("container");
  const fs = useFullscreen();
  const confirm = useConfirm();

  const { data: targetData } = useSWR<{ targets: Target[] }>(containers ?? null, { refreshInterval: 15000 });
  const targets = targetData?.targets ?? [];
  const selected = container ?? targets[0]?.key ?? null;
  const several = targets.some((t) => t.server);
  const labelOf = (t: Target) => (several ? `${t.composeService ?? t.name} · ${t.server ?? ownServer ?? "main"}` : (t.composeService ?? t.name));
  // A service waits for its containers: the files come from one of them.
  const waiting = !!containers && !targetData;
  const extra = containers && selected ? { container: selected } : undefined;

  const key = waiting ? null : ["files", endpoint, path, selected ?? ""];
  const { data, error, isLoading, mutate } = useSWR<Listing, Error & { status?: number }>(key, () => request<Listing>(endpoint, { op: "list", path, ...extra }), {
    revalidateOnFocus: true,
    keepPreviousData: true,
  });

  const [filter, setFilter] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(params.get("edit"));
  const [dialog, setDialog] = React.useState<{ kind: "mkdir" } | { kind: "rename"; entry: Entry } | null>(null);
  const [uploads, setUploads] = React.useState<UploadItem[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const [editingPath, setEditingPath] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const nextId = React.useRef(1);
  const crumbs = React.useRef<HTMLElement>(null);

  const go = React.useCallback(
    (to: string, opts: { edit?: string | null; container?: string | null } = {}) => {
      const next = new URLSearchParams(params.toString());
      if (to === "/") next.delete("path");
      else next.set("path", to);
      if (opts.edit) next.set("edit", opts.edit);
      else next.delete("edit");
      if (opts.container !== undefined) {
        if (opts.container) next.set("container", opts.container);
        else next.delete("container");
      }
      setFilter("");
      setEditing(opts.edit ?? null);
      const qs = next.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  // Back and forward in the browser move between folders and the editor.
  React.useEffect(() => setEditing(params.get("edit")), [params]);

  const here = data?.path ?? path;
  // A long path shows its end: the folder you are in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the path changes.
  React.useEffect(() => {
    if (crumbs.current) crumbs.current.scrollLeft = crumbs.current.scrollWidth;
  }, [here, editing]);
  const entries = data?.entries ?? [];
  const q = filter.trim().toLowerCase();
  const shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  const mountAt = (p: string) => data?.mounts?.find((m) => m.path === p);

  // Ticked entries of this folder, for actions on several at once.
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const lastPick = React.useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another folder or container starts with nothing ticked.
  React.useEffect(() => {
    setPicked(new Set());
    lastPick.current = null;
  }, [here, selected]);
  // Entries gone (deleted, renamed) leave the selection.
  const pickedNames = entries.filter((e) => picked.has(e.name)).map((e) => e.name);
  const allShown = shown.length > 0 && shown.every((e) => picked.has(e.name));
  const togglePick = (index: number, shift: boolean) => {
    const name = shown[index].name;
    setPicked((old) => {
      const next = new Set(old);
      const on = !old.has(name);
      // Shift-click ticks (or unticks) the whole run from the last one clicked.
      const from = shift && lastPick.current !== null ? Math.min(lastPick.current, index) : index;
      const to = shift && lastPick.current !== null ? Math.max(lastPick.current, index) : index;
      for (let i = from; i <= to; i++) {
        if (on) next.add(shown[i].name);
        else next.delete(shown[i].name);
      }
      return next;
    });
    lastPick.current = index;
  };
  const hereMount = mountAt(here);

  const open = (e: Entry) => {
    const full = joinPath(here, e.name);
    if (e.type === "dir") return go(full);
    if (e.type === "link") {
      if (e.link?.kind === "dir") return go(e.link.target.startsWith("/") ? e.link.target : joinPath(here, e.link.target));
      if (e.link?.kind === "file") return go(here, { edit: full });
      return toast.error("This link points nowhere", `${e.name} → ${e.link?.target ?? "?"}`);
    }
    if (e.type === "file") return go(here, { edit: full });
  };

  const downloadUrl = (p: string, names: string[] = []) => {
    const qs = new URLSearchParams({ op: "download", path: p, ...extra });
    for (const n of names) qs.append("name", n);
    return `${endpoint}?${qs}`;
  };

  /** Several entries of this folder: one .tar.gz (one plain file downloads as itself). */
  const downloadMany = (names: string[]) => {
    const one = names.length === 1 ? entries.find((e) => e.name === names[0]) : undefined;
    const a = document.createElement("a");
    a.href = one ? downloadUrl(joinPath(here, one.name)) : downloadUrl(here, names);
    a.download = "";
    a.click();
  };

  const removeMany = async (names: string[]) => {
    if (!names.length) return;
    const list = names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length - 5} more` : "");
    const ok = await confirm({
      title: `Delete ${names.length} items?`,
      description: `${list} in ${here} are deleted, folders with everything in them. This cannot be undone.`,
      confirmLabel: `Delete ${names.length} items`,
      danger: true,
    });
    if (!ok) return;
    const failed: string[] = [];
    for (const name of names) {
      try {
        await request(endpoint, { ...extra }, { op: "delete", path: joinPath(here, name) });
      } catch (err) {
        failed.push(`${name}: ${(err as Error).message}`);
      }
    }
    setPicked(new Set());
    await mutate();
    if (failed.length) toast.error(`Could not delete ${failed.length} of ${names.length}`, failed.slice(0, 3).join("\n"));
  };

  const remove = async (e: Entry) => {
    const full = joinPath(here, e.name);
    const folder = e.type === "dir";
    const ok = await confirm({
      title: `Delete ${e.name}?`,
      description: folder ? `The folder ${full} and everything in it are deleted. This cannot be undone.` : `${full} is deleted. This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await request(endpoint, { ...extra }, { op: "delete", path: full });
      await mutate();
    } catch (err) {
      toast.error(`Could not delete ${e.name}`, (err as Error).message);
    }
  };

  /** The actions of one entry (its ⋯ menu, its right-click menu), or of all ticked ones. */
  const rowItems = (e: Entry, many: boolean) => {
    if (many)
      return (
        <>
          <MenuItem onClick={() => downloadMany(pickedNames)}>
            <Download /> Download {pickedNames.length} items
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onClick={() => void removeMany(pickedNames)}>
            <Trash2 /> Delete {pickedNames.length} items
          </MenuItem>
        </>
      );
    const full = joinPath(here, e.name);
    const isDir = e.type === "dir" || e.link?.kind === "dir";
    return (
      <>
        {isDir && (
          <MenuItem onClick={() => open(e)}>
            <Folder /> Open
          </MenuItem>
        )}
        {(e.type === "file" || e.link?.kind === "file") && (
          <MenuItem onClick={() => open(e)}>
            <Pencil /> Edit
          </MenuItem>
        )}
        {(e.type === "file" || e.type === "dir" || (e.link && e.link.kind !== "missing")) && (
          <MenuItem render={<a href={downloadUrl(full)} download />}>
            <Download /> {isDir ? "Download as .tar.gz" : "Download"}
          </MenuItem>
        )}
        <MenuItem onClick={() => setDialog({ kind: "rename", entry: e })}>
          <PenLine /> Rename
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger onClick={() => void remove(e)}>
          <Trash2 /> Delete
        </MenuItem>
      </>
    );
  };

  const upload = (files: File[], replace = false) => {
    const dir = here;
    for (const file of files) {
      const id = nextId.current++;
      const dest = joinPath(dir, file.name);
      const xhr = new XMLHttpRequest();
      const qs = new URLSearchParams({ path: dest, ...extra, ...(replace ? { replace: "1" } : {}) });
      xhr.open("PUT", `${endpoint}?${qs}`);
      setUploads((u) => [...u, { id, name: file.name, dest, size: file.size, loaded: 0, state: "sending", xhr }]);
      const update = (patch: Partial<UploadItem>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      xhr.upload.onprogress = (ev) => update({ loaded: ev.loaded });
      xhr.onabort = () => setUploads((u) => u.filter((x) => x.id !== id));
      xhr.onerror = () => update({ state: "failed", error: "The connection was lost." });
      xhr.onload = async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          update({ state: "done", loaded: file.size, xhr: undefined });
          void mutate();
          // Finished uploads leave the list after a moment.
          setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 4000);
          return;
        }
        let message = "";
        try {
          message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? "";
        } catch {
          message =
            xhr.status === 413
              ? "The dashboard's proxy refused a file this big. Raise its upload limit (Server → Proxy), or use serve upload from the CLI."
              : `The upload failed (HTTP ${xhr.status}).`;
        }
        if (xhr.status === 409 && !replace) {
          setUploads((u) => u.filter((x) => x.id !== id));
          const ok = await confirm({
            title: `Replace ${file.name}?`,
            description: `${dest} already exists. Uploading replaces it; its owner and mode stay.`,
            confirmLabel: "Replace",
          });
          if (ok) upload([file], true);
          return;
        }
        update({ state: "failed", error: message, xhr: undefined });
      };
      xhr.send(file);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    // Folders arrive as empty "files" without a type; they cannot be read as one.
    const real = files.filter((f) => f.type || f.size > 0 || /\.[^.]+$/.test(f.name));
    if (real.length < files.length) toast.warning("Folders are not uploaded", "Drop files, or pack the folder first. The CLI uploads folders: serve upload ./folder …");
    if (real.length) upload(real);
  };

  const errStatus = error?.status;
  const noContainer = (containers && targetData && !targets.length) || errStatus === 409;

  return (
    <div
      className={cn("flex flex-col overflow-hidden bg-surface", fs.full ? "fixed inset-0 z-40" : "rounded-2xl border border-line shadow-sm")}
      onDragOver={(e) => {
        if (editing || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={editing ? undefined : onDrop}
    >
      {/* Where we are, and what can be done here. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <Tooltip content="Up one folder">
          <Button variant="ghost" size="icon-sm" aria-label="Up one folder" disabled={here === "/" && !editing} onClick={() => (editing ? go(here) : go(parentOf(here)))}>
            <ArrowUp />
          </Button>
        </Tooltip>
        {editingPath ? (
          <form
            className="order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              const v = String(new FormData(e.currentTarget).get("p") ?? "").trim();
              setEditingPath(false);
              if (v.startsWith("/")) go(v);
            }}
          >
            <Input
              name="p"
              defaultValue={here}
              autoFocus
              onBlur={() => setEditingPath(false)}
              className="h-8 font-mono text-[12.5px]"
              aria-label="Go to folder"
              spellCheck={false}
            />
          </form>
        ) : (
          // On a phone the path gets its own row, below the buttons.
          <nav
            ref={crumbs}
            aria-label="Folder"
            className="order-last flex w-full min-w-0 cursor-text items-center gap-0.5 overflow-x-auto rounded-lg px-1 py-1 text-[13px] sm:order-none sm:w-auto sm:flex-1"
            onClick={(e) => e.target === e.currentTarget && setEditingPath(true)}
          >
            <button
              type="button"
              onClick={() => go("/")}
              className="flex flex-none items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium text-fg-2 hover:bg-hover hover:text-fg"
            >
              <HardDrive className="size-3.5 text-muted" />
              {title}
            </button>
            {segmentsOf(here).map((s, i, all) => (
              <React.Fragment key={s.path}>
                <ChevronRight className="size-3.5 flex-none text-faint" />
                <button
                  type="button"
                  onClick={() => go(s.path)}
                  className={cn(
                    "flex-none truncate rounded-md px-1.5 py-0.5 font-mono text-[12.5px] hover:bg-hover hover:text-fg",
                    i === all.length - 1 && !editing ? "text-fg" : "text-fg-2",
                  )}
                >
                  {s.name}
                </button>
              </React.Fragment>
            ))}
            {editing && (
              <>
                <ChevronRight className="size-3.5 flex-none text-faint" />
                <span className="flex-none truncate px-1.5 font-mono text-[12.5px] text-fg">{editing.slice(editing.lastIndexOf("/") + 1)}</span>
              </>
            )}
            {hereMount && !editing && (
              <Badge tone="info" className="ml-1.5 flex-none">
                {hereMount.kind === "volume" ? `Volume ${hereMount.name}` : "Mounted from the host"}
              </Badge>
            )}
          </nav>
        )}
        <div className="ml-auto flex flex-none items-center gap-1">
          {containers && targets.length > 1 && (
            <Select
              size="sm"
              value={selected}
              onValueChange={(v) => go("/", { container: v })}
              options={targets.map((t) => ({ value: t.key, label: labelOf(t) }))}
              className="w-44"
              aria-label="Container"
            />
          )}
          {!editing && pickedNames.length > 0 && (
            <>
              <span className="px-1 text-[13px] text-fg-2 tabular-nums">{pickedNames.length} selected</span>
              <Button size="sm" onClick={() => downloadMany(pickedNames)}>
                <Download /> <span className="hidden sm:inline">Download</span>
              </Button>
              <Button size="sm" variant="danger-ghost" onClick={() => void removeMany(pickedNames)}>
                <Trash2 /> <span className="hidden sm:inline">Delete</span>
              </Button>
              <Tooltip content="Clear the selection">
                <Button variant="ghost" size="icon-sm" aria-label="Clear the selection" onClick={() => setPicked(new Set())}>
                  <X />
                </Button>
              </Tooltip>
            </>
          )}
          {!editing && !pickedNames.length && (
            <>
              <div className="relative hidden sm:block">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
                <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="h-8 w-36 pl-8 text-[13px]" aria-label="Filter this folder" />
              </div>
              <Tooltip content="Refresh">
                <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={() => void mutate()}>
                  <RefreshCw className={cn(isLoading && "animate-spin")} />
                </Button>
              </Tooltip>
              <Button size="sm" onClick={() => setDialog({ kind: "mkdir" })} disabled={!data} aria-label="New folder">
                <FolderPlus /> <span className="hidden md:inline">New folder</span>
              </Button>
              <Button size="sm" variant="primary" onClick={() => fileInput.current?.click()} disabled={!data}>
                <Upload /> Upload
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  upload([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </>
          )}
          <Tooltip content={fs.full ? "Exit full screen (Esc)" : "Full screen"}>
            <Button variant="ghost" size="icon-sm" aria-label={fs.full ? "Exit full screen" : "Full screen"} onClick={fs.toggle}>
              {fs.full ? <Minimize2 /> : <Maximize2 />}
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className={cn("relative min-h-0", fs.full ? "flex-1" : "h-[min(68vh,640px)] min-h-80")}>
        {editing ? (
          <FileEditor
            key={`${selected}:${editing}`}
            endpoint={endpoint}
            extra={extra}
            path={editing}
            downloadUrl={downloadUrl(editing)}
            onSaved={() => void mutate()}
            onClose={() => go(here)}
            full={fs.full}
          />
        ) : noContainer ? (
          <EmptyState
            icon={<HardDrive />}
            title="No running container"
            description={error?.message && errStatus === 409 ? error.message : "Files are read from a running container. Start or deploy the service first."}
          />
        ) : error && !data ? (
          <EmptyState
            icon={<TriangleAlert />}
            title={errStatus === 404 ? "This folder does not exist" : errStatus === 403 ? "No access" : "Could not open this folder"}
            description={error.message}
            action={
              here !== "/" && (
                <Button size="sm" onClick={() => go(parentOf(here))}>
                  <ArrowUp /> Up one folder
                </Button>
              )
            }
          />
        ) : !data ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-7" />
            ))}
          </div>
        ) : (
          <div className="h-full overflow-auto">
            {error && <p className="border-b border-line bg-warn-soft px-4 py-2 text-xs text-fg-2">{error.message}</p>}
            <table className="w-full table-fixed text-[13px]">
              <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur">
                <tr className="border-b border-line text-left text-[11.5px] font-medium text-muted">
                  <th className="w-10 pl-4">
                    <Checkbox
                      aria-label="Select all"
                      checked={allShown}
                      indeterminate={!allShown && shown.some((e) => picked.has(e.name))}
                      disabled={!shown.length}
                      onCheckedChange={(on) => setPicked(on ? new Set(shown.map((e) => e.name)) : new Set())}
                    />
                  </th>
                  <th className="py-2 pr-2 pl-1 font-medium">Name</th>
                  <th className="hidden w-24 px-2 text-right font-medium sm:table-cell">Size</th>
                  <th className="hidden w-44 px-2 font-medium md:table-cell">Modified</th>
                  <th className="hidden w-32 px-2 font-medium lg:table-cell">Owner</th>
                  <th className="hidden w-28 px-2 font-medium lg:table-cell">Mode</th>
                  <th className="w-12" />
                </tr>
              </thead>
              <tbody>
                {shown.map((e, index) => {
                  const full = joinPath(here, e.name);
                  const isPicked = picked.has(e.name);
                  // Right-clicking one of several ticked entries acts on all of them.
                  const many = isPicked && pickedNames.length > 1;
                  const mount = mountAt(full);
                  const isDir = e.type === "dir" || e.link?.kind === "dir";
                  const Icon = e.type === "link" ? (isDir ? FolderSymlink : FileSymlink) : isDir ? Folder : FileIcon;
                  return (
                    <ContextMenu key={e.name}>
                      <ContextMenuTrigger
                        render={<tr className={cn("group border-b border-line/60 hover:bg-hover data-[popup-open]:bg-hover", isPicked && "bg-accent-soft/40")} />}
                      >
                        <td className="pl-4">
                          <Checkbox
                            aria-label={`Select ${e.name}`}
                            checked={isPicked}
                            // Shift-click picks a run: without this the browser also selects the text between.
                            onMouseDown={(ev) => ev.shiftKey && ev.preventDefault()}
                            onClick={(ev) => {
                              ev.preventDefault();
                              togglePick(index, ev.shiftKey);
                            }}
                          />
                        </td>
                        <td className="py-0 pr-2 pl-1">
                          <button
                            type="button"
                            onClick={() => open(e)}
                            disabled={e.type === "other"}
                            className="flex w-full min-w-0 items-center gap-2.5 py-2 text-left disabled:cursor-default"
                            title={e.link ? `${e.name} → ${e.link.target}` : e.name}
                          >
                            <Icon className={cn("size-4 flex-none", isDir ? "text-accent" : "text-muted", e.link?.kind === "missing" && "text-bad")} />
                            <span className={cn("truncate", isDir ? "font-medium text-fg" : "text-fg-2", e.name.startsWith(".") && "opacity-75")}>{e.name}</span>
                            {e.link && <span className="hidden truncate font-mono text-[11.5px] text-faint sm:inline">→ {e.link.target}</span>}
                            {mount && (
                              <Badge tone="info" className="flex-none">
                                {mount.kind === "volume" ? "Volume" : "Mount"}
                              </Badge>
                            )}
                          </button>
                        </td>
                        <td className="hidden px-2 text-right font-mono text-[12px] text-muted tabular-nums sm:table-cell">{e.type === "file" ? formatBytes(e.size) : ""}</td>
                        <td className="hidden truncate px-2 text-[12px] text-muted md:table-cell">{when.format(e.mtime)}</td>
                        <td className="hidden truncate px-2 font-mono text-[12px] text-muted lg:table-cell">
                          {e.owner}
                          {e.group !== e.owner && <span className="text-faint">:{e.group}</span>}
                        </td>
                        <td className="hidden px-2 font-mono text-[12px] text-faint lg:table-cell">{e.mode}</td>
                        <td className="pr-2 text-right">
                          <Menu>
                            <MenuTrigger
                              aria-label={`Actions for ${e.name}`}
                              className="rounded-md p-1.5 text-faint opacity-60 outline-none hover:bg-surface hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
                            >
                              <MoreHorizontal className="size-4" />
                            </MenuTrigger>
                            <MenuContent>{rowItems(e, false)}</MenuContent>
                          </Menu>
                        </td>
                      </ContextMenuTrigger>
                      <ContextMenuContent>{rowItems(e, many)}</ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </tbody>
            </table>
            {!shown.length && (
              <EmptyState
                icon={<Folder />}
                title={q ? `Nothing matches “${filter}”` : "This folder is empty"}
                description={q ? undefined : "Drop files here, or use Upload."}
                className="py-12"
              />
            )}
          </div>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/60 text-[13px] font-medium text-fg">
            Drop to upload to <span className="ml-1 font-mono">{here}</span>
          </div>
        )}
      </div>

      {uploads.length > 0 && (
        <ul className="flex max-h-40 flex-col divide-y divide-line overflow-y-auto border-t border-line bg-surface-2 text-[12.5px]">
          {uploads.map((u) => (
            <li key={u.id} className="flex items-center gap-3 px-4 py-2">
              <Upload className={cn("size-3.5 flex-none", u.state === "failed" ? "text-bad" : u.state === "done" ? "text-ok" : "text-muted")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-fg-2">{u.dest}</span>
                {u.state === "failed" ? (
                  <span className="block text-bad">{u.error}</span>
                ) : (
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-line">
                    <span className="block h-full rounded-full bg-accent transition-[width]" style={{ width: `${u.size ? Math.round((u.loaded / u.size) * 100) : 100}%` }} />
                  </span>
                )}
              </span>
              <span className="flex-none text-muted tabular-nums">
                {u.state === "done" ? "Done" : u.state === "failed" ? "" : `${formatBytes(u.loaded)} / ${formatBytes(u.size)}`}
              </span>
              <button
                type="button"
                aria-label={u.state === "sending" ? `Cancel ${u.name}` : `Dismiss ${u.name}`}
                onClick={() => (u.state === "sending" ? u.xhr?.abort() : setUploads((all) => all.filter((x) => x.id !== u.id)))}
                className="rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <NameDialog
        open={!!dialog}
        onOpenChange={(o) => !o && setDialog(null)}
        title={dialog?.kind === "rename" ? `Rename ${dialog.entry.name}` : "New folder"}
        label={dialog?.kind === "rename" ? "New name" : "Folder name"}
        initial={dialog?.kind === "rename" ? dialog.entry.name : ""}
        submitLabel={dialog?.kind === "rename" ? "Rename" : "Create folder"}
        onSubmit={async (name) => {
          if (dialog?.kind === "rename") await request(endpoint, { ...extra }, { op: "move", from: joinPath(here, dialog.entry.name), to: joinPath(here, name) });
          else await request(endpoint, { ...extra }, { op: "mkdir", path: joinPath(here, name) });
          await mutate();
        }}
      />
    </div>
  );
}
