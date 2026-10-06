"use client";

import * as React from "react";
import Link from "next/link";
import { Cloud, Link2, TriangleAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tab, Tabs, TabsList } from "@/components/ui/tabs";
import { useConfirm } from "@/components/ui/confirm";
import { useAction, showError } from "@/hooks/use-action";
import { importBackupFromRemote } from "@/server/actions/databases";
import { cn, formatBytes } from "@/lib/utils";

type Source = "upload" | "url" | "s3";

/** Restores a dump from a file, a URL or an S3 bucket. The upload streams straight to disk. */
export function ImportCard(props: {
  serviceId: string;
  running: boolean;
  engineLabel: string;
  /** One backup of a compose stack (db:…, volume:…, dir:…) instead of the database service. */
  target?: string | null;
  /** The dump's users can be restored too (MongoDB, and plain SQL dumps of Postgres, MySQL, MariaDB). */
  restoresUsers?: boolean;
  extensions: string[];
  maxUpload: string | null;
  destinations: { id: string; name: string; bucket: string }[];
  /** id: the import, which a database service restores next from the restore window. */
  onStarted: (id?: string) => void;
}) {
  const confirm = useConfirm();
  const [source, setSource] = React.useState<Source>("upload");
  const [file, setFile] = React.useState<File | null>(null);
  const [url, setUrl] = React.useState("");
  const [dest, setDest] = React.useState(props.destinations[0]?.id ?? "");
  const [key, setKey] = React.useState("");
  const [backupFirst, setBackupFirst] = React.useState(true);
  const [users, setUsers] = React.useState(false);
  // A database service only receives the file here; the restore window then sets what goes where.
  const twoStep = !props.target;
  const [passphrase, setPassphrase] = React.useState("");
  const [progress, setProgress] = React.useState<number | null>(null);
  const [drag, setDrag] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const remote = useAction(
    () =>
      importBackupFromRemote(
        props.serviceId,
        source === "url" ? { kind: "url", url } : { kind: "s3", destinationId: dest, key },
        backupFirst,
        users,
        passphrase || undefined,
        props.target ?? null,
        null,
        twoStep,
      ),
    {
      onSuccess: (r) => props.onStarted(r?.id),
    },
  );

  // Encrypted backups (from Serve, or openssl enc -aes-256-cbc -pbkdf2) end in .enc after the usual extension.
  const extOk = (name: string) => props.extensions.some((e) => name.toLowerCase().endsWith(e) || name.toLowerCase().endsWith(`${e}.enc`));
  const name = source === "upload" ? (file?.name ?? "") : source === "url" ? url.split("?")[0] : key;
  const encrypted = name.toLowerCase().endsWith(".enc");
  const ready =
    props.running &&
    (!encrypted || passphrase.length > 0) &&
    (source === "upload" ? !!file && extOk(file.name) : source === "url" ? /^https?:\/\/.+/i.test(url) : !!dest && !!key.trim());

  const upload = (f: File) =>
    new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        "POST",
        `/api/services/${props.serviceId}/backups/import?filename=${encodeURIComponent(f.name)}${backupFirst ? "&backupFirst=1" : ""}${users ? "&users=1" : ""}${twoStep ? "&restore=0" : ""}${props.target ? `&target=${encodeURIComponent(props.target)}` : ""}`,
      );
      if (passphrase) xhr.setRequestHeader("x-backup-passphrase", passphrase);
      xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
      xhr.onload = () => {
        setProgress(null);
        let message = "";
        try {
          message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? "";
        } catch {
          message = xhr.status === 413 ? `The file is larger than the dashboard proxy allows${props.maxUpload ? ` (${props.maxUpload})` : ""}.` : "";
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          setFile(null);
          let id: string | undefined;
          try {
            id = (JSON.parse(xhr.responseText) as { id?: string }).id;
          } catch {}
          props.onStarted(id);
        } else showError(message || `Upload failed (HTTP ${xhr.status}).`);
        resolve();
      };
      xhr.onerror = () => {
        setProgress(null);
        showError("The upload was interrupted.");
        resolve();
      };
      xhr.send(f);
    });

  const start = async () => {
    // Nothing is replaced yet: the restore window comes next.
    const ok =
      twoStep ||
      (await confirm({
        title: `Import into ${props.engineLabel}?`,
        description: backupFirst
          ? "The current data is backed up first, then replaced with the imported dump."
          : "The current data is replaced with the imported dump. There is no safety backup.",
        confirmLabel: "Import and restore",
        danger: true,
      }));
    if (!ok) return;
    if (source === "upload" && file) await upload(file);
    else await remote.run();
  };

  return (
    <Card>
      <CardHeader title="Import backup" description={`A dump made elsewhere: ${props.extensions.join(", ")}.`} />
      <CardBody className="flex flex-col gap-4 py-5">
        <Tabs value={source} onValueChange={(v) => setSource(v as Source)}>
          <TabsList>
            <Tab value="upload">
              <Upload /> Upload
            </Tab>
            <Tab value="url">
              <Link2 /> From URL
            </Tab>
            <Tab value="s3">
              <Cloud /> From bucket
            </Tab>
          </TabsList>
        </Tabs>

        {source === "upload" && (
          <>
            <button
              type="button"
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files[0];
                if (f) setFile(f);
              }}
              className={cn(
                "flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-8 text-center transition-colors",
                drag ? "border-accent bg-accent-soft/40" : "border-line-strong hover:bg-hover",
              )}
            >
              <Upload className="size-5 text-muted" />
              {file ? (
                <>
                  <span className="max-w-full truncate font-mono text-[13px] text-fg">{file.name}</span>
                  <span className="text-xs text-muted">{formatBytes(file.size)} · click to choose another file</span>
                </>
              ) : (
                <>
                  <span className="text-[13px] font-medium text-fg-2">Drop a dump here or click to choose</span>
                  <span className="text-xs text-muted">Up to 20 GB{props.maxUpload ? `; through the dashboard domain the proxy allows ${props.maxUpload}` : ""}.</span>
                </>
              )}
            </button>
            <input
              ref={input}
              type="file"
              className="hidden"
              accept={[...props.extensions, ...props.extensions.map((e) => `${e}.enc`)].join(",")}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file && !extOk(file.name) && <p className="text-xs text-bad">Choose a {props.extensions.join(", ")} file.</p>}
            {progress !== null && (
              <div className="flex flex-col gap-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
                <span className="text-xs text-muted tabular-nums">Uploading {Math.round(progress * 100)}%</span>
              </div>
            )}
          </>
        )}
        {source === "url" && (
          <Field label="File URL" description={<>A public or pre-signed http(s) link. The server downloads it.</>}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/backups/app.dump" className="font-mono text-[13px]" />
          </Field>
        )}
        {source === "s3" && !props.destinations.length && (
          <p className="text-[13px] text-muted">
            No S3 storage yet. Add one in{" "}
            <Link href="/integrations/storage" className="text-accent hover:underline">
              S3 storage
            </Link>{" "}
            to import a backup from a bucket.
          </p>
        )}
        {source === "s3" && props.destinations.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
            <Field label="Storage">
              <Select value={dest} onValueChange={setDest} options={props.destinations.map((d) => ({ value: d.id, label: d.name, description: d.bucket }))} />
            </Field>
            <Field label="Object path" description="The full key inside the bucket.">
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="serve/app/app-2026-09-01.dump" className="font-mono text-[13px]" />
            </Field>
          </div>
        )}

        {!twoStep && (
          <label className="flex items-start gap-2 text-[13px] text-fg-2">
            <Checkbox checked={backupFirst} onCheckedChange={(c) => setBackupFirst(!!c)} className="mt-0.5" />
            <span>
              Back up the current data first
              <span className="block text-xs text-muted">Recommended. The restore stops if this backup fails.</span>
            </span>
          </label>
        )}
        {encrypted && (
          <Field label="Backup passphrase" description="This file is encrypted. Enter the passphrase it was made with.">
            <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
        )}
        {!twoStep && props.restoresUsers && (
          <label className="flex items-start gap-2 text-[13px] text-fg-2">
            <Checkbox checked={users} onCheckedChange={(c) => setUsers(!!c)} className="mt-0.5" />
            <span>
              Also restore the dump&apos;s users and passwords
              <span className="mt-0.5 flex items-start gap-1 text-xs text-warn">
                <TriangleAlert className="mt-px size-3.5 flex-none" /> Only when moving a whole server. The old server&apos;s accounts come back with their passwords and rights,
                and anyone who had them can sign in to this database.
              </span>
              <span className="block text-xs text-muted">Serve&apos;s own accounts keep their passwords. Leave this off when you only want the data.</span>
            </span>
          </label>
        )}
        {!props.running && (
          <p className="flex items-start gap-1.5 text-xs text-warn">
            <TriangleAlert className="mt-px size-3.5 flex-none" /> Start the database to import.
          </p>
        )}
      </CardBody>
      <CardFooter>
        <span className="truncate text-xs text-muted">{twoStep ? "Next, choose what to restore and where." : "Existing data is overwritten."}</span>
        <Button size="sm" variant={twoStep ? "primary" : "danger"} disabled={!ready || progress !== null} loading={remote.pending || progress !== null} onClick={start}>
          {twoStep ? "Import" : "Import and restore"}
        </Button>
      </CardFooter>
    </Card>
  );
}
