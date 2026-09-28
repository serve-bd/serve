"use server";

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireOrg, requireOrgAdmin } from "@/server/auth";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { projectInOrg } from "@/server/services/access";
import { projectColors } from "@/components/shell/project-color";

const projectSchema = z.object({
  name: z.string().trim().min(1, "Enter a project name").max(60),
  description: z.string().trim().max(300).optional().nullable(),
  color: z.string().refine((c) => c in projectColors).optional(),
});

export async function createProject(input: z.input<typeof projectSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const data = projectSchema.parse(input);
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
    const ctx = await requireOrg();
    await projectInOrg(projectId, ctx.org.id);
    const data = projectSchema.parse(input);
    await db
      .update(schema.project)
      .set({ name: data.name, description: data.description || null, ...(data.color ? { color: data.color } : {}) })
      .where(eq(schema.project.id, projectId));
    return null;
  });
}

export async function deleteProject(projectId: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const project = await projectInOrg(projectId, ctx.org.id);
    const services = await db.select().from(schema.service).where(eq(schema.service.projectId, projectId));
    for (const s of services) {
      await enqueue("service.delete", { serviceId: s.id, slug: s.slug, type: s.type, removeVolumes: true });
    }
    await db.delete(schema.project).where(eq(schema.project.id, projectId));
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "project.deleted", message: `Deleted project ${project.name}` });
    return null;
  });
}

export async function createEnvironment(projectId: string, name: string) {
  return act(async () => {
    const ctx = await requireOrg();
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
    const ctx = await requireOrgAdmin();
    const [env] = await db.select().from(schema.environment).where(eq(schema.environment.id, environmentId));
    if (!env) throw new UserError("Environment not found.");
    await projectInOrg(env.projectId, ctx.org.id);
    const all = await db.select().from(schema.environment).where(eq(schema.environment.projectId, env.projectId));
    if (all.length <= 1) throw new UserError("A project needs at least one environment.");
    const services = await db.select().from(schema.service).where(eq(schema.service.environmentId, environmentId));
    for (const s of services) {
      await enqueue("service.delete", { serviceId: s.id, slug: s.slug, type: s.type, removeVolumes: true });
    }
    await db.delete(schema.environment).where(eq(schema.environment.id, environmentId));
    return null;
  });
}

const varsSchema = z.array(
  z.object({
    key: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "Variable names use letters, numbers and underscores"),
    value: z.string(),
  }),
);

export async function saveSharedVars(environmentId: string, vars: z.input<typeof varsSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
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
        await tx
          .insert(schema.sharedVar)
          .values(data.map((v) => ({ id: newId(), environmentId, key: v.key, value: encrypt(v.value) })));
      }
    });
    return null;
  });
}

/** Queue redeploys for every service in an environment (after shared variable changes). */
export async function redeployEnvironment(environmentId: string) {
  return act(async () => {
    const ctx = await requireOrg();
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
