"use server";

import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { requireServerAdmin, resolveServerForOrg } from "@/server/servers/access";
import { getServer } from "@/server/servers/context";
import { projectInOrg } from "@/server/services/access";
import { requireRoom } from "@/server/limits";
import { adoptContainer, adoptionPlan, checkDatabaseLogin } from "@/server/adopt";

const containerInput = z.object({ serverId: z.string().min(1), containerId: z.string().regex(/^[a-f0-9]{12,64}$/) });

/** Moving takes over the container's mounts, ports and networks: Root admins only, like host paths. */
async function requireMover(serverId: string) {
  const ctx = await requirePermission("services.manage");
  if (!ctx.isInstanceAdmin || !ctx.isRoot) throw new UserError("Only admins of the Root organization can move containers into projects.");
  await requireServerAdmin(serverId);
  await resolveServerForOrg(serverId, ctx.org.id);
  return ctx;
}

/** What moving a container would make, and where it can go. Secrets stay on the server. */
export async function adoptionPreview(raw: z.input<typeof containerInput>) {
  return act(async () => {
    const { serverId, containerId } = containerInput.parse(raw);
    const ctx = await requireMover(serverId);
    const server = await getServer(serverId);
    const plan = await adoptionPlan(server, containerId);
    const loginWorks = plan.database ? await checkDatabaseLogin(server, plan, plan.database.password) : false;
    const projects = await db
      .select({ id: schema.project.id, name: schema.project.name })
      .from(schema.project)
      .where(eq(schema.project.organizationId, ctx.org.id))
      .orderBy(asc(schema.project.name));
    const envs = projects.length
      ? await db
          .select({ id: schema.environment.id, name: schema.environment.name, projectId: schema.environment.projectId })
          .from(schema.environment)
          .where(
            inArray(
              schema.environment.projectId,
              projects.map((p) => p.id),
            ),
          )
      : [];
    const { password: _password, ...database } = plan.database ?? { password: "" };
    return {
      name: plan.container.name,
      running: plan.container.running,
      image: plan.imageLabel,
      envKeys: plan.env.map((e) => e.key),
      volumes: plan.volumes.map((v) => ({ source: v.source, mountPath: v.mountPath, kind: v.kind })),
      ports: plan.ports.map((p) => `${p.bindAddress === "127.0.0.1" ? "127.0.0.1:" : ""}${p.host}→${p.container}${p.protocol === "udp" ? "/udp" : ""}`),
      networks: plan.networks,
      hostname: plan.hostname,
      notes: plan.notes,
      blockers: plan.blockers,
      database: plan.database ? { ...(database as Omit<NonNullable<typeof plan.database>, "password">), passwordFound: !!plan.database.password, loginWorks } : null,
      databaseProblems: plan.databaseProblems,
      projects: projects.map((p) => ({ ...p, environments: envs.filter((e) => e.projectId === p.id).map((e) => ({ id: e.id, name: e.name })) })),
    };
  });
}

const adoptInput = containerInput.extend({
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  name: z.string().trim().max(60).optional(),
  as: z.enum(["database", "container"]),
  mode: z.enum(["move", "copy"]).default("move"),
  password: z.string().max(500).optional(),
});

/** Moves a container into a project (a service takes its place on the same data, ports and names), or copies it. */
export async function moveContainerIntoProject(raw: z.input<typeof adoptInput>) {
  return act(async () => {
    const input = adoptInput.parse(raw);
    const ctx = await requireMover(input.serverId);
    await projectInOrg(input.projectId, ctx.org.id);
    const [env] = await db.select({ projectId: schema.environment.projectId }).from(schema.environment).where(eq(schema.environment.id, input.environmentId));
    if (env?.projectId !== input.projectId) throw new UserError("Environment not found.");
    const reserved = await requireRoom(ctx.org.id, { services: 1, type: input.as === "database" ? "database" : "app", serverId: input.serverId });
    const made = await adoptContainer({ ...input, userId: ctx.user.id }, reserved);
    await logActivity({
      userId: ctx.user.id,
      projectId: input.projectId,
      action: "service.created",
      targetType: "service",
      targetId: made.id,
      message: `${input.mode === "copy" ? "Copied" : "Moved"} container ${made.name} into the project`,
    });
    return { id: made.id, projectId: input.projectId, deploymentId: made.deploymentId };
  });
}
