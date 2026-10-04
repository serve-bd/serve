import Link from "next/link";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { Layers3 } from "lucide-react";
import { db, schema } from "@/server/db";
import { Badge, Card, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { StatusLabel } from "@/components/ui/status";
import { ServiceIcon } from "@/components/service-icon";
import { shownServiceStatus } from "@/lib/server-services";
import { loadServerView } from "../_lib/load";

export const metadata = { title: "Services" };

export default async function ServerServicesPage(props: PageProps<"/servers/[serverId]/services">) {
  const { serverId } = await props.params;
  const { row, ctx } = await loadServerView(serverId);
  // Services whose main server this is, and apps that run extra replicas here. Previews are listed with their app.
  const rows = await db
    .select({
      id: schema.service.id,
      name: schema.service.name,
      type: schema.service.type,
      status: schema.service.status,
      icon: schema.service.icon,
      engine: sql<string | null>`${schema.service.database}->>'engine'`,
      sourceType: sql<string | null>`${schema.service.source}->>'type'`,
      serverId: schema.service.serverId,
      updatedAt: schema.service.updatedAt,
      projectId: schema.project.id,
      projectName: schema.project.name,
      organizationId: schema.project.organizationId,
      environmentName: schema.environment.name,
    })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .innerJoin(schema.environment, eq(schema.service.environmentId, schema.environment.id))
    .where(
      and(isNull(schema.service.previewPr), or(eq(schema.service.serverId, serverId), sql`coalesce(${schema.service.distribution}->'extraServerIds', '[]'::jsonb) ? ${serverId}`)),
    )
    .orderBy(asc(schema.project.name), asc(schema.service.name));

  // Only this organization's services are shown; others are counted, never named.
  const visible = rows
    .filter((s) => s.organizationId === ctx.org.id && (!ctx.projectIds || ctx.projectIds.includes(s.projectId)))
    .map((s) => ({ ...s, status: shownServiceStatus(s.status, row) }));
  const hidden = rows.length - visible.length;
  const running = visible.filter((s) => s.status === "running").length;

  return (
    <Card>
      <CardHeader
        title="Services"
        description={
          visible.length
            ? `${running} of ${visible.length} running on ${row.name}.${hidden ? ` ${hidden} more belong to other organizations or projects you cannot see.` : ""}`
            : `Nothing of yours runs on ${row.name} yet.${hidden ? ` ${hidden} services belong to other organizations or projects you cannot see.` : ""}`
        }
      />
      {visible.length ? (
        <div className="divide-y divide-line">
          {visible.map((s) => (
            <Link key={s.id} href={`/projects/${s.projectId}/services/${s.id}`} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-hover/60">
              <ServiceIcon
                type={s.type}
                engine={s.engine}
                icon={s.icon}
                source={s.sourceType === "git" || s.sourceType === "image" || s.sourceType === "dockerfile" || s.sourceType === "upload" ? s.sourceType : null}
                size="sm"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13.5px] font-semibold text-fg">{s.name}</span>
                  {s.serverId !== serverId && <Badge>Extra replicas</Badge>}
                </span>
                <span className="truncate text-xs text-muted">
                  {s.projectName} · {s.environmentName}
                </span>
              </span>
              <StatusLabel status={s.status} className="w-28 flex-none text-xs" />
              <span className="hidden w-20 flex-none text-right text-xs text-faint sm:block">
                <TimeAgo date={s.updatedAt} />
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState icon={<Layers3 />} title="No services here" description="Pick this server under Deploy to when you add a service." />
      )}
    </Card>
  );
}
