"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { Ban, Check, GitCommitHorizontal, MoreHorizontal, RefreshCw, RotateCcw, Rocket, User } from "lucide-react";
import { Card, EmptyState, TimeAgo, Badge } from "@/components/ui/misc";
import { StatusDot, statusText } from "@/components/ui/status";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { cancelDeployment, redeployDeployment, rollbackTo } from "@/server/actions/services";
import { approveDeployment, rejectDeployment } from "@/server/actions/deploy-rules";
import { Button } from "@/components/ui/button";
import { cn, formatDuration } from "@/lib/utils";
import { useCan } from "@/components/permissions";
import { useServiceLive } from "./service-header";

export function DeploymentsList({ serviceId, projectId, type }: { serviceId: string; projectId: string; type: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  const can = useCan();
  const { data, mutate } = useServiceLive(serviceId);
  const base = `/projects/${projectId}/services/${serviceId}`;
  // Redeploys of a preview open that preview's deployment page.
  const target = React.useRef(serviceId);
  const go = (id: string) => router.push(`/projects/${projectId}/services/${target.current}/deployments/${id}`);
  const rollback = useAction(rollbackTo, { onSuccess: (d) => go(d.id) });
  const redeploy = useAction(redeployDeployment, { onSuccess: (d) => go(d.id) });
  const cancel = useAction(cancelDeployment, { result: "Cancel requested. It stops in a moment.", onSuccess: () => void mutate() });
  const approve = useAction(approveDeployment, { onSuccess: () => void mutate() });
  const reject = useAction(rejectDeployment, { onSuccess: () => void mutate() });

  if (!data) return null;
  const { currentDeploymentId } = data;
  // The app's deployments and those of its pull request previews, newest first.
  const previews = data.previews ?? [];
  const deployments = [
    ...data.deployments.map((d) => ({ ...d, preview: null })),
    ...previews.flatMap((p) =>
      p.deployments.map((d) => ({ ...d, image: null, error: null, userName: null, preview: { id: p.id, pr: p.pr, current: d.id === p.currentDeploymentId } })),
    ),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <Card className="overflow-hidden">
      {deployments.length === 0 ? (
        <EmptyState icon={<Rocket />} title="No deployments yet" description="Press Deploy to build and start this service." />
      ) : (
        <ol className="relative">
          {deployments.map((d, i) => {
            const current = d.preview ? d.preview.current : d.id === currentDeploymentId;
            const href = d.preview ? `/projects/${projectId}/services/${d.preview.id}/deployments/${d.id}` : `${base}/deployments/${d.id}`;
            const active = ["waiting", "queued", "building", "deploying"].includes(d.status);
            const duration = d.startedAt && d.finishedAt ? formatDuration(new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) : null;
            return (
              <li key={d.id} className={cn("group relative border-b border-line last:border-b-0", current && !d.preview && "bg-ok-soft/40")}>
                <Link href={href} className="grid grid-cols-[20px_1fr_auto] gap-x-3 px-5 py-3.5 transition-colors hover:bg-hover/50">
                  <span className="relative flex justify-center pt-1.5">
                    <StatusDot status={d.status} kind="deployment" />
                    {i < deployments.length - 1 && <span aria-hidden className="absolute top-5 -bottom-5 w-px bg-line" />}
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-fg">
                        {d.commitMessage || (d.trigger === "rollback" ? "Rollback" : d.trigger === "create" ? "Initial deployment" : "Deployment")}
                      </span>
                      {d.preview && <Badge tone="info">PR #{d.preview.pr}</Badge>}
                      {current && <Badge tone="ok">{d.preview ? "Live" : "Current"}</Badge>}
                      {d.trigger === "rollback" && <Badge tone="info">Rollback</Badge>}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                      {d.status !== "success" && (
                        <span className={cn(d.status === "failed" && "text-bad", active && "text-info", d.status === "waiting" && "text-warn")}>
                          {statusText(d.status, "deployment")}
                        </span>
                      )}
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
                      {duration && <span className="tabular-nums">Took {duration}</span>}
                    </span>
                    {d.status === "failed" && d.error && <span className="line-clamp-1 text-xs text-bad/90">{d.error.split("\n")[0]}</span>}
                    {d.status === "cancelled" && d.error && <span className="line-clamp-1 text-xs text-muted">{d.error.split("\n")[0]}</span>}
                  </span>
                  <span className="flex items-start gap-1 text-xs text-faint">
                    <TimeAgo date={d.createdAt} className="pt-0.5" />
                  </span>
                </Link>
                {d.status === "waiting" && can("deploys.approve") && (
                  // Out of the link, so the buttons act instead of opening the deployment.
                  <div className="flex justify-end gap-2 px-5 pb-3.5 pl-[52px]">
                    <Button size="sm" variant="ghost" onClick={() => reject.run(d.id)} loading={reject.pending} disabled={approve.pending}>
                      <Ban /> Reject
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => approve.run(d.id)} loading={approve.pending} disabled={reject.pending}>
                      <Check /> Approve
                    </Button>
                  </div>
                )}
                {can("services.deploy") && (
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
                            {type === "app" && !d.preview && d.status === "success" && !current && d.image && (
                              <MenuItem
                                onClick={async () => {
                                  if (
                                    await confirm({
                                      title: "Roll back to this deployment?",
                                      description: "The image from this deployment is started again without rebuilding. Current variables are used.",
                                      confirmLabel: "Roll back",
                                    })
                                  ) {
                                    target.current = serviceId;
                                    void rollback.run(d.id);
                                  }
                                }}
                              >
                                <RotateCcw /> Roll back to this
                              </MenuItem>
                            )}
                            <MenuItem
                              onClick={async () => {
                                if (
                                  !(await confirm({
                                    title: "Redeploy?",
                                    description: "Deploys again with the current settings. It takes over once it is healthy; if it fails, the running version stays.",
                                    confirmLabel: "Redeploy",
                                  }))
                                )
                                  return;
                                target.current = d.preview?.id ?? serviceId;
                                void redeploy.run(d.id);
                              }}
                            >
                              <RefreshCw /> Redeploy
                            </MenuItem>
                          </>
                        )}
                      </MenuContent>
                    </Menu>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
