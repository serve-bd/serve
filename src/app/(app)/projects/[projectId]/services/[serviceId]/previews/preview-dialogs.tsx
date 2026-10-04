"use client";

import * as React from "react";
import { ExternalLink, GitBranch, GitFork, GitPullRequest, Loader2, Plus, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TimeAgo } from "@/components/ui/misc";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { imageWithTag } from "@/lib/preview-image";
import { deployImagePreview, deployPullRequestPreview, listOpenPullRequests } from "@/server/actions/services";

type OpenPr = {
  number: number;
  title: string | null;
  branch: string;
  author: string | null;
  fork: boolean;
  url: string | null;
  updatedAt: string | null;
  previewId: string | null;
};

/** Lists the repository's open pull requests, to deploy previews of ones opened before previews were on. */
export function OpenPullRequestsDialog({ serviceId, base }: { serviceId: string; base: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [prs, setPrs] = React.useState<OpenPr[] | null>(null);
  const [deploying, setDeploying] = React.useState<number | null>(null);
  const load = useAction(() => listOpenPullRequests(serviceId), { refresh: false, onSuccess: setPrs });
  const deploy = useAction((n: number) => deployPullRequestPreview(serviceId, n), {
    onSuccess: (r) => {
      setOpen(false);
      // A preview with a database copy deploys once the copy is ready: its page shows that.
      router.push(r.deploymentId ? `${base}/${r.previewId}/deployments/${r.deploymentId}` : `${base}/${r.previewId}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        onClick={() => {
          setPrs(null);
          setOpen(true);
          void load.run();
        }}
      >
        <GitPullRequest /> Open pull requests
      </Button>
      <DialogContent size="lg">
        <DialogHeader
          title="Open pull requests"
          description="Previews start on their own for new pull requests. Deploy the ones that were open before previews were turned on, or deploy one again."
        />
        <DialogBody className="max-h-[60vh] overflow-y-auto">
          {prs === null ? (
            load.pending ? (
              <p className="flex items-center gap-2 py-6 text-[13px] text-muted">
                <Loader2 className="size-4 animate-spin" /> Reading the repository&apos;s pull requests…
              </p>
            ) : null
          ) : prs.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted">The repository has no open pull requests.</p>
          ) : (
            <ul className="-my-1 flex flex-col divide-y divide-line">
              {prs.map((pr) => (
                <li key={pr.number} className="flex items-center gap-3 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2 text-[13px]">
                      <span className="flex-none font-semibold text-fg">#{pr.number}</span>
                      <span className="truncate text-fg-2">{pr.title}</span>
                      {pr.url && (
                        <a href={pr.url} target="_blank" rel="noreferrer" className="flex-none text-muted hover:text-fg" aria-label={`Open pull request #${pr.number}`}>
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <GitBranch className="size-3 flex-none" /> <span className="truncate">{pr.branch}</span>
                      </span>
                      {pr.author && <span>{pr.author}</span>}
                      {pr.updatedAt && (
                        <span>
                          updated <TimeAgo date={pr.updatedAt} />
                        </span>
                      )}
                    </span>
                  </div>
                  {pr.fork ? (
                    <span className="inline-flex flex-none items-center gap-1 text-xs text-muted" title="Code from a fork would run with this app's variables.">
                      <GitFork className="size-3.5" /> From a fork
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant={pr.previewId ? "secondary" : "primary"}
                      loading={deploy.pending && deploying === pr.number}
                      disabled={deploy.pending}
                      onClick={() => {
                        setDeploying(pr.number);
                        void deploy.run(pr.number);
                      }}
                    >
                      <Rocket /> {pr.previewId ? "Deploy again" : "Deploy preview"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** Starts (or updates) the preview of an image app: a pull request number and the image tag it runs. */
export function NewImagePreviewDialog({ serviceId, image, base }: { serviceId: string; image: string; base: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pr, setPr] = React.useState("");
  const [tag, setTag] = React.useState("");
  const ref = tag.trim() ? imageWithTag(image, tag) : null;
  const number = Number(pr);
  const valid = Number.isInteger(number) && number > 0 && !!ref;
  const deploy = useAction(() => deployImagePreview(serviceId, { pr: number, tag }), {
    onSuccess: (r) => {
      setOpen(false);
      router.push(r.deploymentId ? `${base}/${r.previewId}/deployments/${r.deploymentId}` : `${base}/${r.previewId}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        onClick={() => {
          setPr("");
          setTag("");
          setOpen(true);
        }}
      >
        <Plus /> New preview
      </Button>
      <DialogContent size="md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void deploy.run();
          }}
        >
          <DialogHeader
            title="New preview"
            description="Run another tag of this app's image next to it, with its own address. Your CI pushes the tag; the number names the preview."
          />
          <DialogBody>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[8rem_1fr]">
              <Field label="Pull request">
                <Input value={pr} onChange={(e) => setPr(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="12" autoFocus />
              </Field>
              <Field label="Image tag">
                <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder={pr ? `pr-${pr}` : "pr-12"} className="font-mono" autoComplete="off" spellCheck={false} />
              </Field>
            </div>
            <p className="min-w-0 truncate rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-fg-2" title={ref ?? undefined}>
              {ref ?? (tag.trim() ? "Use a tag like pr-12 or a digest like sha256:…" : imageWithTag(image, pr ? `pr-${pr}` : "pr-12"))}
            </p>
            <p className="text-xs leading-relaxed text-muted">The same number again deploys the new tag to that preview. Remove a preview from its menu when you are done.</p>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={deploy.pending} disabled={!valid}>
              <Rocket /> Deploy preview
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
