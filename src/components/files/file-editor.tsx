"use client";

import * as React from "react";
import { Download, FileWarning, Save } from "lucide-react";
import { CodeEditor } from "@/components/code-editor";
import { Button, buttonVariants } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState, Kbd, Skeleton } from "@/components/ui/misc";
import { toast } from "@/components/ui/toast";
import { request } from "./files-api";

const LANGUAGES: Record<string, "yaml" | "json" | "sql"> = { yml: "yaml", yaml: "yaml", json: "json", sql: "sql" };

const languageOf = (path: string) => LANGUAGES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "text";

type Loaded = { path: string; content: string; hash: string };

/**
 * A text file in the code editor. Save keeps what was changed on the server meanwhile: it asks
 * before overwriting it. Binary and large files offer a download instead.
 */
export function FileEditor({
  endpoint,
  extra,
  path,
  downloadUrl,
  onSaved,
  onClose,
  full,
}: {
  endpoint: string;
  extra?: Record<string, string>;
  path: string;
  downloadUrl: string;
  /** The folder's listing is out of date (size, time). */
  onSaved: () => void;
  onClose: () => void;
  full: boolean;
}) {
  const confirm = useConfirm();
  const [file, setFile] = React.useState<Loaded | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [text, setText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const dirty = !!file && text !== file.content;
  const container = extra?.container;

  React.useEffect(() => {
    let live = true;
    request<Loaded>(endpoint, { op: "read", path, ...(container ? { container } : {}) }).then(
      (f) => {
        if (!live) return;
        setFile(f);
        setText(f.content);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [endpoint, path, container]);

  // Leaving the page with unsaved changes asks first.
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = React.useCallback(
    async (overwrite = false) => {
      if (!file || saving) return;
      setSaving(true);
      try {
        const res = await request<{ hash: string }>(endpoint, { ...extra }, { op: "save", path: file.path, content: text, hash: overwrite ? "-" : file.hash });
        setFile({ ...file, content: text, hash: res.hash });
        onSaved();
      } catch (e) {
        const err = e as Error & { status?: number };
        if (err.status === 412 && !overwrite) {
          setSaving(false);
          const ok = await confirm({
            title: "The file changed on the server",
            description: `${file.path} was changed after you opened it. Saving replaces those changes with yours.`,
            confirmLabel: "Replace with mine",
            danger: true,
          });
          if (ok) return save(true);
          return;
        }
        toast.error("Could not save", err.message);
      } finally {
        setSaving(false);
      }
    },
    [file, saving, endpoint, extra, text, confirm, onSaved],
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save]);

  const close = async () => {
    if (dirty && !(await confirm({ title: "Discard your changes?", description: `Your changes to ${path} are not saved.`, confirmLabel: "Discard", danger: true }))) return;
    onClose();
  };

  if (error)
    return (
      <EmptyState
        icon={<FileWarning />}
        title="This file does not open in the editor"
        description={error}
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Back to the folder
            </Button>
            <a href={downloadUrl} download className={buttonVariants({ size: "sm" })}>
              <Download /> Download
            </a>
          </div>
        }
      />
    );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-[12.5px]">
        <span className="min-w-0 flex-1 truncate font-mono text-fg-2">
          {path}
          {dirty && <span className="ml-2 font-sans text-warn">· Not saved</span>}
        </span>
        <span className="hidden text-muted sm:inline">
          <Kbd>{typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}</Kbd> <Kbd>S</Kbd> saves
        </span>
        <Button size="xs" variant="ghost" onClick={() => void close()}>
          Close
        </Button>
        <Button size="xs" variant="primary" onClick={() => void save()} disabled={!dirty} loading={saving}>
          <Save /> Save
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        {file ? (
          <CodeEditor
            value={text}
            onChange={setText}
            language={languageOf(path)}
            height={full ? "calc(100dvh - 7.25rem)" : "calc(min(68vh, 640px) - 3.6rem)"}
            className="rounded-lg shadow-none"
            aria-label={`Contents of ${path}`}
          />
        ) : (
          <div className="flex flex-col gap-2 p-2">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className={["h-4 w-2/3", "h-4 w-1/2", "h-4 w-5/6", "h-4 w-1/3"][i % 4]} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
