"use client";

import * as React from "react";
import Link from "next/link";
import { MoreHorizontal, Pencil, Plus, RefreshCw, Rocket, Tag as TagIcon, Trash2, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Card, CardHeader, CopyField, EmptyState } from "@/components/ui/misc";
import { StatusDot } from "@/components/ui/status";
import { useAction } from "@/hooks/use-action";
import { createTag, deleteTag, deployTagAction, rotateTagHook, updateTag } from "@/server/actions/tags";
import { TAG_COLOR_NAMES, tagColorClass } from "@/lib/tags";
import { cn } from "@/lib/utils";

type TagRow = {
  id: string;
  name: string;
  color: string;
  hook: string | null;
  services: { id: string; name: string; type: string; status: string; projectId: string; project: string; environment: string }[];
};

export function TagChip({ name, color, className }: { name: string; color: string; className?: string }) {
  return <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium ring-1", tagColorClass(color), className)}>{name}</span>;
}

export function TagsView({ tags, canManage, canDeploy }: { tags: TagRow[]; canManage: boolean; canDeploy: boolean }) {
  const [editing, setEditing] = React.useState<TagRow | "new" | null>(null);
  // By id: after a new URL the page refreshes, and the dialog shows the new one.
  const [hookOf, setHookOf] = React.useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
            <Plus /> New tag
          </Button>
        </div>
      )}
      {tags.length === 0 ? (
        <Card>
          <EmptyState
            icon={<TagIcon />}
            title="No tags yet"
            description="Tag services in their Settings → General, or create a tag here. Then redeploy everything with a tag at once."
          />
        </Card>
      ) : (
        tags.map((t) => <TagCard key={t.id} tag={t} canManage={canManage} canDeploy={canDeploy} onEdit={() => setEditing(t)} onHook={() => setHookOf(t.id)} />)
      )}
      <EditTagDialog tag={editing} onClose={() => setEditing(null)} />
      <HookDialog tag={tags.find((t) => t.id === hookOf) ?? null} onClose={() => setHookOf(null)} />
    </div>
  );
}

function TagCard({ tag, canManage, canDeploy, onEdit, onHook }: { tag: TagRow; canManage: boolean; canDeploy: boolean; onEdit: () => void; onHook: () => void }) {
  const confirm = useConfirm();
  const deploy = useAction(() => deployTagAction(tag.id), {
    result: (r) =>
      `${r.queued.length ? `Deploying ${r.queued.length} service${r.queued.length === 1 ? "" : "s"}` : "Nothing to deploy"}${r.skipped.length ? `. Skipped: ${r.skipped.map((s) => `${s.service} (${s.reason})`).join(", ")}` : ""}`,
  });
  const remove = useAction(() => deleteTag(tag.id));
  const count = tag.services.length;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <TagChip name={tag.name} color={tag.color} />
            <span className="text-xs font-normal text-muted">
              {count} service{count === 1 ? "" : "s"}
            </span>
          </span>
        }
        actions={
          <div className="flex items-center gap-1.5">
            {canDeploy && (
              <Button
                size="sm"
                disabled={!count}
                loading={deploy.pending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Deploy everything tagged ${tag.name}?`,
                      description: `${count} service${count === 1 ? "" : "s"} deploy now. Project rules still apply: a freeze skips a deploy, an approval holds it.`,
                      confirmLabel: "Deploy all",
                    })
                  )
                    void deploy.run();
                }}
              >
                <Rocket /> Deploy all
              </Button>
            )}
            {canManage && (
              <Menu>
                <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Options for ${tag.name}`} />}>
                  <MoreHorizontal />
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onClick={onEdit}>
                    <Pencil /> Rename or recolor
                  </MenuItem>
                  <MenuItem onClick={onHook}>
                    <Webhook /> Deploy hook
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    danger
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Delete the tag ${tag.name}?`,
                          description: "It is taken off every service. The services stay, and its deploy hook stops working.",
                          confirmLabel: "Delete tag",
                          danger: true,
                        })
                      )
                        void remove.run();
                    }}
                  >
                    <Trash2 /> Delete
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
          </div>
        }
      />
      {count === 0 ? (
        <p className="border-t border-line px-5 py-3 text-[13px] text-muted">No service has this tag yet. Add it in a service&apos;s Settings → General.</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {tag.services.map((s) => (
            <li key={s.id} className="flex min-w-0 items-center gap-2.5 px-5 py-2.5">
              <StatusDot status={s.status} kind="service" />
              <Link href={`/projects/${s.projectId}/services/${s.id}`} className="min-w-0 truncate text-[13px] font-medium text-fg hover:underline">
                {s.name}
              </Link>
              <span className="min-w-0 truncate text-xs text-muted">
                {s.project} · {s.environment}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function EditTagDialog({ tag, onClose }: { tag: TagRow | "new" | null; onClose: () => void }) {
  const isNew = tag === "new";
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState("gray");
  React.useEffect(() => {
    if (!tag) return;
    setName(tag === "new" ? "" : tag.name);
    setColor(tag === "new" ? "gray" : tag.color);
  }, [tag]);
  const save = useAction(() => (isNew ? createTag({ name, color }) : updateTag((tag as TagRow).id, { name, color })), { onSuccess: onClose });

  return (
    <Dialog open={!!tag} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void save.run();
          }}
        >
          <DialogHeader title={isNew ? "New tag" : "Edit tag"} />
          <DialogBody>
            <Field label="Name" description="Letters, numbers, dots, dashes and underscores.">
              <Input value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, "-"))} placeholder="production" autoFocus />
            </Field>
            <Field label="Color">
              <div className="flex flex-wrap gap-2">
                {TAG_COLOR_NAMES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={c === color}
                    onClick={() => setColor(c)}
                    className={cn("rounded-full", c === color && "ring-2 ring-accent ring-offset-2 ring-offset-surface")}
                  >
                    <TagChip name={name.trim() || c} color={c} />
                  </button>
                ))}
              </div>
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={save.pending} disabled={!name.trim()}>
              {isNew ? "Create tag" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HookDialog({ tag, onClose }: { tag: TagRow | null; onClose: () => void }) {
  const confirm = useConfirm();
  const rotate = useAction(() => rotateTagHook(tag!.id));
  return (
    <Dialog open={!!tag} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader
          title={`Deploy hook of ${tag?.name ?? ""}`}
          description="A GET or POST to this URL deploys every service with the tag, for example as the last step of CI. Keep it secret: it needs no login."
        />
        <DialogBody>
          {tag?.hook && <CopyField value={tag.hook} secret />}
          <p className="text-xs leading-relaxed text-muted">
            Also works with the token in an x-deploy-token header instead of the URL. Each deploy follows its project&apos;s rules.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            loading={rotate.pending}
            onClick={async () => {
              if (
                await confirm({
                  title: "Make a new hook URL?",
                  description: "The current URL stops working right away. Update it wherever it is used.",
                  confirmLabel: "New URL",
                })
              )
                void rotate.run();
            }}
          >
            <RefreshCw /> New URL
          </Button>
          <DialogClose render={<Button variant="primary" size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
