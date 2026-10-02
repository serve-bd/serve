"use client";

import * as React from "react";
import { AlertTriangle, Box, Database, HardDrive, Loader2, Network, Plug } from "lucide-react";
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

  return (
    <Dialog open={!!container} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void move.run();
          }}
        >
          <DialogHeader
            title={`${copy ? "Copy" : "Move"} ${container?.name ?? "container"} into a project`}
            description={
              copy
                ? "The container keeps running as it is. A new service gets its own copy of the data, under the same name in the project."
                : "A service takes its place on the same data, ports and names. Nothing is copied, and the old container is kept, stopped."
            }
          />
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

                <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1">
                  {(["move", "copy"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={cn("h-8 rounded-lg text-[13px] font-medium transition-all", mode === m ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
                    >
                      {m === "move" ? "Move" : "Copy"}
                    </button>
                  ))}
                </div>

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

                {db && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(
                      [
                        ["database", <Database key="d" />, `${engineLabel[db.engine] ?? db.engine} database`, "Backups, the Data tab and users, on the same data."],
                        ["container", <Box key="c" />, "Container", "Runs exactly as it does now. No database tools."],
                      ] as const
                    ).map(([id, icon, title, body]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setAs(id)}
                        className={cn(
                          "flex flex-col gap-1 rounded-xl border p-3 text-left transition-all",
                          as === id ? "border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]" : "border-line hover:border-line-strong",
                        )}
                      >
                        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-fg [&_svg]:size-3.5">
                          {icon} {title}
                        </span>
                        <span className="text-xs leading-relaxed text-muted">{body}</span>
                      </button>
                    ))}
                  </div>
                )}
                {!db && preview.databaseProblems.length > 0 && <p className="text-xs leading-relaxed text-muted">It moves as a container: {preview.databaseProblems.join(" ")}</p>}
                {needsPassword && (
                  <Field
                    label="Database password"
                    description={db?.passwordFound ? "The password it was started with did not work. It may have been changed since." : "Serve found no password in its settings."}
                  >
                    <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required />
                  </Field>
                )}
                {as === "database" && db?.loginWorks && <p className="text-xs text-ok">Serve signed in as {db.username} with the password it runs with.</p>}

                <div className="divide-y divide-line rounded-xl border border-line">
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
                            {v.source} <span className="text-faint">→</span> {v.mountPath}
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
                  <Kept icon={<Network />} label="Names other containers reach it by">
                    {preview.hostname && (
                      <div>
                        <span className="font-mono text-[12px]">{preview.hostname}</span> <span className="text-muted">in the project</span>
                      </div>
                    )}
                    {copy
                      ? preview.networks.length > 0 && <div className="text-muted">Its names on {preview.networks.map((n) => n.name).join(", ")} stay with the original.</div>
                      : preview.networks.map((n) => (
                          <div key={n.name} className="truncate">
                            <span className="font-mono text-[12px]">{n.aliases.join(", ")}</span> <span className="text-muted">on {n.name}</span>
                          </div>
                        ))}
                  </Kept>
                </div>

                <p className="text-xs leading-relaxed text-muted">
                  {copy
                    ? as === "database" && db
                      ? `No downtime: it keeps running while Serve copies it. Changes made after the copy stay in the original only.${
                          ["postgres", "mysql", "mariadb"].includes(db.engine) ? ` Users other than ${db.username} are not copied.` : ""
                        }`
                      : copiedVolumes.length
                        ? `It stops while its volumes are copied, then starts again: a few seconds for small data, longer for big data.${sharedFolders.length ? " Folders on the server stay shared with it." : ""}`
                        : "No downtime: there is no data to copy."
                    : stops
                      ? "It stops for a few seconds while the service starts in its place: two containers cannot share its data or ports. If the service does not start, the old container starts again."
                      : "No downtime: the service starts first, and the old container stops once it is healthy."}
                </p>
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
