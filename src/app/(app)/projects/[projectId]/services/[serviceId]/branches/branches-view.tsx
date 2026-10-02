"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Copy, EyeOff, GitBranch, Layers, Loader2, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Badge, Card, CardBody, CardHeader, CopyButton, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip } from "@/components/ui/tooltip";
import { copyText } from "@/components/ui/clipboard";
import { Select } from "@/components/ui/select";
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
  sourceBranchId: string | null;
  allDatabases: boolean;
  extraDatabases: string[];
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
  allSupported,
  mainDatabase,
}: {
  serviceId: string;
  serviceName: string;
  engine: string;
  refName: string;
  status: string;
  cleanupSql: string;
  scrubSupported: boolean;
  allSupported: boolean;
  mainDatabase: string;
  running: boolean;
  canManage: boolean;
  branches: Branch[];
  projectId: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [creating, setCreating] = React.useState(false);
  // The list by default; the last view chosen in this browser after that.
  const [view, setViewState] = React.useState<"canvas" | "list">("list");
  React.useEffect(() => {
    try {
      if (localStorage.getItem("serve.branches.view") === "canvas") setViewState("canvas");
    } catch {}
  }, []);
  const setView = (next: "canvas" | "list") => {
    setViewState(next);
    try {
      localStorage.setItem("serve.branches.view", next);
    } catch {}
  };
  const reset = useAction(resetDatabaseBranch);
  const remove = useAction(deleteDatabaseBranch);

  const keyValue = engine === "redis" || engine === "valkey";
  /** Branches copied from this one, and from those, all the way down. */
  const descendantsOf = (id: string): string[] => branches.filter((x) => x.sourceBranchId === id).flatMap((x) => [x.name, ...descendantsOf(x.id)]);
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
          // Only Redis's caveat: its branches share the main password.
          description={keyValue ? "Redis has no logins per database, so a branch uses the main password: an app given a branch could still switch to the main data." : undefined}
          actions={
            <div className="flex items-center gap-2">
              {branches.length > 0 && <ViewToggle view={view} views={["list", "canvas"]} onChange={setView} />}
              {canManage && (
                <Button size="sm" variant="primary" disabled={!running} title={running ? undefined : "Start the database to branch it"} onClick={() => setCreating(true)}>
                  <Plus /> New branch
                </Button>
              )}
            </div>
          }
        />
        {branches.length > 0 && view === "canvas" ? (
          <div className="border-t border-line">
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
              const source = branches.find((x) => x.id === b.sourceBranchId);
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
                      {source && <span className="text-xs text-muted">from {source.name}</span>}
                      {b.allDatabases && (
                        <Badge tone="info" className="self-center" title={b.extraDatabases.length ? `Also copies ${b.extraDatabases.join(", ")}` : undefined}>
                          <Layers className="size-3" /> {b.extraDatabases.length + 1} databases
                        </Badge>
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
                    ) : b.allDatabases ? (
                      // One login for every copy: each chip copies the reference to one of them.
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted">Copy reference:</span>
                        {[mainDatabase, ...b.extraDatabases].map((d) => (
                          <ReferenceChip key={d} label={d} value={branchReference(refName, b.name, `databases.${d}.DATABASE_URL`)} />
                        ))}
                      </span>
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
                                description: `Its data is replaced with a fresh copy of ${source ? `branch ${source.name}` : serviceName}. Changes made in the branch are lost.`,
                                confirmLabel: "Reset branch",
                                danger: true,
                              })
                            )
                              reset.run(b.id);
                          }}
                        >
                          <RotateCcw /> {source ? `Reset to ${source.name}` : "Reset to the main data"}
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          danger
                          onClick={async () => {
                            const children = descendantsOf(b.id);
                            const choice = { withChildren: true };
                            if (
                              await confirm({
                                title: `Delete ${b.name}?`,
                                description: `The branch's ${b.allDatabases ? "databases" : "database"} and login are removed. Services that reference it lose their connection.`,
                                children: children.length ? <ChildrenChoice names={children} onChange={(v) => (choice.withChildren = v)} /> : undefined,
                                confirmLabel: "Delete branch",
                                danger: true,
                              })
                            )
                              remove.run(b.id, { withChildren: choice.withChildren });
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
      {scrubSupported && <CleanupCard key={cleanupSql} serviceId={serviceId} initial={cleanupSql} canManage={canManage} />}
      {creating && (
        <NewBranchDialog
          serviceId={serviceId}
          serviceName={serviceName}
          cleanupSql={cleanupSql}
          scrubSupported={scrubSupported}
          allSupported={allSupported}
          sources={branches.filter((b) => b.status === "ready" && !b.preview)}
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
  const save = useAction(() => saveBranchCleanupSql(serviceId, sql.trim() || null), { onSuccess: () => setSaved(sql) });
  return (
    <Card>
      <CardHeader
        title="Hide personal data"
        description="Runs on the branches you create with “Hide personal data” ticked, right after their data is copied and on every reset. If it fails, the branch fails, so it never holds real data."
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
  cleanupSql,
  scrubSupported,
  allSupported,
  sources,
  onClose,
}: {
  serviceId: string;
  serviceName: string;
  cleanupSql: string;
  scrubSupported: boolean;
  allSupported: boolean;
  sources: Branch[];
  onClose: () => void;
}) {
  const [name, setName] = React.useState("");
  const [sourceId, setSourceId] = React.useState("main");
  const source = sources.find((b) => b.id === sourceId) ?? null;
  const hasSql = !!cleanupSql.trim();
  const [all, setAll] = React.useState(false);
  const [hide, setHide] = React.useState(hasSql);
  const [sql, setSql] = React.useState("");
  // A copy of a branch with personal data hidden always hides it too.
  // Every database copies the main data, and the clean-up SQL runs on the main database only.
  const hidden = !all && (hide || !!source?.scrubbed);
  const needsSql = hidden && !hasSql;
  const create = useAction(
    async () => {
      // The clean-up SQL written here is saved for the database first, like on the page.
      if (needsSql) {
        const saved = await saveBranchCleanupSql(serviceId, sql.trim());
        if (!saved.ok) return saved;
      }
      return createDatabaseBranch(serviceId, name, { hidePersonalData: hidden, sourceBranchId: source?.id ?? null, allDatabases: all });
    },
    { onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size={needsSql ? "md" : "sm"}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create.run();
          }}
        >
          <DialogHeader
            title="New branch"
            description={`A copy of ${source ? `branch ${source.name}` : `${serviceName}'s data`} as it is now. ${source ? "It" : "The main database"} keeps running while it copies.`}
          />
          <DialogBody className="flex flex-col gap-4">
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
            {sources.length > 0 && (
              <Field label="Copy from" description="Resets copy from here again.">
                <Select
                  value={sourceId}
                  onValueChange={setSourceId}
                  options={[
                    { value: "main", label: "Main data", description: serviceName },
                    // Every database copies from the main data or from a branch that has them all.
                    ...sources
                      .filter((b) => !all || b.allDatabases)
                      .map((b) => ({
                        value: b.id,
                        label: b.name,
                        description: b.allDatabases ? "Branch · every database" : b.scrubbed ? "Branch · personal data hidden" : "Branch",
                      })),
                  ]}
                />
              </Field>
            )}
            {allSupported && (
              <label className="flex cursor-pointer items-start gap-3">
                <Checkbox
                  checked={all}
                  onCheckedChange={(on) => {
                    setAll(on);
                    // A branch with the main database only cannot be the source of every database.
                    if (on && source && !source.allDatabases) setSourceId("main");
                  }}
                  className="mt-0.5"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-fg">Copy every database</span>
                  <span className="text-[12.5px] leading-snug text-muted">
                    Also copies the other databases{source ? ` of ${source.name}` : ` of ${serviceName}`}, each as name__branch, with the same login. Personal data is not hidden.
                  </span>
                </span>
              </label>
            )}
            {scrubSupported && !all && (
              <label className={cn("flex items-start gap-3", source?.scrubbed ? "cursor-default" : "cursor-pointer")}>
                <Checkbox checked={hidden} disabled={!!source?.scrubbed} onCheckedChange={setHide} className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-fg">Hide personal data</span>
                  <span className="text-[12.5px] leading-snug text-muted">
                    {source?.scrubbed
                      ? `On, because ${source.name} hides it too.`
                      : hasSql
                        ? "Run the clean-up SQL on the copy, now and on every reset."
                        : "Run clean-up SQL on the copy, now and on every reset. Write it below."}
                  </span>
                </span>
              </label>
            )}
            {needsSql && (
              <CodeEditor
                language="text"
                value={sql}
                onChange={setSql}
                minRows={4}
                placeholder={"UPDATE users SET email = 'user' || id || '@example.com', name = 'User ' || id;\nDELETE FROM sessions;"}
                aria-label="Branch clean-up SQL"
              />
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.pending} disabled={!name || (needsSql && !sql.trim())}>
              Create branch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** In the delete confirmation: whether the branches copied from this one go too (they do unless unticked). */
function ChildrenChoice({ names, onChange }: { names: string[]; onChange: (withChildren: boolean) => void }) {
  const [on, setOn] = React.useState(true);
  return (
    <label className="mt-1 flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
      <Checkbox
        checked={on}
        onCheckedChange={(v) => {
          setOn(v);
          onChange(v);
        }}
        className="mt-0.5"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-medium text-fg">Also delete the {names.length === 1 ? "branch" : `${names.length} branches`} copied from it</span>
        <span className="text-[12.5px] leading-snug break-words text-muted">
          {names.join(", ")}. {on ? "" : "Kept, they copy the main data on their next reset."}
        </span>
      </span>
    </label>
  );
}

/** A database name that copies its reference when clicked; the reference shows on hover. */
function ReferenceChip({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Tooltip content={copied ? "Copied" : value}>
      <button
        type="button"
        onClick={async () => {
          if (!(await copyText(value))) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-surface-2 px-2 font-mono text-[11.5px] text-fg-2 transition-colors hover:border-line-strong hover:text-fg"
        aria-label={`Copy the reference to ${label}`}
      >
        {copied ? <Check className="size-3 text-ok" /> : <Copy className="size-3 text-faint" />}
        {label}
      </button>
    </Tooltip>
  );
}
