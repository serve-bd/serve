"use client";

import * as React from "react";
import Link from "next/link";
import { Database, ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest, MoreHorizontal, RefreshCw, ScrollText, Settings, Trash2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Badge, Card, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { StatusDot, statusText } from "@/components/ui/status";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { deployService, removePreviewService } from "@/server/actions/services";
import { cn } from "@/lib/utils";

type Preview = {
  id: string;
  pr: number;
  status: string;
  branch: string | null;
  url: string | null;
  createdAt: string;
  database: boolean;
  deployment: { id: string; status: string; title: string | null; sha: string | null; createdAt: string } | null;
};

export function PreviewsList(props: {
  projectId: string;
  serviceId: string;
  enabled: boolean;
  previewDomain: string | null;
  canManage: boolean;
  canDeploy: boolean;
  previews: Preview[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const base = `/projects/${props.projectId}/services`;
  // The preview a redeploy was started for, to open its deployment.
  const lastId = React.useRef("");
  const redeploy = useAction((id: string) => deployService(id), { success: "Deployment queued", onSuccess: (d) => router.push(`${base}/${lastId.current}/deployments/${d.id}`) });
  const remove = useAction((id: string) => removePreviewService(id), { success: "Preview removed" });
  const settings = `${base}/${props.serviceId}/settings/previews`;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Pull request previews"
        description={
          props.enabled
            ? `Every open pull request runs here with its own address${props.previewDomain ? `, like ${props.previewDomain.replace("{pr}", "12")} for pull request #12` : ""}. A preview is removed when its pull request closes.`
            : "Preview deployments are off. Turn them on to deploy every pull request to its own address."
        }
        actions={
          props.canManage && (
            <Link href={settings} className={buttonVariants({ size: "sm" })}>
              <Settings /> Settings
            </Link>
          )
        }
      />
      {props.previews.length === 0 ? (
        <EmptyState
          icon={<GitPullRequest />}
          title="No open previews"
          description={props.enabled ? "Open a pull request on the repository to create one." : "Turn on preview deployments in Settings → Previews."}
        />
      ) : (
        <ul className="divide-y divide-line">
          {props.previews.map((p) => {
            const d = p.deployment;
            const busy = !!d && ["queued", "building", "deploying"].includes(d.status);
            return (
              <li key={p.id} className="flex items-start gap-3 px-5 py-4">
                <span className="pt-1.5">
                  <StatusDot status={busy ? d.status : p.status} kind={busy ? "deployment" : "service"} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <Link href={`${base}/${p.id}`} className="text-[14px] font-semibold text-fg hover:underline">
                      PR #{p.pr}
                    </Link>
                    <span className={cn("text-xs", busy ? "text-info" : p.status === "crashed" || d?.status === "failed" ? "text-bad" : "text-muted")}>
                      {busy ? statusText(d.status, "deployment") : d?.status === "failed" ? "Last deploy failed" : statusText(p.status)}
                    </span>
                    {p.database && (
                      <Badge>
                        <Database /> Database copy
                      </Badge>
                    )}
                  </span>
                  {d?.title && <span className="truncate text-[13px] text-fg-2">{d.title}</span>}
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                    {p.branch && (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <GitBranch className="size-3 flex-none" /> <span className="truncate">{p.branch}</span>
                      </span>
                    )}
                    {d?.sha && (
                      <span className="inline-flex items-center gap-1 font-mono">
                        <GitCommitHorizontal className="size-3" /> {d.sha.slice(0, 7)}
                      </span>
                    )}
                    <span>
                      {d ? "deployed " : "opened "}
                      <TimeAgo date={d?.createdAt ?? p.createdAt} />
                    </span>
                  </span>
                  {p.url && (
                    <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex w-fit max-w-full items-center gap-1 text-[13px] text-accent hover:underline">
                      <span className="truncate">{p.url.replace(/^https?:\/\//, "")}</span> <ExternalLink className="size-3 flex-none" />
                    </a>
                  )}
                </div>
                <Menu>
                  <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label={`Actions for PR #${p.pr}`}>
                    <MoreHorizontal className="size-4" />
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onClick={() => router.push(`${base}/${p.id}/logs`)}>
                      <ScrollText /> Logs
                    </MenuItem>
                    <MenuItem onClick={() => router.push(`${base}/${p.id}/deployments`)}>
                      <GitCommitHorizontal /> Deployments
                    </MenuItem>
                    {props.canDeploy && (
                      <MenuItem
                        disabled={busy}
                        onClick={() => {
                          lastId.current = p.id;
                          void redeploy.run(p.id);
                        }}
                      >
                        <RefreshCw /> Redeploy
                      </MenuItem>
                    )}
                    {props.canManage && (
                      <MenuItem
                        danger
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Remove the preview of PR #${p.pr}?`,
                              description: `Its container${p.database ? ", its database copy" : ""} and its address are removed. A new push to the pull request creates it again.`,
                              confirmLabel: "Remove preview",
                              danger: true,
                            })
                          )
                            void remove.run(p.id);
                        }}
                      >
                        <Trash2 /> Remove preview
                      </MenuItem>
                    )}
                  </MenuContent>
                </Menu>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
