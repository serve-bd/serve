"use client";

import * as React from "react";
import Link from "next/link";
import { Copy, LayoutTemplate, Pencil, Plus, Search, ShieldAlert, Trash2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Card, EmptyState, TimeAgo } from "@/components/ui/misc";
import { useConfirm } from "@/components/ui/confirm";
import { TemplateLogo } from "@/components/template-logo";
import { useAction } from "@/hooks/use-action";
import { deleteCustomTemplate } from "@/server/actions/templates";
import { cn } from "@/lib/utils";

type Custom = { id: string; name: string; description: string; category: string; iconUrl: string | null; services: number; updatedAt: string; author: string | null };
type BuiltIn = { id: string; name: string; description: string; category: string; hostAccess: boolean; website: string };

export function TemplatesView({ canManage, custom, builtIn }: { canManage: boolean; custom: Custom[]; builtIn: BuiltIn[] }) {
  const [tab, setTab] = React.useState<"custom" | "builtin">(custom.length || canManage ? "custom" : "builtin");
  const [query, setQuery] = React.useState("");
  const confirm = useConfirm();
  const remove = useAction(deleteCustomTemplate, { success: "Template deleted" });
  const q = query.trim().toLowerCase();
  const match = (t: { name: string; description: string; category: string }) => !q || `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1 sm:w-80">
          {(
            [
              ["custom", `Your templates (${custom.length})`],
              ["builtin", `Built-in (${builtIn.length})`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn("h-8 rounded-lg text-[13px] font-medium transition-all", tab === id ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:w-60 sm:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates" className="pl-8" aria-label="Search templates" />
          </div>
          {canManage && (
            <Link href="/templates/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
              <Plus /> New template
            </Link>
          )}
        </div>
      </div>

      {tab === "custom" ? (
        custom.length ? (
          <Card>
            <div className="divide-y divide-line">
              {custom.filter(match).map((t) => (
                <div key={t.id} className="flex items-center gap-3.5 px-5 py-3.5">
                  <TemplateLogo id={t.id} name={t.name} iconUrl={t.iconUrl} custom />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-fg">{t.name}</span>
                      <Badge>{t.category}</Badge>
                    </div>
                    <p className="truncate text-[12.5px] text-muted">
                      {t.description || `${t.services} service${t.services === 1 ? "" : "s"}`}
                      <span className="text-faint">
                        {" "}
                        · Updated <TimeAgo date={t.updatedAt} />
                        {t.author ? ` by ${t.author}` : ""}
                      </span>
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex flex-none items-center gap-1">
                      <Link href={`/templates/${t.id}`} className={buttonVariants({ size: "sm", variant: "ghost" })} aria-label={`Edit ${t.name}`}>
                        <Pencil /> <span className="hidden sm:inline">Edit</span>
                      </Link>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete ${t.name}`}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Delete ${t.name}?`,
                              description: "Services already created from it keep running. It disappears from the catalog.",
                              confirmLabel: "Delete template",
                              danger: true,
                            })
                          )
                            remove.run(t.id);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <Card>
            <EmptyState
              icon={<LayoutTemplate />}
              title="No templates yet"
              description={
                canManage
                  ? "Save a compose file as a template and it shows up in every project's New service catalog. Start from scratch, import a URL or duplicate a built-in one."
                  : "Admins of this organization can add templates."
              }
              action={
                canManage && (
                  <Link href="/templates/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
                    <Plus /> New template
                  </Link>
                )
              }
            />
          </Card>
        )
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {builtIn.filter(match).map((t) => (
            <div key={t.id} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-sm">
              <TemplateLogo id={t.id} name={t.name} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[14px] font-medium text-fg">{t.name}</span>
                  {t.hostAccess && <ShieldAlert className="size-3.5 flex-none text-warn" aria-label="Needs host access" />}
                </div>
                <p className="line-clamp-2 text-[12.5px] leading-snug text-muted">{t.description}</p>
                <p className="mt-1 text-[11px] text-faint">{t.category}</p>
              </div>
              {canManage && (
                <Link href={`/templates/new?from=${t.id}`} className={buttonVariants({ size: "sm", variant: "ghost", className: "flex-none" })} title="Duplicate to edit">
                  <Copy /> <span className="sr-only">Duplicate {t.name}</span>
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
