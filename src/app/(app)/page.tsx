import Link from "next/link";
import { asc, sql } from "drizzle-orm";
import { ArrowRight, Blocks, Plus, Rocket } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { metricSeries, serverScope } from "@/server/metrics";
import { projectSummaries, recentDeployments } from "@/server/queries";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/misc";
import { ProjectCard } from "./_components/project-card";
import { DeploymentsTable } from "./_components/deployments-table";
import { ServerCards } from "./_components/server-cards";
import { ProductName } from "@/components/brand";

async function serverCards() {
  const rows = await db
    .select({
      id: schema.server.id,
      name: schema.server.name,
      host: schema.server.host,
      isLocal: schema.server.isLocal,
      status: schema.server.status,
      services: sql<number>`(select count(*)::int from service s where s.server_id = "server"."id")`,
      running: sql<number>`(select count(*)::int from service s where s.server_id = "server"."id" and s.status = 'running')`,
    })
    .from(schema.server)
    .orderBy(sql`${schema.server.isLocal} desc`, asc(schema.server.createdAt));
  return Promise.all(rows.map(async (r) => ({ ...r, series: await metricSeries(serverScope(r.id), 6, 48).catch(() => []) })));
}

function Section({
  title,
  description,
  href,
  action,
  children,
}: {
  title: string;
  description: React.ReactNode;
  href?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
          <p className="text-[13px] text-muted">{description}</p>
        </div>
        <div className="flex flex-none items-center gap-2">
          {href && (
            <Link href={href} className={buttonVariants({ size: "sm" })}>
              View all <ArrowRight />
            </Link>
          )}
          {action}
        </div>
      </div>
      {children}
    </section>
  );
}

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const ctx = await requireOrg();
  const canCreate = ctx.can("projects.manage");
  const [projects, deployments, servers] = await Promise.all([
    projectSummaries(ctx.org.id, ctx.projectIds),
    recentDeployments(ctx.org.id, 8, undefined, ctx.projectIds),
    ctx.isInstanceAdmin ? serverCards() : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader crumb="Overview" />
      <PageBody className="flex flex-col gap-10">
        <Section title="Deployments" description="Latest deployments across your projects.">
          <Card>
            {deployments.length ? (
              <DeploymentsTable rows={deployments} />
            ) : (
              <EmptyState icon={<Rocket />} title="No deployments yet" description="Deployments show up here as soon as you ship something." />
            )}
          </Card>
        </Section>

        <Section
          title="Projects"
          description="Apps, databases and services grouped by project."
          href={projects.length ? "/projects" : undefined}
          action={
            projects.length > 0 && (
              <Link href="/projects/new" className={buttonVariants({ variant: "primary", size: "sm" })} hidden={!canCreate}>
                <Plus /> New project
              </Link>
            )
          }
        >
          {projects.length ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {projects.slice(0, 6).map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
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
        </Section>

        {servers && (
          <Section
            title="Servers"
            description={
              <>
                Machines <ProductName /> deploys to, with usage over the last 6 hours.
              </>
            }
            href="/servers"
          >
            <ServerCards servers={servers} />
          </Section>
        )}
      </PageBody>
    </>
  );
}
