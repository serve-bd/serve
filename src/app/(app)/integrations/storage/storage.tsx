"use client";

import * as React from "react";
import { HardDriveUpload, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { addS3Destination, deleteS3Destination, testS3Destination } from "@/server/actions/integrations";

type Dest = { id: string; name: string; endpoint: string; bucket: string; region: string; pathPrefix: string };

export function StorageDestinations({ destinations, isAdmin }: { destinations: Dest[]; isAdmin: boolean }) {
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", endpoint: "", region: "auto", bucket: "", accessKeyId: "", secretAccessKey: "", pathPrefix: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const add = useAction(() => addS3Destination(form), { success: "Storage added", onSuccess: () => setOpen(false) });
  const test = useAction(testS3Destination, { success: "Connection works", refresh: false });
  const remove = useAction(deleteS3Destination, { success: "Storage removed" });

  return (
    <div className="flex flex-col gap-4">
      {isAdmin && (
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            <Plus /> Add storage
          </Button>
        </div>
      )}
      <Card className="overflow-hidden">
        {destinations.length === 0 ? (
          <EmptyState icon={<HardDriveUpload />} title="No backup storage" description="Backups stay on this server until you add off-site storage." />
        ) : (
          <div className="divide-y divide-line">
            {destinations.map((d) => (
              <div key={d.id} className="flex items-center gap-3 px-5 py-3.5">
                <span className="flex size-9 items-center justify-center rounded-[10px] border border-line bg-surface-2"><HardDriveUpload className="size-4 text-fg-2" /></span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[14px] font-medium text-fg">{d.name}</span>
                  <span className="truncate font-mono text-xs text-muted">{d.bucket}{d.pathPrefix ? `/${d.pathPrefix}` : ""} · {d.endpoint}</span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => test.run(d.id)} loading={test.pending}>
                  <Zap /> Test
                </Button>
                {isAdmin && (
                  <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={async () => { if (await confirm({ title: `Remove ${d.name}?`, description: "Files already uploaded stay in the bucket.", confirmLabel: "Remove", danger: true })) remove.run(d.id); }}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
            <DialogHeader title="Add S3-compatible storage" description="Serve checks access before saving." />
            <DialogBody>
              <Field label="Name"><Input value={form.name} onChange={set("name")} required placeholder="Cloudflare R2" /></Field>
              <Field label="Endpoint" description="For example s3.amazonaws.com, <account>.r2.cloudflarestorage.com, s3.us-west-002.backblazeb2.com">
                <Input value={form.endpoint} onChange={set("endpoint")} required placeholder="https://s3.amazonaws.com" />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Bucket"><Input value={form.bucket} onChange={set("bucket")} required /></Field>
                <Field label="Region"><Input value={form.region} onChange={set("region")} placeholder="auto" /></Field>
                <Field label="Access key ID"><Input value={form.accessKeyId} onChange={set("accessKeyId")} required autoComplete="off" /></Field>
                <Field label="Secret access key"><Input type="password" value={form.secretAccessKey} onChange={set("secretAccessKey")} required autoComplete="new-password" /></Field>
              </div>
              <Field label="Path prefix" optional><Input value={form.pathPrefix} onChange={set("pathPrefix")} placeholder="serve-backups" /></Field>
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" size="sm" loading={add.pending}>Add storage</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
