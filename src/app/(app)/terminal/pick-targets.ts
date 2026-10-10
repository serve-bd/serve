import { asc, eq } from "drizzle-orm";
import type { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { canManageServer } from "@/server/servers/access";
import type { PickServer, PickService } from "./terminal-picker";

/** Servers this member manages, and services whose console it may open: what Terminal and Files offer. */
export async function pickTargets(ctx: Awaited<ReturnType<typeof requireOrg>>): Promise<{ servers: PickServer[]; services: PickService[] }> {
  const allServers = await db
    .select({
      id: schema.server.id,
      name: schema.server.name,
      isLocal: schema.server.isLocal,
      username: schema.server.username,
      status: schema.server.status,
      ownerOrganizationId: schema.server.ownerOrganizationId,
    })
    .from(schema.server)
    .orderBy(asc(schema.server.name));
  const servers: PickServer[] = allServers.filter((s) => canManageServer(ctx, s)).map(({ ownerOrganizationId: _, ...s }) => s);
  const serverName = new Map(allServers.map((s) => [s.id, s.name]));
  const services: PickService[] = ctx.can("console.access")
    ? (
        await db
          .select({
            id: schema.service.id,
            name: schema.service.name,
            type: schema.service.type,
            icon: schema.service.icon,
            status: schema.service.status,
            database: schema.service.database,
            serverId: schema.service.serverId,
            projectId: schema.project.id,
            projectName: schema.project.name,
            environmentName: schema.environment.name,
          })
          .from(schema.service)
          .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
          .innerJoin(schema.environment, eq(schema.service.environmentId, schema.environment.id))
          .where(eq(schema.project.organizationId, ctx.org.id))
          .orderBy(asc(schema.project.name), asc(schema.environment.name), asc(schema.service.name))
      )
        .filter((s) => ctx.canAccessProject(s.projectId))
        // The database settings hold a password: only the engine goes to the page.
        .map(({ database, serverId, ...s }) => ({ ...s, engine: database?.engine ?? null, serverName: serverName.get(serverId) ?? "" }))
    : [];

  return { servers, services };
}
