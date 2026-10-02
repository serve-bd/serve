"use server";

import { asc, eq, inArray } from "drizzle-orm";
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

/**
 * A compose stack with host options reads the shared variables of its new environment and project,
 * and a move rewrites its references: only admins of the Root organization move one whose host options use them.
 */
async function assertHostStacksMovable(ctx: Awaited<ReturnType<typeof authorize>>["ctx"], preview: Awaited<ReturnType<typeof previewMove>>) {
  if (ctx.isInstanceAdmin && ctx.isRoot) return;
  const ids = preview.services.map((s) => s.id);
  if (!ids.length) return;
  const { serviceHasHostAccess } = await import("@/server/security");
  const { hostStackReachOf } = await import("@/server/services/variables");
  for (const s of await db.select().from(schema.service).where(inArray(schema.service.id, ids))) {
    if (s.type !== "compose" || !serviceHasHostAccess(s)) continue;
    const reach = await hostStackReachOf(s, ctx.org.id);
    const rewritten = new Set((preview.rewrites[s.id] ?? []).map((v) => `own:${v.key}`));
    if ([...reach].some((k) => k.startsWith("environment:") || k.startsWith("project:") || rewritten.has(k)))
      throw new UserError(`${s.name} uses host options with shared variables or references, so only admins of the Root organization can move it.`);
  }
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
    const { ctx, preview: planned } = await authorize(serviceIds, targetEnvironmentId);
    await assertHostStacksMovable(ctx, planned);
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
