"use client";

import * as React from "react";
import Link from "next/link";
import { GitBranch, Loader2, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Card, CardHeader, CopyButton, EmptyState, TimeAgo } from "@/components/ui/misc";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { branchReference } from "@/lib/database-branches";
import { formatBytes } from "@/lib/utils";
import { createDatabaseBranch, deleteDatabaseBranch, resetDatabaseBranch } from "@/server/actions/database-branches";

type Branch = {
  id: string;
  name: string;
  database: string;
  status: "creating" | "ready" | "resetting" | "failed" | "deleting";
  error: string | null;
  sizeBytes: number | null;
  copiedAt: string | null;
  createdAt: string;
  preview: { id: string; pr: number | null } | null;
};

const busyLabel: Partial<Record<Branch["status"], string>> = { creating: "Copying data…", resetting: "Copying data again…", deleting: "Deleting…" };

export function BranchesView({
  serviceId,
  serviceName,
  refName,
  running,
  canManage,
  branches,
  projectId,
}: {
  serviceId: string;
  serviceName: string;
  refName: string;
  running: boolean;
  canManage: boolean;
  branches: Branch[];
  projectId: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [creating, setCreating] = React.useState(false);
  const reset = useAction(resetDatabaseBranch, { success: "Copying the data again" });
  const remove = useAction(deleteDatabaseBranch, { success: "Branch deleted" });

  // The worker updates branches; refresh while one of them is busy.
  const busy = branches.some((b) => busyLabel[b.status]);
  React.useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [busy, router]);

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader
          title="Branches"
          description={`Copies of ${serviceName}'s data, inside the same database server. Each branch has its own login, so a branch cannot change the main data.`}
          actions={
            canManage && (
              <Button size="sm" variant="primary" disabled={!running} title={running ? undefined : "Start the database to branch it"} onClick={() => setCreating(true)}>
                <Plus /> New branch
              </Button>
            )
          }
        />
        {branches.length === 0 ? (
          <EmptyState
            icon={<GitBranch />}
            title="No branches yet"
            description="A branch is a full copy of the data you can change freely: test a migration, debug with real data, or give a pull request preview its own database."
          />
        ) : (
          <ul className="divide-y divide-line">
            {branches.map((b) => {
              const ref = branchReference(refName, b.name);
              const label = busyLabel[b.status];
              return (
                <li key={b.id} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
                  <GitBranch className="mt-1 size-4 flex-none text-muted" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="truncate text-[14px] font-medium text-fg">{b.name}</span>
                      {b.preview && (
                        <Link href={`/projects/${projectId}/services/${b.preview.id}`} className="text-xs text-muted hover:text-fg">
                          for PR #{b.preview.pr}
                        </Link>
                      )}
                    </span>
                    {label ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        <Loader2 className="size-3 animate-spin" /> {label}
                      </span>
                    ) : b.status === "failed" ? (
                      <p className="text-xs leading-relaxed whitespace-pre-wrap text-bad">{b.error ?? "The copy failed."}</p>
                    ) : (
                      <span className="flex min-w-0 items-center gap-1">
                        <code className="min-w-0 truncate font-mono text-[12px] text-fg-2">{ref}</code>
                        <CopyButton value={ref} label="Copy the reference" className="size-6 flex-none" />
                      </span>
                    )}
                    <span className="text-xs text-muted">
                      {b.sizeBytes !== null && <>{formatBytes(b.sizeBytes)} · </>}
                      {b.copiedAt ? (
                        <>
                          Data from <TimeAgo date={b.copiedAt} />
                        </>
                      ) : (
                        <>
                          Created <TimeAgo date={b.createdAt} />
                        </>
                      )}
                    </span>
                  </div>
                  {canManage && !label && (
                    <Menu>
                      <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${b.name}`} />}>
                        <MoreHorizontal />
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem
                          disabled={!running}
                          onClick={async () => {
                            if (
                              await confirm({
                                title: `Reset ${b.name}?`,
                                description: `Its data is replaced with a fresh copy of ${serviceName}. Changes made in the branch are lost.`,
                                confirmLabel: "Reset branch",
                                danger: true,
                              })
                            )
                              reset.run(b.id);
                          }}
                        >
                          <RotateCcw /> Reset to the main data
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          danger
                          onClick={async () => {
                            if (
                              await confirm({
                                title: `Delete ${b.name}?`,
                                description: "The branch's database and login are removed. Services that reference it lose their connection.",
                                confirmLabel: "Delete branch",
                                danger: true,
                              })
                            )
                              remove.run(b.id);
                          }}
                        >
                          <Trash2 /> Delete
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <p className="px-1 text-xs leading-relaxed text-muted">
        Use a branch from any service in this environment with a reference like <span className="font-mono text-fg-2">{branchReference(refName, "<name>")}</span>. Pull request
        previews can get a branch each: turn it on in the app&apos;s Settings → Previews. Each branch uses about as much disk as the main database.
      </p>
      {creating && <NewBranchDialog serviceId={serviceId} serviceName={serviceName} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewBranchDialog({ serviceId, serviceName, onClose }: { serviceId: string; serviceName: string; onClose: () => void }) {
  const [name, setName] = React.useState("");
  const create = useAction(() => createDatabaseBranch(serviceId, name), { success: "Branch started. Copying the data…", onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create.run();
          }}
        >
          <DialogHeader title="New branch" description={`A copy of ${serviceName}'s data as it is now. The main database keeps running while it copies.`} />
          <DialogBody>
            <Field label="Name" description="Lowercase letters, digits and dashes.">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                placeholder="feature-login"
                maxLength={30}
                required
                autoFocus
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.pending} disabled={!name}>
              Create branch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
