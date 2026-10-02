"use client";

import * as React from "react";
import { AlertTriangle, ArrowRightLeft, Box, Clock, Copy, Database, GitBranch, HardDrive, KeyRound, Loader2, Network, Plug } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useRouter } from "@/hooks/use-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { adoptionPreview, moveContainerIntoProject } from "@/server/actions/adopt";
import { cn } from "@/lib/utils";

type Preview = Extract<Awaited<ReturnType<typeof adoptionPreview>>, { ok: true }>["data"];

const engineLabel: Record<string, string> = { postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB", mongodb: "MongoDB", redis: "Redis", valkey: "Valkey" };

function Kept({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 px-3.5 py-2.5">
      <span className="mt-0.5 flex-none text-faint [&_svg]:size-3.5">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs font-medium text-muted">{label}</span>
        <div className="min-w-0 text-[12.5px] text-fg-2">{children}</div>
      </div>
    </div>
  );
}

const Name = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-fg/[0.06] px-1 py-px font-mono text-[12px] text-fg">{children}</code>;

function Segmented<V extends string>({ value, onChange, options }: { value: V; onChange: (v: V) => void; options: { value: V; label: string; icon?: React.ReactNode }[] }) {
  return (
    <div role="radiogroup" className="grid h-9 auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition-colors [&_svg]:size-3.5 [&_svg]:flex-none",
            value === o.value ? "bg-fg/[0.08] text-fg" : "text-muted hover:bg-fg/[0.03] hover:text-fg",
          )}
        >
          {o.icon}
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Moves a container Serve does not manage into a project: a service takes over its data, ports and names. */
export function MoveContainerDialog({ serverId, container, onClose }: { serverId: string; container: { id: string; name: string } | null; onClose: () => void }) {
  const router = useRouter();
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [projectId, setProjectId] = React.useState("");
  const [environmentId, setEnvironmentId] = React.useState("");
  const [name, setName] = React.useState("");
  const [as, setAs] = React.useState<"database" | "container">("container");
  const [mode, setMode] = React.useState<"move" | "copy">("move");
  const [fromGit, setFromGit] = React.useState(false);
  const [repository, setRepository] = React.useState("");
  const [branch, setBranch] = React.useState("main");
  const [credentialId, setCredentialId] = React.useState("");
  const [password, setPassword] = React.useState("");

  React.useEffect(() => {
    if (!container) return;
    let live = true;
    setPreview(null);
    setLoadError(null);
    void adoptionPreview({ serverId, containerId: container.id }).then((res) => {
      if (!live) return;
      if (!res.ok) return setLoadError(res.error);
      const p = res.data;
      setPreview(p);
      setMode("move");
      setFromGit(!!p.git.repository);
      setRepository(p.git.repository ?? "");
      setBranch(p.git.branch ?? "main");
      setCredentialId("");
      setName(p.name);
      setAs(p.database ? "database" : "container");
      setProjectId(p.projects[0]?.id ?? "");
      setEnvironmentId(p.projects[0]?.environments[0]?.id ?? "");
    });
    return () => {
      live = false;
    };
  }, [serverId, container]);

  const move = useAction(
    () =>
      moveContainerIntoProject({
        serverId,
        containerId: container!.id,
        projectId,
        environmentId,
        name,
        as,
        mode,
        git: as === "container" && fromGit && repository.trim() ? { repository, branch, credentialId: credentialId || null } : null,
        password: as === "database" && password ? password : undefined,
      }),
    {
      refresh: false,
      onSuccess: (r) => {
        onClose();
        router.push(`/projects/${r.projectId}/services/${r.id}/deployments/${r.deploymentId}`);
      },
    },
  );

  const project = preview?.projects.find((p) => p.id === projectId);
  const db = preview?.database;
  const needsPassword = as === "database" && !!db && !db.loginWorks;
  const copy = mode === "copy";
  const stops = as === "database" || (preview?.volumes.length ?? 0) > 0 || (preview?.ports.length ?? 0) > 0;
  // A copy of a container copies its volumes (folders on the server stay shared) with it stopped.
  const copiedVolumes = preview?.volumes.filter((v) => v.kind === "volume") ?? [];
  const sharedFolders = preview?.volumes.filter((v) => v.kind === "bind") ?? [];
  const dumpTool: Record<string, string> = { postgres: "pg_dump", mysql: "mysqldump", mariadb: "mariadb-dump", mongodb: "mongodump", redis: "an RDB dump", valkey: "an RDB dump" };
  const blocked = !!preview?.blockers.length || !preview?.projects.length;
  // Every name the container answers to now, on its networks and in the project.
  const oldNames = [...new Set([...(preview?.networks.flatMap((n) => n.aliases) ?? []), ...(preview?.hostname ? [preview.hostname] : [])])].sort((a, b) => a.length - b.length);

  return (
    <Dialog open={!!container} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void move.run();
          }}
        >
          <DialogHeader title={`${copy ? "Copy" : "Move"} ${container?.name ?? "container"} into a project`} />
          <DialogBody className="flex flex-col gap-4">
            {loadError ? (
              <p className="rounded-lg bg-bad-soft px-3 py-2.5 text-[13px] text-bad">{loadError}</p>
            ) : !preview ? (
              <p className="flex items-center gap-2 py-6 text-[13px] text-muted">
                <Loader2 className="size-4 animate-spin" /> Reading the container…
              </p>
            ) : (
              <>
                {preview.blockers.map((b) => (
                  <p key={b} className="flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2.5 text-[13px] text-bad">
                    <AlertTriangle className="mt-0.5 size-3.5 flex-none" /> {b}
                  </p>
                ))}
                {!preview.projects.length && <p className="rounded-lg bg-warn-soft px-3 py-2.5 text-[13px] text-warn">Create a project first.</p>}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Project">
                    <Select
                      value={projectId}
                      onValueChange={(id) => {
                        setProjectId(id);
                        setEnvironmentId(preview.projects.find((p) => p.id === id)?.environments[0]?.id ?? "");
                      }}
                      options={preview.projects.map((p) => ({ value: p.id, label: p.name }))}
                    />
                  </Field>
                  {(project?.environments.length ?? 0) > 1 ? (
                    <Field label="Environment">
                      <Select value={environmentId} onValueChange={setEnvironmentId} options={(project?.environments ?? []).map((e) => ({ value: e.id, label: e.name }))} />
                    </Field>
                  ) : (
                    <Field label="Service name">
                      <Input value={name} onChange={(e) => setName(e.target.value)} />
                    </Field>
                  )}
                </div>
                {(project?.environments.length ?? 0) > 1 && (
                  <Field label="Service name">
                    <Input value={name} onChange={(e) => setName(e.target.value)} />
                  </Field>
                )}

                <div className={cn("grid grid-cols-1 gap-4", db && "sm:grid-cols-2")}>
                  <Field label="Action">
                    <Segmented
                      value={mode}
                      onChange={setMode}
                      options={[
                        { value: "move", label: "Move" },
                        { value: "copy", label: "Copy" },
                      ]}
                    />
                  </Field>
                  {db && (
                    <Field label="Run as">
                      <Segmented
                        value={as}
                        onChange={setAs}
                        options={[
                          { value: "database", label: "Database", icon: <Database /> },
                          { value: "container", label: "Container", icon: <Box /> },
                        ]}
                      />
                    </Field>
                  )}
                </div>
                {!db && preview.databaseProblems.length > 0 && <p className="text-xs leading-relaxed text-muted">It moves as a container: {preview.databaseProblems.join(" ")}</p>}
                {needsPassword && (
                  <Field
                    label="Database password"
                    description={db?.passwordFound ? "The password it was started with did not work. It may have been changed since." : "Serve found no password in its settings."}
                  >
                    <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required />
                  </Field>
                )}
                {as === "container" && (
                  <div className="flex flex-col gap-3 rounded-xl border border-line p-3.5">
                    <label className="flex items-start justify-between gap-3">
                      <span className="flex flex-col gap-0.5">
                        <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg [&_svg]:size-3.5">
                          <GitBranch /> Deploy from git after the move
                        </span>
                        <span className="text-xs leading-relaxed text-muted">
                          It runs its current image now. Later deploys build from the repository, with the same variables.
                          {preview.git.repository
                            ? " Serve found the repository in the image's labels."
                            : preview.git.revision
                              ? ` Its image names commit ${preview.git.revision.slice(0, 7)}, not the repository.`
                              : ""}
                        </span>
                      </span>
                      <Switch checked={fromGit} onCheckedChange={setFromGit} />
                    </label>
                    {fromGit && (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
                        <Field label="Repository">
                          <Input
                            value={repository}
                            onChange={(e) => setRepository(e.target.value)}
                            placeholder="https://github.com/owner/repo"
                            className="font-mono text-[13px]"
                            required
                          />
                        </Field>
                        <Field label="Branch">
                          <Input value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono text-[13px]" required />
                        </Field>
                        {preview.credentials.length > 0 && (
                          <Field label="Git connection" className="sm:col-span-2">
                            <Select
                              value={credentialId || "none"}
                              onValueChange={(v) => setCredentialId(v === "none" ? "" : v)}
                              options={[{ value: "none", label: "None (public repository)" }, ...preview.credentials.map((c) => ({ value: c.id, label: c.name }))]}
                            />
                          </Field>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="divide-y divide-line rounded-xl border border-line">
                  <Kept icon={copy ? <Copy /> : <ArrowRightLeft />} label="What happens">
                    {copy
                      ? "The original keeps running. The service gets its own copy of the data."
                      : "The service takes over its data, ports and names. The old container is kept, stopped."}
                    {as === "database" && db && ` It runs as a ${engineLabel[db.engine] ?? db.engine} service, with backups, the Data tab and users.`}
                  </Kept>
                  {as === "database" && db?.loginWorks && (
                    <Kept icon={<KeyRound />} label="Password">
                      <span className="text-ok">Serve signed in as {db.username} with the password it runs with</span>
                    </Kept>
                  )}
                  <Kept icon={<Box />} label="Image">
                    <span className="font-mono text-[12px]">{preview.image}</span>
                    {preview.envKeys.length > 0 && as === "container" && (
                      <span className="text-muted">
                        {" "}
                        · {preview.envKeys.length} variable{preview.envKeys.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </Kept>
                  {copy && as === "database" && db ? (
                    <Kept icon={<HardDrive />} label="Data, copied">
                      Every database, dumped with {dumpTool[db.engine] ?? "its own tools"} and restored into a volume of its own
                    </Kept>
                  ) : (
                    preview.volumes.length > 0 && (
                      <Kept icon={<HardDrive />} label={copy ? "Data" : "Data, used where it is"}>
                        {preview.volumes.map((v) => (
                          <div key={v.mountPath} className="truncate font-mono text-[12px]">
                            {/^[a-f0-9]{64}$/.test(v.source) ? <span className="font-sans text-muted">unnamed volume {v.source.slice(0, 8)}…</span> : v.source}{" "}
                            <span className="text-faint">→</span> {v.mountPath}
                            {copy && <span className="font-sans text-muted"> · {v.kind === "volume" ? "copied" : "shared"}</span>}
                          </div>
                        ))}
                      </Kept>
                    )
                  )}
                  {preview.ports.length > 0 && (
                    <Kept icon={<Plug />} label="Host ports">
                      {copy ? (
                        <span className="text-muted">Stay with the original ({preview.ports.join("  ")})</span>
                      ) : (
                        <span className="font-mono text-[12px]">{preview.ports.join("  ")}</span>
                      )}
                    </Kept>
                  )}
                  <Kept icon={<Network />} label="Address">
                    {copy ? (
                      <>
                        Services in the project reach the copy at <Name>{preview.hostname ?? name}</Name>. Apps that use the original keep using the original.
                      </>
                    ) : (
                      <>
                        Apps keep reaching it at{" "}
                        {oldNames.map((n, i) => (
                          <React.Fragment key={n}>
                            {i > 0 && (i === oldNames.length - 1 ? " or " : ", ")}
                            <Name>{n}</Name>
                          </React.Fragment>
                        ))}
                        , the same {oldNames.length === 1 ? "name" : "names"} as now.
                      </>
                    )}
                  </Kept>
                  <Kept icon={<Clock />} label="Downtime">
                    {copy
                      ? as === "database" && db
                        ? `None. Changes made after the copy stay in the original.${["postgres", "mysql", "mariadb"].includes(db.engine) ? ` Users other than ${db.username} are not copied.` : ""}`
                        : copiedVolumes.length
                          ? `The original stops while its volumes are copied, then starts again.${sharedFolders.length ? " Folders on the server stay shared." : ""}`
                          : "None. There is no data to copy."
                      : stops
                        ? "A few seconds, while the service starts on the same data. If it fails, the old container starts again."
                        : "None. The old container stops once the service is healthy."}
                  </Kept>
                </div>

                {!copy && preview.volumes.some((v) => v.kind === "volume") && (
                  <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2.5 text-xs leading-relaxed text-warn">
                    <AlertTriangle className="mt-0.5 size-3.5 flex-none" />
                    The service uses these volumes from now on. If you remove the old app in the tool that made it, keep its volumes: deleting them deletes this data.
                  </p>
                )}
                {preview.notes.length > 0 && (
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer font-medium text-fg-2">Not carried over ({preview.notes.length})</summary>
                    <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 leading-relaxed">
                      {preview.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                      {as === "database" && db?.droppedEnv.length ? <li>Variables a database service does not keep: {db.droppedEnv.join(", ")}.</li> : null}
                    </ul>
                  </details>
                )}
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" size="sm" variant="primary" disabled={!preview || blocked || !environmentId} loading={move.pending}>
              {copy ? "Copy into project" : "Move into project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
