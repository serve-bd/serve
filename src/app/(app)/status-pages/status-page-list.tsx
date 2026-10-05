"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge, Card } from "@/components/ui/misc";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { createStatusPage } from "@/server/actions/status-pages";
import { LEVEL_TEXT, slugify, type StatusLevel, type StatusVisibility } from "@/lib/status-page";
import { levelDot, visibilityBadge } from "./badges";
import { cn } from "@/lib/utils";

type Row = {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  visibility: StatusVisibility;
  url: string;
  components: number;
  openIncidents: number;
  overall: StatusLevel;
};

export function NewStatusPageButton() {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const router = useRouter();
  const create = useAction(() => createStatusPage({ name }), { refresh: false, onSuccess: (r) => router.push(`/status-pages/${r.id}`) });
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        <Plus /> New status page
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create.run();
            }}
          >
            <DialogHeader title="New status page" description="It starts as a draft. Publish it when it looks right." />
            <DialogBody>
              <Field label="Name" description={name.trim() ? `Address: /status/${slugify(name) || "status"}` : "Visitors see this at the top, like Acme or Acme Cloud."}>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" autoFocus maxLength={80} />
              </Field>
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" loading={create.pending} disabled={!name.trim()}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function StatusPageList({ pages, canManage }: { pages: Row[]; canManage: boolean }) {
  return (
    <Card className="divide-y divide-line overflow-hidden">
      {pages.map((p) => (
        <div key={p.id} className="relative flex items-center gap-4 px-5 py-4 transition-colors hover:bg-hover/40">
          <span className={cn("size-2.5 flex-none rounded-full", levelDot[p.overall])} title={LEVEL_TEXT[p.overall]} />
          <Link href={`/status-pages/${p.id}`} className="min-w-0 flex-1 after:absolute after:inset-0">
            <p className="truncate text-[14px] font-semibold text-fg">{p.name}</p>
            <p className="truncate text-xs text-muted">
              {p.domain ?? `/status/${p.slug}`} · {p.components} component{p.components === 1 ? "" : "s"}
              {p.openIncidents > 0 && (
                <span className="text-bad">
                  {" "}
                  · {p.openIncidents} open incident{p.openIncidents === 1 ? "" : "s"}
                </span>
              )}
            </p>
          </Link>
          <Badge tone={visibilityBadge[p.visibility].tone}>{visibilityBadge[p.visibility].label}</Badge>
          {p.visibility !== "draft" || canManage ? (
            <a
              href={p.url}
              target="_blank"
              rel="noopener"
              className="relative z-10 rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"
              aria-label={`Open ${p.name}`}
            >
              <ExternalLink className="size-4" />
            </a>
          ) : null}
        </div>
      ))}
    </Card>
  );
}
