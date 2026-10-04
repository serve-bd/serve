import { and, asc, count, desc, eq, gt, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { JobsView } from "./jobs-view";

export const metadata = { title: "Jobs" };

const DAY = 24 * 3600_000;

/** What background work is about, from its payload: the service it is for, where that can be found. */
async function subjects(jobs: (typeof schema.job.$inferSelect)[]) {
  const ids = (key: string) => [...new Set(jobs.map((j) => (j.payload as Record<string, unknown>)[key]).filter((v): v is string => typeof v === "string"))];
  const out = new Map<string, { name: string; href: string }>();
  const deployments = ids("deploymentId");
  if (deployments.length) {
    const rows = await db
      .select({ id: schema.deployment.id, serviceId: schema.service.id, name: schema.service.name, projectId: schema.service.projectId })
      .from(schema.deployment)
      .innerJoin(schema.service, eq(schema.service.id, schema.deployment.serviceId))
      .where(inArray(schema.deployment.id, deployments));
    for (const r of rows) out.set(`deploymentId:${r.id}`, { name: r.name, href: `/projects/${r.projectId}/services/${r.serviceId}/deployments/${r.id}` });
  }
  const backups = ids("backupId");
  if (backups.length) {
    const rows = await db
      .select({ id: schema.backup.id, serviceId: schema.service.id, name: schema.service.name, projectId: schema.service.projectId })
      .from(schema.backup)
      .innerJoin(schema.service, eq(schema.service.id, schema.backup.serviceId))
      .where(inArray(schema.backup.id, backups));
    for (const r of rows) out.set(`backupId:${r.id}`, { name: r.name, href: `/projects/${r.projectId}/services/${r.serviceId}/backups` });
  }
  const services = ids("serviceId");
  if (services.length) {
    const rows = await db
      .select({ id: schema.service.id, name: schema.service.name, projectId: schema.service.projectId })
      .from(schema.service)
      .where(inArray(schema.service.id, services));
    for (const r of rows) out.set(`serviceId:${r.id}`, { name: r.name, href: `/projects/${r.projectId}/services/${r.id}` });
  }
  return (j: typeof schema.job.$inferSelect) => {
    const p = j.payload as Record<string, unknown>;
    for (const key of ["deploymentId", "backupId", "serviceId"]) if (typeof p[key] === "string" && out.has(`${key}:${p[key]}`)) return out.get(`${key}:${p[key]}`)!;
    return null;
  };
}

export default async function JobsPage() {
  // Jobs of every organization: checked here too, not only by the layout (a page can render without it).
  if (!(await requireOrg()).isInstanceAdmin) redirect("/");
  const since = new Date(Date.now() - 7 * DAY);
  const [schedulers, active, failed, doneByType, settings] = await Promise.all([
    db.select().from(schema.schedulerRun).orderBy(asc(schema.schedulerRun.name)),
    db
      .select()
      .from(schema.job)
      .where(inArray(schema.job.status, ["pending", "running"]))
      .orderBy(asc(schema.job.runAt))
      .limit(100),
    db
      .select()
      .from(schema.job)
      .where(and(eq(schema.job.status, "failed"), gt(schema.job.createdAt, since)))
      .orderBy(desc(schema.job.createdAt))
      .limit(100),
    db
      .select({ type: schema.job.type, n: count() })
      .from(schema.job)
      .where(and(eq(schema.job.status, "done"), gt(schema.job.createdAt, new Date(Date.now() - DAY))))
      .groupBy(schema.job.type),
    getSettings(),
  ]);
  const about = await subjects([...active, ...failed]);
  const view = (j: typeof schema.job.$inferSelect) => ({
    id: j.id,
    type: j.type,
    status: j.status,
    runAt: j.runAt.toISOString(),
    lockedAt: j.lockedAt?.toISOString() ?? null,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
    error: j.error,
    attempts: j.attempts,
    subject: about(j),
  });
  return (
    <JobsView
      heartbeat={settings.workerHeartbeat}
      schedulers={schedulers.map((s) => ({
        name: s.name,
        intervalMs: s.intervalMs,
        lastStartedAt: s.lastStartedAt?.toISOString() ?? null,
        lastDurationMs: s.lastDurationMs,
        lastError: s.lastError,
        lastFailedAt: s.lastFailedAt?.toISOString() ?? null,
        runs: s.runs,
        failures: s.failures,
        skipped: s.skipped,
        lastSkippedAt: s.lastSkippedAt?.toISOString() ?? null,
      }))}
      active={active.map(view)}
      failed={failed.map(view)}
      done={doneByType.map((d) => ({ type: d.type, count: d.n }))}
    />
  );
}
