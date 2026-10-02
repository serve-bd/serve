"use server";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { cannotMessage } from "@/lib/permissions";
import { requireOrgAdmin, requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull, encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { projectInOrg } from "@/server/services/access";
import { assertHostStackShared } from "@/server/services/variables";

const varsSchema = z.array(
  z.object({
    key: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "Variable names use letters, numbers and underscores"),
    value: z.string(),
  }),
);

function parseVars(vars: z.input<typeof varsSchema>) {
  const data = varsSchema.parse(vars);
  const keys = new Set<string>();
  for (const v of data) {
    if (keys.has(v.key)) throw new UserError(`${v.key} is defined twice.`);
    keys.add(v.key);
  }
  return data;
}

type Scope = { organizationId: string } | { projectId: string };

async function replaceVars(scope: Scope, data: { key: string; value: string }[]) {
  const where = "organizationId" in scope ? eq(schema.sharedVar.organizationId, scope.organizationId) : eq(schema.sharedVar.projectId, scope.projectId);
  await db.transaction(async (tx) => {
    await tx.delete(schema.sharedVar).where(where);
    if (data.length) await tx.insert(schema.sharedVar).values(data.map((v) => ({ id: newId(), ...scope, key: v.key, value: encrypt(v.value) })));
  });
}

/** Organization variables, used as ${{org.KEY}}. Only admins change them. */
export async function saveOrgSharedVars(vars: z.input<typeof varsSchema>) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const data = parseVars(vars);
    await assertHostStackShared(ctx, { organizationId: ctx.org.id }, data);
    await replaceVars({ organizationId: ctx.org.id }, data);
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "variables.shared", message: "Updated organization shared variables" });
    return null;
  });
}

/** Project variables, used as ${{project.KEY}} in every environment of the project. */
export async function saveProjectSharedVars(projectId: string, vars: z.input<typeof varsSchema>) {
  return act(async () => {
    const ctx = await requirePermission("variables.edit");
    // The values are replaced as a whole, so only roles that can see them may write them.
    if (!ctx.can("variables.view-secrets")) throw new UserError(cannotMessage("variables.view-secrets"));
    const project = await projectInOrg(projectId, ctx.org.id);
    const data = parseVars(vars);
    await assertHostStackShared(ctx, { projectId }, data);
    await replaceVars({ projectId }, data);
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, projectId, action: "variables.shared", message: `Updated shared variables of ${project.name}` });
    return null;
  });
}

/**
 * Redeploys running services that reference the scope (${{org.…}}, ${{team.…}} or ${{project.…}}).
 * Organization and project variables are never injected on their own, so other services are unaffected.
 */
export async function redeployReferencing(scope: "org" | { projectId: string }) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const projectIds =
      scope === "org"
        ? (await db.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.organizationId, ctx.org.id)))
            .map((p) => p.id)
            // A member limited to some projects redeploys only those.
            .filter((id) => ctx.canAccessProject(id))
        : [(await projectInOrg(scope.projectId, ctx.org.id)).id];
    if (!projectIds.length) return { count: 0 };
    const services = await db
      .select({ id: schema.service.id, environmentId: schema.service.environmentId })
      .from(schema.service)
      .innerJoin(schema.environment, eq(schema.service.environmentId, schema.environment.id))
      .where(and(inArray(schema.environment.projectId, projectIds), inArray(schema.service.status, ["running", "failed", "crashed"])));
    if (!services.length) return { count: 0 };
    const vars = await db
      .select({ serviceId: schema.envVar.serviceId, value: schema.envVar.value })
      .from(schema.envVar)
      .where(
        inArray(
          schema.envVar.serviceId,
          services.map((s) => s.id),
        ),
      );
    const ref = scope === "org" ? /\$\{\{\s*(org|team)\./i : /\$\{\{\s*project\./i;
    const affected = new Set(vars.filter((v) => ref.test(decryptOrNull(v.value) ?? "")).map((v) => v.serviceId));
    // Environment shared variables reach every service of their environment.
    const envVars = await db
      .select({ environmentId: schema.sharedVar.environmentId, value: schema.sharedVar.value })
      .from(schema.sharedVar)
      .where(inArray(schema.sharedVar.environmentId, [...new Set(services.map((s) => s.environmentId))]));
    const envs = new Set(envVars.filter((v) => ref.test(decryptOrNull(v.value) ?? "")).map((v) => v.environmentId));
    for (const s of services) if (envs.has(s.environmentId)) affected.add(s.id);
    const { queueDeployment } = await import("@/server/services/create");
    for (const id of affected) await queueDeployment(id, "redeploy", { userId: ctx.user.id });
    return { count: affected.size };
  });
}
