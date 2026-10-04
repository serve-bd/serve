"use client";

import * as React from "react";
import { CircleAlert, CircleCheck, Download, Loader2, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm";
import { Badge, Card, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { useAction } from "@/hooks/use-action";
import { checkOsUpdatesAction, installOsUpdatesAction } from "@/server/actions/servers";
import type { OsUpdates } from "@/server/db/schema";
import { cn } from "@/lib/utils";

const MANAGER: Record<string, string> = {
  apt: "apt (Debian, Ubuntu)",
  dnf: "dnf (Fedora, RHEL, Rocky, Alma)",
  yum: "yum (CentOS)",
  zypper: "zypper (openSUSE, SLES)",
  pacman: "pacman (Arch)",
  apk: "apk (Alpine)",
};

export function UpdatesView({ serverId, local, state, sshUser }: { serverId: string; local: boolean; state: OsUpdates | null; sshUser: string | null }) {
  const confirm = useConfirm();
  const [picked, setPicked] = React.useState<string[]>([]);
  const check = useAction(() => checkOsUpdatesAction(serverId));
  const install = useAction((what: "all" | string[]) => installOsUpdatesAction(serverId, what), { onSuccess: () => setPicked([]) });
  const running = state?.run?.state === "running";
  const packages = state?.packages ?? [];
  const docker = packages.filter((p) => p.docker);
  const others = packages.filter((p) => !p.docker);
  const pacman = state?.manager === "pacman";
  // Shown as checking from the click until the check's result arrives.
  const [checkingSince, setCheckingSince] = React.useState<string | null>(null);
  const checking = !!checkingSince && (!state?.checkedAt || state.checkedAt < checkingSince);

  const runInstall = async (what: "all" | string[]) => {
    const names = what === "all" ? others.map((p) => p.name) : what;
    const withDocker = names.filter((n) => docker.some((d) => d.name === n));
    if (
      await confirm({
        title: what === "all" ? `Install ${others.length} update${others.length === 1 ? "" : "s"}?` : `Install ${names.length} update${names.length === 1 ? "" : "s"}?`,
        description: withDocker.length
          ? `This includes ${withDocker.join(", ")}: Docker restarts, and every container on this server stops for a moment.`
          : "Services keep running. Some packages restart their own system services; a new kernel needs a reboot, which Serve never does for you.",
        confirmLabel: "Install",
        danger: withDocker.length > 0,
      })
    )
      void install.run(what);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <Card>
        <CardHeader
          title="Operating system updates"
          description={
            <>
              Package updates of this server&apos;s operating system. Serve checks once a week and tells you, but installs only when you ask.
              {sshUser && sshUser !== "root" ? ` As ${sshUser}, it needs passwordless sudo.` : ""}
            </>
          }
          actions={
            <Button
              size="sm"
              loading={check.pending || checking}
              disabled={running}
              onClick={() => {
                setCheckingSince(new Date().toISOString());
                void check.run();
              }}
            >
              <RefreshCw /> Check now
            </Button>
          }
        />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line px-5 py-3 text-[13px] text-muted">
          <span>{state?.manager ? MANAGER[state.manager] : "Package manager: not checked yet"}</span>
          {state?.checkedAt && (
            <span>
              Checked <TimeAgo date={state.checkedAt} />
            </span>
          )}
          {state?.rebootRequired && (
            <span className="inline-flex items-center gap-1 text-warn">
              <RotateCcw className="size-3.5" /> Waits for a reboot
            </span>
          )}
        </div>
        {state?.error && (
          <p className="flex items-start gap-2 border-t border-line bg-bad-soft/40 px-5 py-3 text-[13px] text-bad">
            <CircleAlert className="mt-0.5 size-4 flex-none" /> {state.error}
          </p>
        )}
      </Card>

      {state?.run && <RunCard run={state.run} />}

      {state?.checkedAt && !state.error && (
        <Card className="overflow-hidden">
          <CardHeader
            title={packages.length ? `${packages.length} update${packages.length === 1 ? "" : "s"} available` : "Up to date"}
            description={
              pacman ? "Arch Linux updates everything together: pick nothing, use Update all." : packages.length ? "Pick some, or update everything except Docker." : undefined
            }
            actions={
              packages.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {picked.length > 0 && !pacman && (
                    <Button size="sm" onClick={() => runInstall(picked)} disabled={running} loading={install.pending}>
                      <Download /> Update {picked.length}
                    </Button>
                  )}
                  <Button size="sm" variant="primary" onClick={() => runInstall("all")} disabled={running || !others.length} loading={install.pending && !picked.length}>
                    <Download /> Update all{docker.length ? " except Docker" : ""}
                  </Button>
                </div>
              )
            }
          />
          {packages.length === 0 ? (
            <EmptyState icon={<CircleCheck />} title="No updates" description="Every package is at its newest version." />
          ) : (
            <ul className="max-h-[32rem] divide-y divide-line overflow-y-auto border-t border-line">
              {[...docker, ...others].map((p) => {
                const blocked = p.docker && local;
                return (
                  <li key={p.name} className="flex items-center gap-3 px-5 py-2">
                    {!pacman && (
                      <Checkbox
                        checked={picked.includes(p.name)}
                        disabled={blocked || running}
                        onCheckedChange={(c) => setPicked((now) => (c ? [...now, p.name] : now.filter((n) => n !== p.name)))}
                        aria-label={`Pick ${p.name}`}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">{p.name}</span>
                    {p.docker && (
                      <Badge
                        tone="warn"
                        title={blocked ? "Updating Docker here would stop Serve itself: update it in a terminal on the host." : "Updating it restarts every container."}
                      >
                        <TriangleAlert className="size-3" /> {blocked ? "Docker: update on the host" : "Restarts all containers"}
                      </Badge>
                    )}
                    <span className="hidden min-w-0 truncate font-mono text-[11.5px] text-muted sm:inline">
                      {p.current ? `${p.current} → ` : ""}
                      {p.next}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function RunCard({ run }: { run: NonNullable<OsUpdates["run"]> }) {
  const logRef = React.useRef<HTMLPreElement>(null);
  // Follows the log while it grows, and opens at its end, where the result is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the log changes
  React.useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [run.log]);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {run.state === "running" ? (
              <Loader2 className="size-4 animate-spin text-info" />
            ) : run.state === "success" ? (
              <CircleCheck className="size-4 text-ok" />
            ) : (
              <CircleAlert className="size-4 text-bad" />
            )}
            {run.state === "running" ? "Installing updates" : run.state === "success" ? "Updates installed" : "Update failed"}
          </span>
        }
        description={
          <>
            {run.what === "all" ? "Everything except Docker" : `${run.what.length} package${run.what.length === 1 ? "" : "s"}`} · started <TimeAgo date={run.startedAt} />
            {run.finishedAt && (
              <>
                {" "}
                · finished <TimeAgo date={run.finishedAt} />
              </>
            )}
          </>
        }
      />
      {run.error && <p className="border-t border-line bg-bad-soft/40 px-5 py-2.5 text-[13px] text-bad">{run.error}</p>}
      <pre ref={logRef} className={cn("max-h-80 overflow-auto border-t border-line bg-sunken px-5 py-3 font-mono text-[11.5px] leading-relaxed text-fg-2")}>
        {run.log.trim() || "…"}
      </pre>
    </Card>
  );
}
