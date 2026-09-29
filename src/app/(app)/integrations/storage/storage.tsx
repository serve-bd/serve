"use client";

import * as React from "react";
import Link from "next/link";
import { Database, HardDriveUpload, MoreHorizontal, Pencil, Plus, Trash2, Zap } from "lucide-react";
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
import { formatBytes } from "@/lib/utils";
import { addS3Destination, deleteS3Destination, testS3Destination, updateS3Destination } from "@/server/actions/integrations";

export type Dest = {
  id: string;
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  pathPrefix: string;
  /** Masked. */
  accessKeyId: string;
  createdAt: string;
  databases: { id: string; name: string; projectId: string }[];
  backups: number;
  bytes: number;
  lastUpload: string | null;
};

type Provider = { id: string; label: string; color: string; endpoint: string; region: string; hint: string; match: RegExp };

const providers: Provider[] = [
  { id: "r2", label: "Cloudflare R2", color: "#f38020", endpoint: "https://<account-id>.r2.cloudflarestorage.com", region: "auto", hint: "R2 → Manage API tokens. Use the S3 endpoint of your account.", match: /r2\.cloudflarestorage\.com/ },
  { id: "aws", label: "Amazon S3", color: "#ff9900", endpoint: "https://s3.<region>.amazonaws.com", region: "us-east-1", hint: "IAM user with s3:PutObject, GetObject, ListBucket and DeleteObject.", match: /amazonaws\.com/ },
  { id: "b2", label: "Backblaze B2", color: "#e21e29", endpoint: "https://s3.<region>.backblazeb2.com", region: "us-west-002", hint: "App keys → Add a new application key with access to the bucket.", match: /backblazeb2\.com/ },
  { id: "spaces", label: "DigitalOcean Spaces", color: "#0080ff", endpoint: "https://<region>.digitaloceanspaces.com", region: "nyc3", hint: "API → Spaces keys.", match: /digitaloceanspaces\.com/ },
  { id: "wasabi", label: "Wasabi", color: "#01cd3e", endpoint: "https://s3.<region>.wasabisys.com", region: "us-east-1", hint: "Access keys → Create new access key.", match: /wasabisys\.com/ },
  { id: "minio", label: "MinIO", color: "#c72c48", endpoint: "https://minio.example.com", region: "us-east-1", hint: "Any MinIO server reachable from this server.", match: /minio/i },
  { id: "other", label: "Other S3-compatible", color: "#8e8e93", endpoint: "https://s3.example.com", region: "auto", hint: "Any service that speaks the S3 API.", match: /$^/ },
];

const providerFor = (endpoint: string) => providers.find((p) => p.match.test(endpoint)) ?? providers[providers.length - 1];
const host = (endpoint: string) => endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");

function ProviderMark({ provider, size = "md" }: { provider: Provider; size?: "md" | "sm" }) {
  return (
    <span
      className={size === "md" ? "flex size-10 flex-none items-center justify-center rounded-xl text-white" : "flex size-5 flex-none items-center justify-center rounded-md text-white"}
      style={{ background: provider.color }}
      aria-hidden
    >
      <HardDriveUpload className={size === "md" ? "size-[18px]" : "size-3"} />
    </span>
  );
}

const empty = { name: "", endpoint: "", region: "auto", bucket: "", accessKeyId: "", secretAccessKey: "", pathPrefix: "" };

export function StorageDestinations({ destinations, isAdmin }: { destinations: Dest[]; isAdmin: boolean }) {
  const confirm = useConfirm();
  // null = closed, "new" = add, otherwise the destination being edited.
  const [editing, setEditing] = React.useState<Dest | "new" | null>(null);
  const [testing, setTesting] = React.useState<string | null>(null);
  const test = useAction(testS3Destination, { success: "Connection works", refresh: false });
  const remove = useAction(deleteS3Destination, { success: "Storage removed" });

  return (
    <>
      <PageHeader
        title="S3 storage"
        description="Off-site storage for database backups: AWS S3, Cloudflare R2, Backblaze B2, MinIO or any S3-compatible service."
        actions={
          isAdmin && (
            <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
              <Plus /> Add storage
            </Button>
          )
        }
      />
      <PageBody>
        {destinations.length === 0 ? (
          <Card>
            <EmptyState
              icon={<HardDriveUpload />}
              title="No backup storage yet"
              description="Backups stay on the server until you add off-site storage. Then pick it in a database's Backups tab."
              action={
                isAdmin && (
                  <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
                    <Plus /> Add storage
                  </Button>
                )
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {destinations.map((d) => {
              const provider = providerFor(d.endpoint);
              return (
                <Card key={d.id} className="flex flex-col">
                  <div className="flex items-start gap-3.5 p-5">
                    <ProviderMark provider={provider} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <h3 className="truncate text-[15px] font-semibold text-fg">{d.name}</h3>
                        <Badge>{provider.label}</Badge>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted" title={d.endpoint}>
                        {host(d.endpoint)}
                      </p>
                    </div>
                    <div className="flex flex-none items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={async () => {
                          setTesting(d.id);
                          await test.run(d.id);
                          setTesting(null);
                        }} loading={testing === d.id}>
                        <Zap /> Test
                      </Button>
                      {isAdmin && (
                        <Menu>
                          <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More actions" />}>
                            <MoreHorizontal />
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem onClick={() => setEditing(d)}>
                              <Pencil /> Edit
                            </MenuItem>
                            <MenuSeparator />
                            <MenuItem
                              danger
                              onClick={async () => {
                                const used = d.databases.length;
                                if (
                                  await confirm({
                                    title: `Remove ${d.name}?`,
                                    description: used
                                      ? `${used} database${used === 1 ? "" : "s"} back up here. They keep backing up on the server only. Files already uploaded stay in the bucket.`
                                      : "Files already uploaded stay in the bucket.",
                                    confirmLabel: "Remove storage",
                                    danger: true,
                                  })
                                )
                                  remove.run(d.id);
                              }}
                            >
                              <Trash2 /> Remove
                            </MenuItem>
                          </MenuContent>
                        </Menu>
                      )}
                    </div>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line px-5 py-4 text-[13px] sm:grid-cols-4">
                    <div className="min-w-0">
                      <dt className="text-xs text-faint">Bucket</dt>
                      <dd className="truncate font-mono text-[12px] text-fg-2" title={`${d.bucket}${d.pathPrefix ? `/${d.pathPrefix}` : ""}`}>
                        {d.bucket}
                        {d.pathPrefix && <span className="text-muted">/{d.pathPrefix}</span>}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-faint">Region</dt>
                      <dd className="truncate text-fg-2">{d.region || "auto"}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-faint">Uploaded</dt>
                      <dd className="truncate text-fg-2 tabular-nums">
                        {d.backups ? `${d.backups} · ${formatBytes(d.bytes)}` : "Nothing yet"}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-faint">Last upload</dt>
                      <dd className="truncate text-fg-2">{d.lastUpload ? <TimeAgo date={d.lastUpload} /> : "—"}</dd>
                    </div>
                  </dl>

                  <div className="mt-auto flex min-w-0 flex-wrap items-center gap-1.5 border-t border-line px-5 py-3 text-xs text-muted">
                    <Database className="size-3.5 flex-none text-faint" />
                    {d.databases.length ? (
                      <>
                        <span className="mr-0.5">Used by</span>
                        {d.databases.map((db) => (
                          <Link
                            key={db.id}
                            href={`/projects/${db.projectId}/services/${db.id}/backups`}
                            className="rounded-md bg-surface-2 px-1.5 py-0.5 text-fg-2 transition-colors hover:text-fg"
                          >
                            {db.name}
                          </Link>
                        ))}
                      </>
                    ) : (
                      <span>Not used yet. Choose it in a database&apos;s Backups tab.</span>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </PageBody>
      {editing && <DestinationDialog key={editing === "new" ? "new" : editing.id} destination={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function DestinationDialog({ destination, onClose }: { destination: Dest | null; onClose: () => void }) {
  const [provider, setProvider] = React.useState(destination ? providerFor(destination.endpoint) : providers[0]);
  const [form, setForm] = React.useState(
    destination
      ? { name: destination.name, endpoint: destination.endpoint, region: destination.region, bucket: destination.bucket, accessKeyId: "", secretAccessKey: "", pathPrefix: destination.pathPrefix }
      : { ...empty, region: providers[0].region },
  );
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useAction(
    () =>
      destination
        ? updateS3Destination(destination.id, { ...form, accessKeyId: form.accessKeyId || undefined, secretAccessKey: form.secretAccessKey || undefined })
        : addS3Destination(form),
    { success: destination ? "Storage updated" : "Storage added", onSuccess: onClose },
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
        >
          <DialogHeader
            title={destination ? `Edit ${destination.name}` : "Add S3-compatible storage"}
            description="Serve checks it can write to the bucket before saving."
          />
          <DialogBody>
            <Field label="Provider" description={provider.hint}>
              <Select
                value={provider.id}
                onValueChange={(id) => {
                  const p = providers.find((x) => x.id === id)!;
                  setProvider(p);
                  setForm((f) => ({ ...f, region: f.region && f.region !== provider.region ? f.region : p.region, name: f.name || p.label }));
                }}
                options={providers.map((p) => ({ value: p.id, label: p.label }))}
              />
            </Field>
            <Field label="Name">
              <Input value={form.name} onChange={set("name")} required placeholder={provider.label} />
            </Field>
            <Field label="Endpoint">
              <Input value={form.endpoint} onChange={set("endpoint")} required placeholder={provider.endpoint} className="font-mono text-[13px]" />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Bucket">
                <Input value={form.bucket} onChange={set("bucket")} required placeholder="serve-backups" />
              </Field>
              <Field label="Region">
                <Input value={form.region} onChange={set("region")} placeholder={provider.region} />
              </Field>
              <Field label="Access key ID" description={destination ? `Stored: ${destination.accessKeyId}. Leave empty to keep.` : undefined}>
                <Input value={form.accessKeyId} onChange={set("accessKeyId")} required={!destination} autoComplete="off" />
              </Field>
              <Field label="Secret access key" description={destination ? "Leave empty to keep the stored secret." : undefined}>
                <Input type="password" value={form.secretAccessKey} onChange={set("secretAccessKey")} required={!destination} autoComplete="new-password" />
              </Field>
            </div>
            <Field label="Path prefix" optional description="Folder inside the bucket. Useful when several Serve instances share one bucket.">
              <Input value={form.pathPrefix} onChange={set("pathPrefix")} placeholder="serve" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={save.pending}>
              {destination ? "Save changes" : "Add storage"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
