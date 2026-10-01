import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { metricSeries, serverScope } from "@/server/metrics";
import { normalizeLayout } from "@/lib/dashboard";
import type { OrgContext } from "@/server/auth";

/** The member's own overview layout, or the default one. */
export async function loadDashboard(ctx: OrgContext) {
  const [row] = await db
    .select({ layout: schema.dashboardLayout.layout })
    .from(schema.dashboardLayout)
    .where(and(eq(schema.dashboardLayout.userId, ctx.user.id), eq(schema.dashboardLayout.organizationId, ctx.org.id)));
  return { layout: normalizeLayout(row?.layout), custom: Boolean(row) };
}

/** Server cards: full for servers the user manages; for the others only this organization's services and no address. */
export async function serverCards(ids: string[], managed: Set<string>, organizationId: string) {
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

export type DeployBucket = { t: number; n: number; failed: number };

/**
 * Deployments per hour over the last `days`. Hours, not days: the server does not know the
 * viewer's timezone, so the browser puts each hour on its own local day.
 */
export async function deployBuckets(orgId: string, projectIds: string[] | null, days: number): Promise<DeployBucket[]> {
  if (projectIds && !projectIds.length) return [];
  const hour = sql<string>`date_trunc('hour', ${schema.deployment.createdAt})`;
  const rows = await db
    .select({
      t: sql<number>`extract(epoch from ${hour})::bigint * 1000`.mapWith(Number),
      n: sql<number>`count(*)::int`,
      failed: sql<number>`(count(*) filter (where ${schema.deployment.status} = 'failed'))::int`,
    })
    .from(schema.deployment)
    .innerJoin(schema.service, eq(schema.deployment.serviceId, schema.service.id))
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(
      and(
        eq(schema.project.organizationId, orgId),
        projectIds ? inArray(schema.project.id, projectIds) : undefined,
        gte(schema.deployment.createdAt, new Date(Date.now() - days * 86_400_000)),
      ),
    )
    .groupBy(hour)
    .orderBy(hour);
  return rows;
}
