import Link from "next/link";
import { CircleCheck, HeartPulse } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { incidentRows, orgMonitors } from "@/server/monitoring/queries";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Badge, Card, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { formatUptime, UptimeBars } from "@/components/uptime-bars";
import { uptimePercent } from "@/server/monitoring/state";
import { cn } from "@/lib/utils";
import { duration } from "@/lib/duration";

export const metadata = { title: "Monitoring" };

const statusTone = { up: "text-ok", down: "text-bad", pending: "text-muted", paused: "text-faint" } as const;
const statusText = { up: "Up", down: "Down", pending: "Checking", paused: "Paused" } as const;

export default async function MonitoringPage() {
  const ctx = await requireOrg();
  // Server incidents (disk, memory, CPU) belong to the Root organization.
  const [allMonitors, allOpen, allRecent] = await Promise.all([
    orgMonitors(ctx.org.id),
    incidentRows({ organizationId: ctx.org.id, openOnly: true, limit: 50 }),
    incidentRows({ organizationId: ctx.org.id, limit: 30 }),
  ]);
  // Members limited to some projects only see those projects' checks and incidents.
  const reach = (projectId: string | null | undefined) => !projectId || ctx.canAccessProject(projectId);
  const monitors = allMonitors.filter((m) => reach(m.projectId));
  const open = allOpen.filter((i) => reach(i.projectId));
  const recent = allRecent.filter((i) => reach(i.projectId));
  const resolved = recent.filter((i) => i.resolvedAt);
  const link = (i: (typeof open)[number]) => (i.serviceId && i.projectId ? `/projects/${i.projectId}/services/${i.serviceId}` : i.serverId ? `/servers/${i.serverId}` : null);

  return (
    <>
      <PageHeader title="Monitoring" description="Uptime of your services, open incidents and alerts about servers." />
      <PageBody className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Open incidents" description={open.length ? `${open.length} ongoing` : "Everything is running."} />
          {open.length === 0 ? (
            <div className="flex items-center gap-2.5 px-5 py-4 text-[13px] text-fg-2">
              <CircleCheck className="size-4 text-ok" /> No open incidents.
            </div>
          ) : (
            <div className="divide-y divide-line">
              {open.map((i) => {
                const href = link(i);
                const body = (
                  <div key={i.id} className="flex items-start gap-3 px-5 py-3">
                    <span className={cn("mt-1.5 size-2 flex-none rounded-full", i.severity === "warning" ? "bg-warn" : "bg-bad")} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-fg">{i.title}</p>
                      {i.detail && <p className="text-xs leading-relaxed text-muted">{i.detail}</p>}
                    </div>
                    <div className="flex flex-none flex-col items-end gap-1 text-xs text-muted">
                      <Badge tone={i.severity === "warning" ? "warn" : "bad"}>{i.kind === "resource" ? "Server" : i.kind === "crashloop" ? "Restarting" : "Down"}</Badge>
                      <span>for {duration(i.startedAt, new Date().toISOString())}</span>
                    </div>
                  </div>
                );
                return href ? (
                  <Link key={i.id} href={href} className="block transition-colors hover:bg-hover/50">
                    {body}
                  </Link>
                ) : (
                  <div key={i.id}>{body}</div>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Uptime checks" description="Last 30 days. Set a check up in a service's Settings → Monitoring." />
          {monitors.length === 0 ? (
            <EmptyState icon={<HeartPulse />} title="No checks yet" description="Open a service, go to Settings → Monitoring and turn on its uptime check." />
          ) : (
            <div className="divide-y divide-line">
              {monitors.map((m) => (
                <Link
                  key={m.serviceId}
                  href={`/projects/${m.projectId}/services/${m.serviceId}`}
                  className="grid grid-cols-1 items-center gap-x-5 gap-y-2 px-5 py-3 transition-colors hover:bg-hover/50 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_5rem_5rem]"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-medium text-fg">{m.serviceName}</span>
                    <span className="truncate text-xs text-muted">{m.projectName}</span>
                  </span>
                  <UptimeBars bars={m.bars} height={22} />
                  <span className="text-right text-[13px] text-fg-2 tabular-nums">{formatUptime(uptimePercent(m.bars))}</span>
                  <span className={cn("text-right text-[13px] font-medium", statusTone[m.enabled ? m.status : "paused"])}>{statusText[m.enabled ? m.status : "paused"]}</span>
                </Link>
              ))}
            </div>
          )}
        </Card>

        {resolved.length > 0 && (
          <Card>
            <CardHeader title="Recent incidents" />
            <div className="divide-y divide-line">
              {resolved.map((i) => (
                <div key={i.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                  <span className="size-1.5 flex-none rounded-full bg-idle" />
                  <span className="min-w-0 flex-1 truncate text-fg-2">{i.title}</span>
                  <span className="hidden flex-none text-xs text-muted sm:inline">{duration(i.startedAt, i.resolvedAt!)}</span>
                  <span className="flex-none text-xs text-faint">
                    <TimeAgo date={i.startedAt} />
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </PageBody>
    </>
  );
}
