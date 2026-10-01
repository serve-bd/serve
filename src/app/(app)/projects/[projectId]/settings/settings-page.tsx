import { asc, eq, inArray } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { pageProject } from "@/server/services/access";
import { resolveEnvironment } from "@/server/project-data";
import { ProjectSettings, type ProjectSettingsSection } from "./project-settings";

/** One section of the project settings; the layout holds the header and the navigation. */
export async function ProjectSettingsPage({ projectId, env, section }: { projectId: string; env: string | string[] | undefined; section: ProjectSettingsSection }) {
  const ctx = await requireOrg();
  const project = await pageProject(projectId, ctx.org.id);
  // Shared values are edited as one text block, so editing them needs seeing them.
  const canEditShared = ctx.can("variables.edit") && ctx.can("variables.view-secrets");
  const { envs, current } = await resolveEnvironment(projectId, typeof env === "string" ? env : undefined);
  const [shared, counts] = await Promise.all([
    db.select().from(schema.sharedVar).where(eq(schema.sharedVar.environmentId, current.id)).orderBy(asc(schema.sharedVar.key)),
    db
      .select({ environmentId: schema.service.environmentId })
      .from(schema.service)
      .where(
        inArray(
          schema.service.environmentId,
          envs.map((e) => e.id),
        ),
      ),
  ]);
  return (
    <ProjectSettings
      key={current.id}
      section={section}
      project={{ id: project.id, name: project.name, description: project.description ?? "", color: project.color, groupServices: project.groupServices }}
      environments={envs.map((e) => ({ id: e.id, name: e.name, services: counts.filter((c) => c.environmentId === e.id).length }))}
      environment={{ id: current.id, name: current.name }}
      shared={shared.map((s) => ({ key: s.key, value: canEditShared ? (decryptOrNull(s.value) ?? "") : "" }))}
      canEditShared={canEditShared}
      canManage={ctx.can("projects.manage")}
      canDeploy={ctx.can("services.deploy")}
    />
  );
}
