"use client";

import type * as React from "react";
import Link from "next/link";
import useSWR from "swr";
import { RotateCw, ScrollText, SquareTerminal } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Badge, CopyButton, Skeleton, TimeAgo, Copyable } from "@/components/ui/misc";
import { StatusDot } from "@/components/ui/status";
import { useAction } from "@/hooks/use-action";
import { useCan } from "@/components/permissions";
import { cn, formatBytes } from "@/lib/utils";
import { restartContainer } from "@/server/actions/services";
import type { ContainerDetails } from "@/server/services/container-info";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as ContainerDetails;
};

/** Details of one container: state, health, resources, network, ports, mounts, and quick actions. */
export function ContainerDialog({
  serviceId,
  base,
  containerId,
  onOpenChange,
}: {
  serviceId: string;
  /** /projects/<p>/services/<s> */
  base: string;
  containerId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const can = useCan();
  const { data, error, isLoading, mutate } = useSWR(containerId ? `/api/services/${serviceId}/containers/${containerId}` : null, fetcher, { refreshInterval: 5000 });
  const restart = useAction(() => restartContainer(serviceId, containerId!), { success: "Container restarted", onSuccess: () => mutate() });
  const d = data?.id.startsWith(containerId ?? "-") ? data : undefined;
  const key = d?.composeService ?? d?.name;

  return (
    <Dialog open={!!containerId} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title={
            <span className="flex items-center gap-2.5">
              {d && <StatusDot status={d.state === "running" ? (d.health?.status === "unhealthy" ? "failed" : "running") : d.state === "restarting" ? "restarting" : "stopped"} />}
              <span className="truncate font-mono text-[16px]">{key ?? "Container"}</span>
            </span>
          }
          description={d ? <span className="font-mono text-[12px]">{d.image}</span> : undefined}
        />
        <DialogBody className="max-h-[65vh] gap-5 overflow-y-auto [&>*]:shrink-0">
          {error && !d && <p className="rounded-xl border border-bad/20 bg-bad-soft px-3 py-2 text-[13px] text-fg-2">{(error as Error).message}</p>}
          {isLoading && !d && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-16" />
              <Skeleton className="h-24" />
              <Skeleton className="h-20" />
            </div>
          )}
          {d && (
            <>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
                <Tile
                  label="State"
                  value={<span className="capitalize">{d.health ? `${d.state} · ${d.health.status}` : d.state}</span>}
                  tone={d.state !== "running" || d.health?.status === "unhealthy" ? "bad" : undefined}
                />
                <Tile label={d.startedAt ? "Up since" : "Stopped"} value={d.startedAt ? <TimeAgo date={d.startedAt} /> : d.finishedAt ? <TimeAgo date={d.finishedAt} /> : "—"} />
                <Tile label="Restarts" value={String(d.restarts)} tone={d.restarts > 2 ? "warn" : undefined} />
                <Tile label="CPU · Memory" value={d.resources ? `${d.resources.cpu.toFixed(1)}% · ${formatBytes(d.resources.memory)}` : "—"} />
              </div>

              {(d.exitCode !== null || d.oomKilled || d.error) && (
                <p className="rounded-xl border border-bad/20 bg-bad-soft px-3 py-2 text-[13px] text-fg-2">
                  {d.oomKilled ? "Killed because it ran out of memory. " : ""}
                  {d.exitCode !== null ? `Exited with code ${d.exitCode}. ` : ""}
                  {d.error ?? ""}
                </p>
              )}

              {d.health?.last && (
                <Group title="Last health check">
                  <div className="flex flex-col gap-1.5 px-4 py-3">
                    <p className="text-xs text-muted">
                      Exit code {d.health.last.exitCode} · <TimeAgo date={d.health.last.at} />
                      {d.health.failingStreak > 0 && ` · ${d.health.failingStreak} failed in a row`}
                    </p>
                    {d.health.last.output && (
                      <Copyable value={d.health.last.output}>
                        <pre className="max-h-32 overflow-auto rounded-lg bg-sunken py-2 pr-9 pl-3 font-mono text-[12px] whitespace-pre-wrap text-fg-2">{d.health.last.output}</pre>
                      </Copyable>
                    )}
                  </div>
                </Group>
              )}

              <Group title="Network">
                {d.networks.map((n) => (
                  <Row key={n.name} label={<span className="font-mono text-[12px]">{n.name}</span>}>
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      {n.ip && <span className="font-mono text-[12px] text-fg-2">{n.ip}</span>}
                      {n.aliases.map((a) => (
                        <Badge key={a} className="font-mono">
                          {a}
                        </Badge>
                      ))}
                    </span>
                  </Row>
                ))}
                {d.ports.length > 0 && (
                  <Row label="Ports">
                    <span className="flex flex-wrap justify-end gap-1.5">
                      {d.ports.map((p) => (
                        <Badge key={p.container} className="font-mono">
                          {p.published.length ? `${p.published.join(", ")} → ${p.container}` : p.container}
                        </Badge>
                      ))}
                    </span>
                  </Row>
                )}
              </Group>

              {d.mounts.length > 0 && (
                <Group title="Storage">
                  {d.mounts.map((m) => (
                    <Row key={m.destination} label={<span className="font-mono text-[12px]">{m.destination}</span>}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-[12px] text-muted">{m.source}</span>
                        <Badge>{m.type === "volume" ? "Volume" : m.type === "bind" ? "Host path" : m.type}</Badge>
                        {m.readOnly && <Badge>Read only</Badge>}
                      </span>
                    </Row>
                  ))}
                </Group>
              )}

              <Group title="Process">
                {d.command && (
                  <Row label="Command">
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate font-mono text-[12px] text-fg-2" title={d.command}>
                        {d.command}
                      </span>
                      <CopyButton value={d.command} className="size-6 flex-none" />
                    </span>
                  </Row>
                )}
                {d.workingDir && <Row label="Working directory">{<span className="font-mono text-[12px] text-fg-2">{d.workingDir}</span>}</Row>}
                {d.user && <Row label="User">{<span className="font-mono text-[12px] text-fg-2">{d.user}</span>}</Row>}
                <Row label="Restart policy">
                  <span className="text-[13px] text-fg-2">{d.restartPolicy}</span>
                </Row>
                <Row label="Environment">
                  <span className="text-right text-[13px] text-fg-2" title={d.envKeys.join(", ")}>
                    {d.envKeys.length} variables · values hidden
                  </span>
                </Row>
                <Row label="Container ID">
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-[12px] text-fg-2">{d.id.slice(0, 12)}</span>
                    <CopyButton value={d.id} />
                  </span>
                </Row>
                <Row label="Created">
                  <TimeAgo date={d.createdAt} className="text-[13px] text-fg-2" />
                </Row>
              </Group>
            </>
          )}
        </DialogBody>
        <DialogFooter className="sm:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row">
            {can("logs.view") && (
              <Link
                href={`${base}/logs${d?.composeService ? `?container=${encodeURIComponent(d.composeService)}` : ""}`}
                className={buttonVariants({ size: "sm" })}
                onClick={() => onOpenChange(false)}
              >
                <ScrollText /> Logs
              </Link>
            )}
            {d?.state === "running" && can("console.access") && (
              <Link
                href={`${base}/console${d.composeService ? `?container=${encodeURIComponent(d.composeService)}` : ""}`}
                className={buttonVariants({ size: "sm" })}
                onClick={() => onOpenChange(false)}
              >
                <SquareTerminal /> Console
              </Link>
            )}
          </div>
          {can("services.deploy") && (
            <Button size="sm" onClick={() => restart.run()} loading={restart.pending} disabled={!d}>
              <RotateCw /> Restart container
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "bad" | "warn" }) {
  return (
    <div className="flex flex-col gap-0.5 bg-surface px-3.5 py-3">
      <span className="text-[11px] text-faint">{label}</span>
      <span className={cn("truncate text-[14px] font-medium text-fg tabular-nums", tone === "bad" && "text-bad", tone === "warn" && "text-warn")}>{value}</span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[12px] font-medium tracking-wide text-faint uppercase">{title}</h3>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="flex-none text-[13px] text-muted">{label}</span>
      <span className="flex min-w-0 justify-end">{children}</span>
    </div>
  );
}
