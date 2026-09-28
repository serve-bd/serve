import Link from "next/link";
import { Blocks, Plus, Rocket } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { projectSummaries, recentActivity, recentDeployments } from "@/server/queries";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { ServerStats } from "./_components/server-stats";
import { ProjectCard } from "./_components/project-card";
import { DeploymentRow } from "./_components/deployment-row";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const ctx = await requireOrg();
  const [projects, deployments, activity] = await Promise.all([
    projectSummaries(ctx.org.id),
    recentDeployments(ctx.org.id, 8),
    recentActivity(ctx.org.id, 10),
  ]);
  const services = projects.flatMap((p) => p.services);
  const running = services.filter((s) => s.status === "running").length;

  return (
    <>
      <PageHeader
        title={ctx.org.name}
        description={`${projects.length} project${projects.length === 1 ? "" : "s"} · ${running} of ${services.length} services running`}
        actions={
          <Link href="/projects/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
            <Plus /> New project
          </Link>
        }
      />
      <PageBody className="flex flex-col gap-8">
        {ctx.isInstanceAdmin && (
          <section className="flex flex-col gap-3">
            <h2 className="text-[13px] font-medium text-muted">Server</h2>
            <ServerStats />
          </section>
        )}

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-medium text-muted">Projects</h2>
            {projects.length > 0 && (
              <Link href="/projects" className="text-[13px] text-muted hover:text-fg">
                View all
              </Link>
            )}
          </div>
          {projects.length ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
                  <Link href="/projects/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
                    <Plus /> New project
                  </Link>
                }
              />
            </Card>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
          <Card>
            <CardHeader title="Recent deployments" />
            {deployments.length ? (
              <div className="divide-y divide-line">
                {deployments.map((d) => (
                  <DeploymentRow key={d.id} d={d} />
                ))}
              </div>
            ) : (
              <EmptyState icon={<Rocket />} title="No deployments yet" description="Deployments show up here as soon as you ship something." />
            )}
          </Card>
          <Card>
            <CardHeader title="Activity" />
            {activity.length ? (
              <ol className="relative flex flex-col px-5 py-3">
                <span aria-hidden className="absolute top-5 bottom-5 left-[23px] w-px bg-line" />
                {activity.map((a) => (
                  <li key={a.id} className="relative flex gap-3 py-2">
                    <span className="relative z-10 mt-1.5 size-[7px] shrink-0 rounded-full border border-line-strong bg-surface" />
                    <div className="flex min-w-0 flex-col">
                      <span className="text-[13px] text-fg-2">{a.message}</span>
                      <span className="text-xs text-faint">
                        {a.userName ?? "System"} · <TimeAgo date={a.createdAt} />
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState title="Nothing yet" description="Changes made by your team appear here." />
            )}
          </Card>
        </div>
      </PageBody>
    </>
  );
}
