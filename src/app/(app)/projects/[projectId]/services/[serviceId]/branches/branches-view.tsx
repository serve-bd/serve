"use client";

import * as React from "react";
import Link from "next/link";
import { EyeOff, GitBranch, Loader2, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Badge, Card, CardBody, CardHeader, CopyButton, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Checkbox } from "@/components/ui/checkbox";
import { CodeEditor } from "@/components/code-editor";
import { ViewToggle } from "@/components/view-toggle";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { branchReference } from "@/lib/database-branches";
import { cn, formatBytes } from "@/lib/utils";
import { createDatabaseBranch, deleteDatabaseBranch, resetDatabaseBranch, saveBranchCleanupSql } from "@/server/actions/database-branches";
import { BranchDiagram, type DiagramBranch } from "./branch-diagram";

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
  scrubbed: boolean;
  consumers: DiagramBranch["consumers"];
};

const busyLabel: Partial<Record<Branch["status"], string>> = { creating: "Copying data…", resetting: "Copying data again…", deleting: "Deleting…" };

export function BranchesView({
  serviceId,
  serviceName,
  engine,
  refName,
  running,
  canManage,
  branches,
  projectId,
  cleanupSql,
  scrubSupported,
}: {
  serviceId: string;
  serviceName: string;
  engine: string;
  refName: string;
  status: string;
  cleanupSql: string;
  scrubSupported: boolean;
  running: boolean;
  canManage: boolean;
  branches: Branch[];
  projectId: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [creating, setCreating] = React.useState(false);
  const [view, setView] = React.useState<"canvas" | "list">("canvas");
  const reset = useAction(resetDatabaseBranch, { success: "Copying the data again" });
  const remove = useAction(deleteDatabaseBranch, { success: "Branch deleted" });

  const keyValue = engine === "redis" || engine === "valkey";
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
          description={
            keyValue
              ? `Copies of ${serviceName}'s keys in database numbers 1 to 15 of the same server. Redis has no logins per database, so a branch uses the main password: an app given a branch could still switch to the main data.`
              : `Copies of ${serviceName}'s data, inside the same database server. Each branch has its own login, so a branch cannot change the main data.`
          }
          actions={
            <div className="flex items-center gap-2">
              {branches.length > 0 && <ViewToggle view={view} views={["canvas", "list"]} onChange={setView} />}
              {canManage && (
                <Button size="sm" variant="primary" disabled={!running} title={running ? undefined : "Start the database to branch it"} onClick={() => setCreating(true)}>
                  <Plus /> New branch
                </Button>
              )}
            </div>
          }
        />
        {branches.length > 0 && view === "canvas" ? (
          <div className="border-t border-line py-2">
            <BranchDiagram projectId={projectId} serviceName={serviceName} engineLabel={engineLabel(engine)} running={running} branches={branches} />
          </div>
        ) : branches.length === 0 ? (
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
                      {keyValue && <span className="text-xs text-muted">database {b.database}</span>}
                      {b.preview && (
                        <Link href={`/projects/${projectId}/services/${b.preview.id}`} className="text-xs text-muted hover:text-fg">
                          for PR #{b.preview.pr}
                        </Link>
                      )}
                      {b.scrubbed && (
                        <Badge tone="ok" className="self-center">
                          <EyeOff className="size-3" /> Personal data hidden
                        </Badge>
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
      {scrubSupported && <CleanupCard serviceId={serviceId} initial={cleanupSql} canManage={canManage} />}
      {creating && (
        <NewBranchDialog
          serviceId={serviceId}
          serviceName={serviceName}
          canHide={scrubSupported && !!cleanupSql.trim()}
          scrubSupported={scrubSupported}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

const ENGINE_LABEL: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  mongodb: "MongoDB",
  redis: "Redis",
  valkey: "Valkey",
  clickhouse: "ClickHouse",
};
const engineLabel = (engine: string) => ENGINE_LABEL[engine] ?? engine;

/** The SQL that hides personal data in branches made with that option. */
function CleanupCard({ serviceId, initial, canManage }: { serviceId: string; initial: string; canManage: boolean }) {
  const [sql, setSql] = React.useState(initial);
  const [saved, setSaved] = React.useState(initial);
  const save = useAction(() => saveBranchCleanupSql(serviceId, sql.trim() || null), { success: "Clean-up SQL saved", onSuccess: () => setSaved(sql) });
  return (
    <Card>
      <CardHeader
        title="Hide personal data"
        description="SQL that runs on a branch's copy right after the data is copied, every time, before anything uses it. Branches made with “Hide personal data” use it; if it fails, the branch is marked failed instead of holding real data. Pull request previews use the clean-up SQL in the app's Settings → Previews."
      />
      <CardBody className="flex flex-col gap-3">
        <CodeEditor
          language="text"
          value={sql}
          onChange={setSql}
          minRows={5}
          readOnly={!canManage}
          placeholder={"UPDATE users SET email = 'user' || id || '@example.com', name = 'User ' || id;\nDELETE FROM sessions;"}
          aria-label="Branch clean-up SQL"
        />
        {canManage && (
          <div className="flex justify-end">
            <Button size="sm" variant="primary" loading={save.pending} disabled={sql === saved} onClick={() => void save.run()}>
              Save
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function NewBranchDialog({
  serviceId,
  serviceName,
  canHide,
  scrubSupported,
  onClose,
}: {
  serviceId: string;
  serviceName: string;
  canHide: boolean;
  scrubSupported: boolean;
  onClose: () => void;
}) {
  const [name, setName] = React.useState("");
  const [hide, setHide] = React.useState(canHide);
  const create = useAction(() => createDatabaseBranch(serviceId, name, { hidePersonalData: hide }), { success: "Branch started. Copying the data…", onSuccess: onClose });
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
            {scrubSupported && (
              <label className={cn("mt-4 flex items-start gap-3", canHide ? "cursor-pointer" : "cursor-default opacity-60")}>
                <Checkbox checked={hide} disabled={!canHide} onCheckedChange={setHide} className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-fg">Hide personal data</span>
                  <span className="text-[12.5px] leading-snug text-muted">
                    {canHide ? "Run the clean-up SQL on the copy, now and on every reset." : "Add the clean-up SQL on this page first."}
                  </span>
                </span>
              </label>
            )}
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
