import Link from "next/link";
import { Blocks, Plus } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { projectSummaries } from "@/server/queries";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/misc";
import { ProjectCard } from "../_components/project-card";

export const metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const ctx = await requireOrg();
  const projects = await projectSummaries(ctx.org.id);
  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project holds apps, databases and services that belong together, with separate environments."
        actions={
          <Link href="/projects/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
            <Plus /> New project
          </Link>
        }
      />
      <PageBody>
        {projects.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState
              icon={<Blocks />}
              title="No projects yet"
              description="Create a project to deploy your first app or database."
              action={
                <Link href="/projects/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
                  <Plus /> New project
                </Link>
              }
            />
          </Card>
        )}
      </PageBody>
    </>
  );
}
