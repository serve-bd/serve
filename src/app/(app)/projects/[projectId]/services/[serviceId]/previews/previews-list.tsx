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
import type { PreviewRow } from "./data";
import { NewImagePreviewDialog, OpenPullRequestsDialog } from "./preview-dialogs";

type Preview = PreviewRow;

export function PreviewsList(props: {
  projectId: string;
  serviceId: string;
  enabled: boolean;
  /** Apps deployed from an image: previews are started by hand, each with its own tag. */
  image: string | null;
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
  const redeploy = useAction((id: string) => deployService(id), { onSuccess: (d) => router.push(`${base}/${lastId.current}/deployments/${d.id}`) });
  const remove = useAction((id: string) => removePreviewService(id));
  const settings = `${base}/${props.serviceId}/settings/previews`;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Pull request previews"
        description={
          props.image
            ? props.enabled
              ? `Each preview runs another tag of the image with its own address${props.previewDomain ? `, like ${props.previewDomain.replace("{pr}", "12")} for #12` : ""}.`
              : "Preview deployments are off. Turn them on to run other tags of the image, each at its own address."
            : props.enabled
              ? `Every open pull request runs here with its own address${props.previewDomain ? `, like ${props.previewDomain.replace("{pr}", "12")} for pull request #12` : ""}. A preview is removed when its pull request closes.`
              : "Preview deployments are off. Turn them on to deploy every pull request to its own address."
        }
        actions={
          (props.canManage || (props.canDeploy && props.enabled)) && (
            <div className="flex items-center gap-2">
              {props.canDeploy &&
                props.enabled &&
                (props.image ? (
                  <NewImagePreviewDialog serviceId={props.serviceId} image={props.image} base={base} />
                ) : (
                  <OpenPullRequestsDialog serviceId={props.serviceId} base={base} />
                ))}
              {props.canManage && (
                <Link href={settings} className={buttonVariants({ size: "sm", variant: props.canDeploy && props.enabled ? "ghost" : "secondary" })}>
                  <Settings /> Settings
                </Link>
              )}
            </div>
          )
        }
      />
      {props.previews.length === 0 ? (
        <EmptyState
          icon={<GitPullRequest />}
          title="No open previews"
          description={
            !props.enabled
              ? "Turn on preview deployments in Settings → Previews."
              : props.image
                ? "Start one with New preview, from a tag your CI pushed."
                : "Open a pull request on the repository to create one, or deploy one that is already open."
          }
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
                              description: `Its container${p.database ? ", its database copy" : ""} and its address are removed.${props.image ? "" : " A new push to the pull request creates it again."}`,
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

/** The Overview card of an app: its open previews, linking to the Previews tab. */
export function PreviewsCard({ projectId, serviceId, previews }: { projectId: string; serviceId: string; previews: Preview[] }) {
  const base = `/projects/${projectId}/services`;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Previews"
        actions={
          <Link href={`${base}/${serviceId}/previews`} className={buttonVariants({ size: "sm", variant: "ghost" })}>
            All
          </Link>
        }
      />
      {previews.length === 0 ? (
        <p className="px-5 pb-4 text-[13px] text-muted">No open pull requests. Each new one gets a preview here.</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {previews.slice(0, 5).map((p) => {
            const busy = !!p.deployment && ["queued", "building", "deploying"].includes(p.deployment.status);
            return (
              <li key={p.id} className="flex min-w-0 items-center gap-2.5 px-5 py-2.5">
                <StatusDot status={busy ? p.deployment!.status : p.status} kind={busy ? "deployment" : "service"} />
                <Link href={`${base}/${p.id}`} className="flex-none text-[13px] font-medium text-fg hover:underline">
                  PR #{p.pr}
                </Link>
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-xs text-accent hover:underline">
                    {p.url.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  <span className="min-w-0 truncate text-xs text-muted">{p.deployment?.title ?? p.branch}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
