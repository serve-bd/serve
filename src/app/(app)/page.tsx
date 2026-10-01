import Link from "next/link";
import { asc, sql } from "drizzle-orm";
import { AlertTriangle, Blocks, Plus, Rocket } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { metricSeries, serverScope } from "@/server/metrics";
import { projectSummaries, recentDeployments } from "@/server/queries";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui/misc";
import { StatusDot, statusText } from "@/components/ui/status";
import { serverReachable } from "@/lib/server-services";
import { DeployTimeline } from "./_components/deploy-timeline";
import { ProjectRow, RackPanel, ServerRow } from "./_components/racks";
import { listedServerIds, viewableServerIds } from "@/server/servers/access";

/** Server cards: full for servers the user manages; for the others only this organization's services and no address. */
async function serverCards(ids: string[], managed: Set<string>, organizationId: string) {
  const rows = await db
    .select({
      id: schema.server.id,
      name: schema.server.name,
      host: schema.server.host,
      isLocal: schema.server.isLocal,
      status: schema.server.status,
      metricsEnabled: schema.server.metricsEnabled,
      services: sql<number>`(select count(*)::int from service s where s.server_id = "server"."id")`,
      running: sql<number>`(select count(*)::int from service s where s.server_id = "server"."id" and s.status = 'running')`,
      ownServices: sql<number>`(select count(*)::int from service s join project p on p.id = s.project_id where s.server_id = "server"."id" and p.organization_id = ${organizationId})`,
      ownRunning: sql<number>`(select count(*)::int from service s join project p on p.id = s.project_id where s.server_id = "server"."id" and p.organization_id = ${organizationId} and s.status = 'running')`,
    })
    .from(schema.server)
    .orderBy(sql`${schema.server.isLocal} desc`, asc(schema.server.createdAt));
  return Promise.all(
    rows
      .filter((r) => ids.includes(r.id))
      .map(async ({ ownServices, ownRunning, ...r }) => ({
        ...(managed.has(r.id) ? r : { ...r, host: "Shared with this organization", services: ownServices, running: ownRunning }),
        series: r.metricsEnabled ? await metricSeries(serverScope(r.id), 6, 48).catch(() => []) : [],
      })),
  );
}

const BROKEN = new Set(["failed", "crashed"]);
const BUSY = new Set(["building", "deploying", "restarting"]);

/** The state of everything, said in one sentence. */
function headline(total: number, running: number, broken: number, busy: number, serversDown: number) {
  if (!total) return { text: "Nothing is deployed yet.", tone: "idle" as const };
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (broken) return { text: `${broken} ${plural(broken, "service needs", "services need")} attention.`, tone: "bad" as const };
  if (serversDown) return { text: `${serversDown} ${plural(serversDown, "server is", "servers are")} not reachable.`, tone: "bad" as const };
  if (busy) return { text: `${running} of ${total} running, ${busy} deploying now.`, tone: "busy" as const };
  if (running === total) return { text: total === 1 ? "Your service is running." : `All ${total} services are running.`, tone: "ok" as const };
  return { text: `${running} of ${total} services running, ${total - running} stopped.`, tone: "idle" as const };
}

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const ctx = await requireOrg();
  const canCreate = ctx.can("projects.manage");
  const [projects, deployments, servers] = await Promise.all([
    projectSummaries(ctx.org.id, ctx.projectIds),
    recentDeployments(ctx.org.id, 5, undefined, ctx.projectIds),
    // Servers it manages, plus the ones every member sees: owned by or shared with this organization.
    Promise.all([listedServerIds(ctx), viewableServerIds(ctx)]).then(([listed, viewable]) => {
      const ids = [...new Set([...listed, ...viewable])];
      return ids.length ? serverCards(ids, new Set(listed), ctx.org.id) : null;
    }),
  ]);
  const services = projects.flatMap((p) => p.services.map((s) => ({ ...s, project: p })));
  const running = services.filter((s) => s.status === "running").length;
  const broken = services.filter((s) => BROKEN.has(s.status));
  const busy = services.filter((s) => BUSY.has(s.status)).length;
  const down = (servers ?? []).filter((s) => !serverReachable(s));
  const head = headline(services.length, running, broken.length, busy, down.length);

  return (
    <>
      <PageHeader
        crumb="Overview"
        title={
          <span className="flex items-center gap-3">
            <StatusDot status={head.tone === "ok" ? "running" : head.tone === "bad" ? "failed" : head.tone === "busy" ? "deploying" : "stopped"} />
            {head.text}
          </span>
        }
        actions={
          <Link href="/projects/new" className={buttonVariants({ variant: "primary", size: "sm" })} hidden={!canCreate}>
            <Plus /> New project
          </Link>
        }
      />
      <PageBody className="-mt-2 flex flex-col gap-6">
        {(broken.length > 0 || down.length > 0) && (
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <AlertTriangle className="size-4 text-bad" /> Needs attention
                </span>
              }
            />
            <div className="divide-y divide-line">
              {broken.map((s) => (
                <Link key={s.id} href={`/projects/${s.project.id}/services/${s.id}`} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-hover/60">
                  <StatusDot status={s.status} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">
                    <span className="font-medium">{s.name}</span> <span className="text-muted">in {s.project.name}</span>
                  </span>
                  <span className="flex-none text-xs text-muted">{statusText(s.status)}</span>
                </Link>
              ))}
              {down.map((s) => (
                <Link key={s.id} href={`/servers/${s.id}`} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-hover/60">
                  <StatusDot status={s.status} kind="server" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">
                    <span className="font-medium">{s.name}</span> <span className="text-muted">server</span>
                  </span>
                  <span className="flex-none text-xs text-muted">{statusText(s.status, "server")}</span>
                </Link>
              ))}
            </div>
          </Card>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <Card className="min-w-0 self-start">
            <CardHeader title="Recent deploys" />
            {deployments.length ? (
              <CardBody>
                <DeployTimeline rows={deployments} />
              </CardBody>
            ) : (
              <EmptyState icon={<Rocket />} title="No deployments yet" description="Deployments show up here as soon as you ship something." />
            )}
          </Card>

          <div className="flex min-w-0 flex-col gap-6">
            {projects.length ? (
              <RackPanel title="Projects" href="/projects">
                {projects.slice(0, 8).map((p) => (
                  <ProjectRow key={p.id} project={p} />
                ))}
              </RackPanel>
            ) : (
              <Card>
                <EmptyState
                  icon={<Blocks />}
                  title="Create your first project"
                  description="Projects group apps, databases and services that work together."
                  action={
                    <Link href="/projects/new" className={buttonVariants({ variant: "primary", size: "sm" })} hidden={!canCreate}>
                      <Plus /> New project
                    </Link>
                  }
                />
              </Card>
            )}
            {servers && servers.length > 0 && (
              <RackPanel title="Servers" href="/servers">
                {servers.map((s) => (
                  <ServerRow key={s.id} server={s} />
                ))}
              </RackPanel>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}
