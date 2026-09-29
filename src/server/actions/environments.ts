"use server";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { projectInOrg, serviceInOrg } from "@/server/services/access";
import { cloneEnvironment, scrubCommand } from "@/server/services/environments";
import { queueDeployment } from "@/server/services/create";

const envName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Use lowercase letters, numbers and dashes");

async function environmentInOrg(environmentId: string, orgId: string) {
  const [env] = await db.select().from(schema.environment).where(eq(schema.environment.id, environmentId));
  if (!env) throw new UserError("Environment not found.");
  await projectInOrg(env.projectId, orgId);
  return env;
}

/** Copy an environment and all its services into a new environment. Nothing is deployed. */
export async function cloneEnvironmentAction(environmentId: string, input: { name: string; generatedDomains?: boolean; copyData?: boolean }) {
  return act(async () => {
    const ctx = await requirePermission("projects.manage");
    const env = await environmentInOrg(environmentId, ctx.org.id);
    const name = envName.parse(input.name);
    const [exists] = await db
      .select({ id: schema.environment.id })
      .from(schema.environment)
      .where(and(eq(schema.environment.projectId, env.projectId), eq(schema.environment.name, name)));
    if (exists) throw new UserError("An environment with that name already exists.");
    return cloneEnvironment({
      sourceEnvironmentId: env.id,
      name,
      userId: ctx.user.id,
      generatedDomains: input.generatedDomains !== false,
      copyData: input.copyData === true,
    });
  });
}

/** Deploy every service of an environment (after a clone, for example). Previews are left alone. */
export async function deployEnvironment(environmentId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    await environmentInOrg(environmentId, ctx.org.id);
    const services = await db
      .select({ id: schema.service.id })
      .from(schema.service)
      .where(and(eq(schema.service.environmentId, environmentId), isNull(schema.service.parentServiceId)));
    for (const s of services) await queueDeployment(s.id, "manual", { userId: ctx.user.id });
    return { count: services.length };
  });
}

const previewDbSchema = z
  .object({
    sourceServiceId: z.string().min(1),
    variable: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use letters, numbers and underscores"),
    scrubSql: z.string().max(100_000).nullable().optional(),
  })
  .nullable();

/** Give each pull request preview of an app its own copy of a database (or turn that off). */
export async function savePreviewDatabase(serviceId: string, input: z.input<typeof previewDbSchema>) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.parentServiceId) throw new UserError("Preview deployments follow their parent service.");
    if (service.type !== "app" || service.source?.type !== "git") throw new UserError("Only apps deployed from Git have pull request previews.");
    const data = previewDbSchema.parse(input);
    if (data) {
      const [source] = await db
        .select()
        .from(schema.service)
        .where(and(eq(schema.service.id, data.sourceServiceId), eq(schema.service.environmentId, service.environmentId), eq(schema.service.type, "database")));
      if (!source?.database) throw new UserError("Choose a database of this environment.");
      if (data.scrubSql?.trim() && !scrubCommand(source.database, "x")) throw new UserError("Clean-up SQL works with PostgreSQL, MySQL, MariaDB and ClickHouse.");
    }
    await db
      .update(schema.service)
      .set({ previewDatabase: data ? { sourceServiceId: data.sourceServiceId, variable: data.variable, scrubSql: data.scrubSql?.trim() || null } : null })
      .where(eq(schema.service.id, serviceId));
    return null;
  });
}
