"use server";

import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { logActivity } from "@/server/activity";
import { projectInOrg, serviceInOrg } from "@/server/services/access";
import { executeMove, previewMove } from "@/server/services/move";

/** Moving needs "manage services" and access to the services' projects and the target project. */
async function authorize(serviceIds: string[], targetEnvironmentId: string) {
  const ctx = await requirePermission("services.manage");
  if (!serviceIds.length) throw new UserError("Choose at least one service.");
  for (const id of serviceIds) await serviceInOrg(id, ctx.org.id);
  const preview = await previewMove(serviceIds, targetEnvironmentId, ctx.org.id);
  await projectInOrg(preview.target.projectId, ctx.org.id);
  return { ctx, preview };
}

/** What a move would do: new names, references that break, services worth moving along. Changes nothing. */
export async function planServiceMove(serviceIds: string[], targetEnvironmentId: string) {
  return act(async () => {
    const { preview } = await authorize(serviceIds, targetEnvironmentId);
    // Rewrites carry decrypted values; the browser only needs to know which services change.
    const { rewrites, ...rest } = preview;
    return { ...rest, rewritten: Object.keys(rewrites) };
  });
}

export async function moveServicesTo(serviceIds: string[], targetEnvironmentId: string) {
  return act(async () => {
    const { ctx } = await authorize(serviceIds, targetEnvironmentId);
    const { preview, warnings } = await executeMove(serviceIds, targetEnvironmentId, ctx.org.id);
    const names = preview.services.filter((s) => serviceIds.includes(s.id)).map((s) => s.newName);
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: preview.target.projectId,
      action: "service.move",
      message: `Moved ${names.join(", ")} to ${preview.target.projectName} · ${preview.target.environmentName}`,
      targetType: "service",
      targetId: serviceIds[0],
    });
    return { projectId: preview.target.projectId, environmentName: preview.target.environmentName, moved: preview.services.length, warnings };
  });
}

/** Projects and environments the member may move services into. */
export async function moveTargets() {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const rows = await db
      .select({ projectId: schema.project.id, projectName: schema.project.name, environmentId: schema.environment.id, environmentName: schema.environment.name })
      .from(schema.environment)
      .innerJoin(schema.project, eq(schema.environment.projectId, schema.project.id))
      .where(eq(schema.project.organizationId, ctx.org.id))
      .orderBy(asc(schema.project.name), asc(schema.environment.createdAt));
    const projects = new Map<string, { id: string; name: string; environments: { id: string; name: string }[] }>();
    for (const r of rows) {
      if (!ctx.canAccessProject(r.projectId)) continue;
      const p = projects.get(r.projectId) ?? { id: r.projectId, name: r.projectName, environments: [] };
      p.environments.push({ id: r.environmentId, name: r.environmentName });
      projects.set(r.projectId, p);
    }
    return [...projects.values()];
  });
}
