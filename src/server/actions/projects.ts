"use server";

import { requireRoom } from "@/server/limits";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { cannotMessage } from "@/lib/permissions";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { projectInOrg } from "@/server/services/access";
import { projectColors } from "@/components/shell/project-color";

const projectSchema = z.object({
  name: z.string().trim().min(1, "Enter a project name").max(60),
  description: z.string().trim().max(300).optional().nullable(),
  color: z
    .string()
    .refine((c) => c in projectColors)
    .optional(),
  groupServices: z.boolean().optional(),
});

export async function createProject(input: z.input<typeof projectSchema>) {
  return act(async () => {
    const ctx = await requirePermission("projects.manage");
    const data = projectSchema.parse(input);
    await requireRoom(ctx.org.id, { projects: 1 });
    const id = newId();
    const colors = Object.keys(projectColors);
    await db.insert(schema.project).values({
      id,
      organizationId: ctx.org.id,
      name: data.name,
      description: data.description || null,
      color: data.color ?? colors[Math.floor(Math.random() * colors.length)],
    });
    await db.insert(schema.environment).values({ id: newId(), projectId: id, name: "production" });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, projectId: id, action: "project.created", message: `Created project ${data.name}` });
    return { id };
  });
}

export async function updateProject(projectId: string, input: z.input<typeof projectSchema>) {
  return act(async () => {
    const ctx = await requirePermission("projects.manage");
    await projectInOrg(projectId, ctx.org.id);
    const data = projectSchema.parse(input);
    await db
      .update(schema.project)
      .set({
        name: data.name,
        description: data.description || null,
        ...(data.color ? { color: data.color } : {}),
        ...(data.groupServices === undefined ? {} : { groupServices: data.groupServices }),
      })
      .where(eq(schema.project.id, projectId));
    return null;
  });
}

export async function deleteProject(projectId: string) {
  return act(async () => {
    const ctx = await requirePermission("projects.manage");
    const project = await projectInOrg(projectId, ctx.org.id);
    const services = await db.select().from(schema.service).where(eq(schema.service.projectId, projectId));
    const { teardownServices } = await import("@/server/services/teardown");
    await teardownServices(services, true);
    await db.delete(schema.project).where(eq(schema.project.id, projectId));
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, projectId: project.id, action: "project.deleted", message: `Deleted project ${project.name}` });
    return null;
  });
}

export async function createEnvironment(projectId: string, name: string) {
  return act(async () => {
    const ctx = await requirePermission("projects.manage");
    await projectInOrg(projectId, ctx.org.id);
    const clean = z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Use lowercase letters, numbers and dashes")
      .parse(name);
    const [exists] = await db
      .select({ id: schema.environment.id })
      .from(schema.environment)
      .where(and(eq(schema.environment.projectId, projectId), eq(schema.environment.name, clean)));
    if (exists) throw new UserError("An environment with that name already exists.");
    const id = newId();
    await db.insert(schema.environment).values({ id, projectId, name: clean });
    return { id };
  });
}

export async function deleteEnvironment(environmentId: string) {
  return act(async () => {
    const ctx = await requirePermission("projects.manage");
    const [env] = await db.select().from(schema.environment).where(eq(schema.environment.id, environmentId));
    if (!env) throw new UserError("Environment not found.");
    await projectInOrg(env.projectId, ctx.org.id);
    const all = await db.select().from(schema.environment).where(eq(schema.environment.projectId, env.projectId));
    if (all.length <= 1) throw new UserError("A project needs at least one environment.");
    const services = await db.select().from(schema.service).where(eq(schema.service.environmentId, environmentId));
    const { teardownServices } = await import("@/server/services/teardown");
    await teardownServices(services, true);
    await db.delete(schema.environment).where(eq(schema.environment.id, environmentId));
    return null;
  });
}

const varsSchema = z.array(
  z.object({
    key: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "Variable names use letters, numbers and underscores"),
    value: z.string(),
  }),
);

export async function saveSharedVars(environmentId: string, vars: z.input<typeof varsSchema>) {
  return act(async () => {
    const ctx = await requirePermission("variables.edit");
    // The values are replaced as a whole, so only roles that can see them may write them.
    if (!ctx.can("variables.view-secrets")) throw new UserError(cannotMessage("variables.view-secrets"));
    const [env] = await db.select().from(schema.environment).where(eq(schema.environment.id, environmentId));
    if (!env) throw new UserError("Environment not found.");
    await projectInOrg(env.projectId, ctx.org.id);
    const data = varsSchema.parse(vars);
    const keys = new Set<string>();
    for (const v of data) {
      if (keys.has(v.key)) throw new UserError(`${v.key} is defined twice.`);
      keys.add(v.key);
    }
    await db.transaction(async (tx) => {
      await tx.delete(schema.sharedVar).where(eq(schema.sharedVar.environmentId, environmentId));
      if (data.length) {
        await tx.insert(schema.sharedVar).values(data.map((v) => ({ id: newId(), environmentId, key: v.key, value: encrypt(v.value) })));
      }
    });
    return null;
  });
}

/** Queue redeploys for every service in an environment (after shared variable changes). */
export async function redeployEnvironment(environmentId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const [env] = await db.select().from(schema.environment).where(eq(schema.environment.id, environmentId));
    if (!env) throw new UserError("Environment not found.");
    await projectInOrg(env.projectId, ctx.org.id);
    const { queueDeployment } = await import("@/server/services/create");
    const services = await db
      .select()
      .from(schema.service)
      .where(and(eq(schema.service.environmentId, environmentId), inArray(schema.service.status, ["running", "failed", "crashed"])));
    for (const s of services) await queueDeployment(s.id, "redeploy", { userId: ctx.user.id });
    return { count: services.length };
  });
}

const canvasPositions = z.record(z.string().max(32), z.object({ x: z.number().finite().min(-1e5).max(1e5), y: z.number().finite().min(-1e5).max(1e5) }));

/** Remember where services sit on an environment's canvas (merged: only moved services are sent). */
export async function saveCanvasPositions(environmentId: string, positions: Record<string, { x: number; y: number }>) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const parsed = canvasPositions.parse(positions);
    const [env] = await db.select().from(schema.environment).where(eq(schema.environment.id, environmentId));
    if (!env) throw new UserError("Environment not found.");
    await projectInOrg(env.projectId, ctx.org.id);
    const ids = new Set((await db.select({ id: schema.service.id }).from(schema.service).where(eq(schema.service.environmentId, environmentId))).map((s) => s.id));
    const moved: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries(parsed)) if (ids.has(id)) moved[id] = { x: Math.round(p.x), y: Math.round(p.y) };
    if (!Object.keys(moved).length) return null;
    // Merged in one statement, so two people moving different services never undo each other.
    await db
      .update(schema.environment)
      .set({ canvas: sql`jsonb_build_object('positions', coalesce(${schema.environment.canvas}->'positions', '{}'::jsonb) || ${JSON.stringify(moved)}::jsonb)` })
      .where(eq(schema.environment.id, environmentId));
    return null;
  });
}

/** Forget the canvas layout: services go back to automatic places. */
export async function resetCanvasLayout(environmentId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const [env] = await db.select().from(schema.environment).where(eq(schema.environment.id, environmentId));
    if (!env) throw new UserError("Environment not found.");
    await projectInOrg(env.projectId, ctx.org.id);
    await db.update(schema.environment).set({ canvas: null }).where(eq(schema.environment.id, environmentId));
    return null;
  });
}
