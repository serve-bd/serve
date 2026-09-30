"use client";

import * as React from "react";
import { ChevronDown, FileCode2 } from "lucide-react";
import { CodeEditor } from "@/components/code-editor";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CopyButton, Skeleton, TimeAgo } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { deployedCompose } from "@/server/actions/services";

type Deployed = { content: string; writtenAt: string } | null;

/** Read-only view of the compose file Serve actually runs, next to the one the user edits. */
export function DeployedCompose({ serviceId }: { serviceId: string }) {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<Deployed | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    void deployedCompose(serviceId).then((res) => {
      if (!alive) return;
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
    return () => {
      alive = false;
    };
  }, [open, serviceId]);

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <FileCode2 className="size-4 text-muted" /> Deployed file
          </span>
        }
        description="What runs: your file plus its labels, networks, private hostnames and ports. Variable values stay in a separate .env file."
        actions={
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? "Hide" : "Show"} <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
          </Button>
        }
      />
      {open && (
        <CardBody className="flex flex-col gap-3 py-4">
          {error ? (
            <p className="text-[13px] text-bad">{error}</p>
          ) : data === undefined ? (
            <Skeleton className="h-64" />
          ) : data === null ? (
            <p className="text-[13px] text-muted">Nothing deployed yet. Deploy the stack to see the file that runs.</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 text-xs text-muted">
                <span>
                  Written <TimeAgo date={data.writtenAt} /> by the last deployment
                </span>
                <CopyButton value={data.content} />
              </div>
              <CodeEditor value={data.content} readOnly minRows={14} maxHeight="40rem" aria-label="Deployed compose file" />
            </>
          )}
        </CardBody>
      )}
    </Card>
  );
}
