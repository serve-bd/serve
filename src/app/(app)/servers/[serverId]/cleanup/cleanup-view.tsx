"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Brush, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import { runCleanup } from "@/server/actions/server";
import type { CleanupRun } from "@/server/settings";
import { cn, formatBytes } from "@/lib/utils";

type Usage = {
  images: { count: number; size: number; unused: number };
  containers: { count: number; size: number };
  volumes: { count: number; size: number };
  buildCache: { count: number; size: number };
} | null;

type AutoSettings = {
  cleanupEnabled: boolean;
  cleanupIntervalHours: number;
  cleanupDiskThreshold: number;
  cleanupBuildCacheDays: number;
  cleanupUnusedImages: boolean;
};

const triggerLabel: Record<CleanupRun["trigger"], { label: string; tone: "neutral" | "accent" | "warn" }> = {
  schedule: { label: "Scheduled", tone: "neutral" },
  manual: { label: "Manual", tone: "accent" },
  disk: { label: "Low disk", tone: "warn" },
};

function duration(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function CleanupView({
  serverId,
  usage,
  disk,
  history,
  lastAt,
  settings,
}: {
  serverId: string;
  usage: Usage;
  disk: { total: number; used: number } | null;
  history: CleanupRun[];
  lastAt: string | null;
  settings: AutoSettings;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [waitingSince, setWaitingSince] = React.useState<string | null | undefined>(undefined);
  const start = useAction(runCleanup, { refresh: false });

  // Poll until the worker records a new run, then report what it freed.
  React.useEffect(() => {
    if (waitingSince === undefined) return;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > 90_000) {
        clearInterval(t);
        setWaitingSince(undefined);
        toast.error("Cleanup is taking longer than expected. Check that the worker is running.");
        return;
      }
      router.refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [waitingSince, router]);

  const latest = history[0];
  React.useEffect(() => {
    if (waitingSince === undefined || !latest || latest.at === waitingSince) return;
    // A new run arrived: stop waiting on the next tick to avoid a synchronous state update.
    const t = setTimeout(() => {
      setWaitingSince(undefined);
      if (latest.error) toast.error(`Cleanup failed: ${latest.error}`);
      else toast.success(latest.reclaimed > 0 ? `Freed ${formatBytes(latest.reclaimed)}` : "Cleanup finished. Nothing to free.");
    }, 0);
    return () => clearTimeout(t);
  }, [latest, waitingSince]);

  const running = waitingSince !== undefined || start.pending;
  const percent = disk && disk.total ? (disk.used / disk.total) * 100 : null;
  const over = percent !== null && percent >= settings.cleanupDiskThreshold;

  return (
    <>
      <Card>
        <CardHeader
          title="Storage"
          description="Disk usage of Serve's data directory and Docker on this server."
          actions={
            <Button
              size="sm"
              variant="primary"
              loading={running}
              onClick={async () => {
                const ok = await confirm({
                  title: "Clean up Docker now?",
                  confirmLabel: "Clean up",
                  description: (
                    <span className="flex flex-col gap-2">
                      <span>This removes:</span>
                      <span className="flex flex-col gap-1 pl-3 text-fg-2">
                        <span>• Dangling images and stopped containers from old Serve deployments</span>
                        <span>
                          • Build cache
                          {settings.cleanupBuildCacheDays > 0 ? ` older than ${settings.cleanupBuildCacheDays} day${settings.cleanupBuildCacheDays === 1 ? "" : "s"}` : " (skipped: set to keep)"}
                        </span>
                        <span>• Dangling images on the whole host</span>
                        {settings.cleanupUnusedImages && <span>• Images no container uses (except Serve&apos;s rollback images)</span>}
                        <span>• Old jobs, metrics and activity records</span>
                      </span>
                      <span>Volumes and running containers are never touched.</span>
                    </span>
                  ),
                });
                if (!ok) return;
                const since = lastAt;
                const res = await start.run(serverId);
                if (res !== undefined) setWaitingSince(since);
              }}
            >
              <Brush /> Clean up now
            </Button>
          }
        />
        {percent !== null && disk && (
          <div className="flex flex-col gap-2 border-b border-line px-5 py-4">
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="text-muted">Data disk</span>
              <span className="tabular-nums text-fg-2">
                <span className={cn("font-semibold", over ? "text-warn" : "text-fg")}>{formatBytes(disk.used)}</span> of {formatBytes(disk.total)} · {Math.round(percent)}%
              </span>
            </div>
            <div className="relative h-2 rounded-full bg-sunken">
              <div className={cn("h-full rounded-full transition-[width]", over ? "bg-warn" : "bg-accent")} style={{ width: `${Math.min(100, percent)}%` }} />
              <div
                className="absolute -top-1 -bottom-1 w-px bg-fg/50"
                style={{ left: `${settings.cleanupDiskThreshold}%` }}
                title={`Automatic cleanup at ${settings.cleanupDiskThreshold}%`}
              />
            </div>
            <p className="text-[11.5px] text-faint">
              {over ? "Above the cleanup threshold. " : ""}The marker shows where an automatic cleanup starts ({settings.cleanupDiskThreshold}%).
            </p>
          </div>
        )}
        {usage ? (
          <div className="grid grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
            {[
              ["Images", usage.images.size, `${usage.images.count} images · ${usage.images.unused} unused`],
              ["Build cache", usage.buildCache.size, `${usage.buildCache.count} entries`],
              ["Volumes", usage.volumes.size, `${usage.volumes.count} volumes`],
              ["Containers", usage.containers.size, `${usage.containers.count} containers`],
            ].map(([label, size, sub]) => (
              <div key={String(label)} className="flex min-w-0 flex-col gap-1 px-5 py-4">
                <span className="text-xs text-muted">{label}</span>
                <span className="text-[18px] font-semibold text-fg tabular-nums">{formatBytes(Number(size))}</span>
                <span className="truncate text-[11px] text-faint">{sub}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-5 py-4 text-[13px] text-muted">Docker is not reachable.</p>
        )}
      </Card>


      <Card>
        <CardHeader
          title="History"
          description={
            <>
              Recent cleanup runs on this server. Change the schedule in{" "}
              <Link href="/settings/advanced" className="text-accent hover:underline">
                Settings
              </Link>
              .
            </>
          }
        />
        {history.length === 0 ? (
          <EmptyState icon={<History />} title="No cleanups yet" description="Runs appear here after the first scheduled or manual cleanup." />
        ) : (
          <div className="divide-y divide-line">
            {history.map((r) => (
              <div key={r.at} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-[13px]">
                <Badge tone={r.error ? "bad" : triggerLabel[r.trigger].tone}>{r.error ? "Failed" : triggerLabel[r.trigger].label}</Badge>
                <TimeAgo date={r.at} className="text-fg-2" />
                <span className="ml-auto flex items-center gap-3 tabular-nums">
                  <span className={cn("font-medium", r.reclaimed > 0 ? "text-fg" : "text-muted")}>{r.reclaimed > 0 ? `${formatBytes(r.reclaimed)} freed` : "Nothing freed"}</span>
                  <span className="text-faint">{duration(r.durationMs)}</span>
                </span>
                {r.error && <p className="w-full truncate text-xs text-bad">{r.error}</p>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
