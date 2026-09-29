"use client";

import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { Ban, GitCommitHorizontal, MoreHorizontal, RefreshCw, RotateCcw, Rocket, User } from "lucide-react";
import { Card, CardHeader, EmptyState, TimeAgo, Badge } from "@/components/ui/misc";
import { StatusDot, statusText } from "@/components/ui/status";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { cancelDeployment, redeployDeployment, rollbackTo } from "@/server/actions/services";
import { cn, formatDuration } from "@/lib/utils";
import { useServiceLive } from "./service-header";

export function DeploymentsList({ serviceId, projectId, type }: { serviceId: string; projectId: string; type: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  const { data, mutate } = useServiceLive(serviceId);
  const base = `/projects/${projectId}/services/${serviceId}`;
  const go = (id: string) => router.push(`${base}/deployments/${id}`);
  const rollback = useAction(rollbackTo, { success: "Rollback queued", onSuccess: (d) => go(d.id) });
  const redeploy = useAction(redeployDeployment, { success: "Redeploy queued", onSuccess: (d) => go(d.id) });
  const cancel = useAction(cancelDeployment, { success: "Cancel requested. It stops in a moment.", onSuccess: () => void mutate() });

  if (!data) return null;
  const { deployments, currentDeploymentId, containers } = data;
  const relevant = type === "app" ? containers.filter((c) => c.deployment === currentDeploymentId) : containers;

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <Card className="overflow-hidden">
        <CardHeader title="Deployments" description="Every deploy is kept so you can roll back instantly." />
        {deployments.length === 0 ? (
          <EmptyState icon={<Rocket />} title="No deployments yet" description="Press Deploy to build and start this service." />
        ) : (
          <ol className="relative">
            {deployments.map((d, i) => {
              const current = d.id === currentDeploymentId;
              const active = ["queued", "building", "deploying"].includes(d.status);
              const duration = d.startedAt && d.finishedAt ? formatDuration(new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) : null;
              return (
                <li key={d.id} className={cn("group relative border-b border-line last:border-b-0", current && "bg-ok-soft/40")}>
                  <Link href={`${base}/deployments/${d.id}`} className="grid grid-cols-[20px_1fr_auto] gap-x-3 px-5 py-3.5 transition-colors hover:bg-hover/50">
                    <span className="relative flex justify-center pt-1.5">
                      <StatusDot status={d.status} kind="deployment" />
                      {i < deployments.length - 1 && <span aria-hidden className="absolute top-5 -bottom-5 w-px bg-line" />}
                    </span>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-fg">
                          {d.commitMessage || (d.trigger === "rollback" ? "Rollback" : d.trigger === "create" ? "Initial deployment" : "Deployment")}
                        </span>
                        {current && <Badge tone="ok">Current</Badge>}
                        {d.trigger === "rollback" && <Badge tone="info">Rollback</Badge>}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                        <span className={cn(d.status === "failed" && "text-bad", active && "text-info")}>{statusText(d.status, "deployment")}</span>
                        {d.commitSha && (
                          <span className="inline-flex items-center gap-1 font-mono">
                            <GitCommitHorizontal className="size-3" />
                            {d.commitSha.slice(0, 7)}
                          </span>
                        )}
                        {d.branch && <span className="font-mono">{d.branch}</span>}
                        <span className="inline-flex items-center gap-1">
                          <User className="size-3" />
                          {d.userName ?? (d.trigger === "webhook" ? (d.commitAuthor ?? "Git push") : "System")}
                        </span>
                        {duration && <span className="tabular-nums">{duration}</span>}
                      </span>
                      {d.status === "failed" && d.error && <span className="line-clamp-1 text-xs text-bad/90">{d.error.split("\n")[0]}</span>}
                    </span>
                    <span className="flex items-start gap-1 text-xs text-faint">
                      <TimeAgo date={d.createdAt} className="pt-0.5" />
                    </span>
                  </Link>
                  <div className="absolute top-3 right-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Menu>
                      <MenuTrigger className="rounded-lg bg-surface p-1.5 text-muted shadow-sm ring-1 ring-line hover:text-fg" aria-label="Deployment actions">
                        <MoreHorizontal className="size-4" />
                      </MenuTrigger>
                      <MenuContent>
                        {active ? (
                          <MenuItem danger onClick={() => cancel.run(d.id)}>
                            <Ban /> Cancel deployment
                          </MenuItem>
                        ) : (
                          <>
                            {type === "app" && d.status === "success" && !current && d.image && (
                              <MenuItem
                                onClick={async () => {
                                  if (
                                    await confirm({
                                      title: "Roll back to this deployment?",
                                      description: "The image from this deployment is started again without rebuilding. Current variables are used.",
                                      confirmLabel: "Roll back",
                                    })
                                  )
                                    rollback.run(d.id);
                                }}
                              >
                                <RotateCcw /> Roll back to this
                              </MenuItem>
                            )}
                            <MenuItem onClick={() => redeploy.run(d.id)}>
                              <RefreshCw /> Redeploy
                            </MenuItem>
                          </>
                        )}
                      </MenuContent>
                    </Menu>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <Card className="h-fit overflow-hidden">
        <CardHeader title="Containers" description={relevant.length ? `${relevant.filter((c) => c.state === "running").length} of ${relevant.length} running` : "None running"} />
        <div className="divide-y divide-line">
          {relevant.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-5 py-3">
              <StatusDot status={c.state === "running" ? "running" : c.state === "restarting" ? "restarting" : c.state === "exited" ? "failed" : "stopped"} />
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-[12px] text-fg-2">{c.composeService ?? c.name}</span>
                <span className="truncate text-[11px] text-faint">{c.status}</span>
              </div>
            </div>
          ))}
          {relevant.length === 0 && <p className="px-5 py-4 text-[13px] text-muted">Containers appear here after a successful deploy.</p>}
        </div>
      </Card>
    </div>
  );
}
