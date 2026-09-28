import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { DeploymentView } from "./deployment-view";

export default async function DeploymentPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/deployments/[deploymentId]">) {
  const { projectId, serviceId, deploymentId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  const [dep] = await db
    .select({
      id: schema.deployment.id,
      status: schema.deployment.status,
      trigger: schema.deployment.trigger,
      commitSha: schema.deployment.commitSha,
      commitMessage: schema.deployment.commitMessage,
      commitAuthor: schema.deployment.commitAuthor,
      branch: schema.deployment.branch,
      image: schema.deployment.image,
      createdAt: schema.deployment.createdAt,
      userName: schema.user.name,
    })
    .from(schema.deployment)
    .leftJoin(schema.user, eq(schema.deployment.createdBy, schema.user.id))
    .where(and(eq(schema.deployment.id, deploymentId), eq(schema.deployment.serviceId, serviceId)));
  if (!dep) notFound();
  return (
    <PageBody>
      <DeploymentView
        deployment={JSON.parse(JSON.stringify(dep))}
        backHref={`/projects/${projectId}/services/${serviceId}`}
        serviceType={service.type}
        isCurrent={service.currentDeploymentId === dep.id}
        repoUrl={service.source?.type === "git" ? service.source.repository.replace(/\.git$/, "") : null}
      />
    </PageBody>
  );
}
