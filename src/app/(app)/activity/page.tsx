import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { Activity } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { recentActivity } from "@/server/queries";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Avatar, Card, EmptyState, TimeAgo } from "@/components/ui/misc";

export const metadata = { title: "Activity" };

export default async function ActivityPage() {
  const ctx = await requireOrg();
  const items = await recentActivity(ctx.org.id, 200, ctx.projectIds);
  // Rows only link to what still exists, and a moved service to its project now.
  const serviceIds = [...new Set(items.filter((a) => a.targetType === "service" && a.targetId).map((a) => a.targetId as string))];
  const projectIds = [...new Set(items.map((a) => a.projectId).filter((id): id is string => !!id))];
  const [services, projects] = await Promise.all([
    serviceIds.length
      ? db
          .select({ id: schema.service.id, projectId: schema.environment.projectId })
          .from(schema.service)
          .innerJoin(schema.environment, eq(schema.service.environmentId, schema.environment.id))
          .where(inArray(schema.service.id, serviceIds))
      : [],
    projectIds.length
      ? db
          .select({ id: schema.project.id })
          .from(schema.project)
          .where(and(eq(schema.project.organizationId, ctx.org.id), inArray(schema.project.id, projectIds)))
      : [],
  ]);
  const serviceProject = new Map(services.map((s) => [s.id, s.projectId]));
  const liveProjects = new Set(projects.map((p) => p.id));
  return (
    <>
      <PageHeader title="Activity" description="An audit trail of changes made in this organization." />
      <PageBody>
        <Card className="overflow-hidden">
          {items.length === 0 ? (
            <EmptyState icon={<Activity />} title="No activity yet" />
          ) : (
            <ol className="divide-y divide-line">
              {items.map((a) => {
                // A deleted project has nothing left to open.
                const serviceIn = a.targetType === "service" && a.targetId ? serviceProject.get(a.targetId) : undefined;
                const href =
                  serviceIn && ctx.canAccessProject(serviceIn)
                    ? `/projects/${serviceIn}/services/${a.targetId}`
                    : a.projectId && liveProjects.has(a.projectId) && ctx.canAccessProject(a.projectId)
                      ? `/projects/${a.projectId}`
                      : null;
                const body = (
                  <div className="flex items-center gap-3 px-5 py-3">
                    <Avatar name={a.userName ?? "System"} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] text-fg-2">{a.message}</span>
                      <span className="text-xs text-faint">{a.userName ?? "System"}</span>
                    </div>
                    <TimeAgo date={a.createdAt} className="text-xs text-faint" />
                  </div>
                );
                return (
                  <li key={a.id}>
                    {href ? (
                      <Link href={href} className="block transition-colors hover:bg-hover/40">
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      </PageBody>
    </>
  );
}
