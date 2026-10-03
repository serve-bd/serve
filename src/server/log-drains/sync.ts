import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";
import { getServer, type ServerCtx } from "@/server/servers/context";
import { type DrainSpec, type ServiceRow, servicesCsv, vectorConfig } from "./config";

export const VECTOR_IMAGE = "timberio/vector:0.58.0-alpine";
const CONTAINER = "serve-log-drain";

/** The drains that are on, with their secrets read. */
export async function enabledDrains(): Promise<DrainSpec[]> {
  const rows = await db.select().from(schema.logDrain).where(eq(schema.logDrain.enabled, true));
  return rows.map((r) => {
    const secrets = JSON.parse(decryptOrNull(r.secrets) ?? "{}") as { header?: { name: string; value: string }; username?: string; password?: string };
    return {
      id: r.id,
      organizationId: r.organizationId,
      kind: r.kind,
      url: r.url,
      header: secrets.header ?? null,
      username: secrets.username ?? null,
      password: secrets.password ?? null,
      projectIds: r.projectIds?.length ? r.projectIds : null,
    };
  });
}

/** Every service of the organizations that have drains, with the names its log lines carry. */
async function drainedServices(organizationIds: string[]): Promise<ServiceRow[]> {
  if (!organizationIds.length) return [];
  const rows = await db
    .select({
      serviceId: schema.service.id,
      service: schema.service.name,
      type: schema.service.type,
      projectId: schema.project.id,
      project: schema.project.name,
      environment: schema.environment.name,
      organizationId: schema.project.organizationId,
    })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .innerJoin(schema.environment, eq(schema.service.environmentId, schema.environment.id))
    .where(inArray(schema.project.organizationId, organizationIds));
  return rows;
}

function drainDir(ctx: ServerCtx) {
  return path.posix.join(ctx.paths.root, "log-drains");
}

/** Vector on one server: its config written (only when changed) and its container running. */
async function ensureVector(ctx: ServerCtx, config: string, csv: string) {
  const dir = drainDir(ctx);
  await ctx.fs.mkdir(dir);
  // The table first: a config that names rows the table lacks would drop their lines.
  await ctx.fs.writeIfChanged(path.posix.join(dir, "services.csv"), csv);
  await ctx.fs.writeIfChanged(path.posix.join(dir, "vector.json"), config);
  const container = ctx.docker.getContainer(CONTAINER);
  const existing = await container.inspect().catch(() => null);
  if (existing && existing.Config.Image !== VECTOR_IMAGE) await container.remove({ force: true }).catch(() => {});
  if (!existing || existing.Config.Image !== VECTOR_IMAGE) {
    if (!(await imageExists(VECTOR_IMAGE, ctx.docker))) await pullImage(VECTOR_IMAGE, undefined, null, ctx.docker);
    await ctx.docker
      .createContainer({
        name: CONTAINER,
        Image: VECTOR_IMAGE,
        // It watches its config and reloads it (with the services table) when Serve rewrites it.
        Cmd: ["--config", "/etc/vector/vector.json", "--watch-config"],
        Labels: { [LABEL.managed]: "true", [LABEL.kind]: "log-drain" },
        HostConfig: {
          RestartPolicy: { Name: "unless-stopped" },
          Binds: ["/var/run/docker.sock:/var/run/docker.sock:ro", `${dir}:/etc/vector:ro`],
          Memory: 256 * 1024 * 1024,
          LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } },
        },
      })
      .catch((error) => {
        // Made by another sync meanwhile.
        if ((error as { statusCode?: number }).statusCode !== 409) throw error;
      });
    await container.start().catch((error) => {
      if ((error as { statusCode?: number }).statusCode !== 304) throw error;
    });
    return;
  }
  if (!existing.State.Running) await container.start().catch(() => {});
}

async function removeVector(ctx: ServerCtx) {
  await ctx.docker
    .getContainer(CONTAINER)
    .remove({ force: true })
    .catch(() => {});
  await ctx.fs.rm(drainDir(ctx)).catch(() => {});
}

const syncing = new Set<string>();

/**
 * Worker job (and after a drain changes): every ready server runs Vector with the drains that are
 * on, or none when there are none. Rewrites only what changed, so it is cheap to run often.
 */
export async function syncLogDrains(serverIds?: string[]) {
  const drains = await enabledDrains();
  const services = await drainedServices([...new Set(drains.map((d) => d.organizationId))]);
  const servers = await db.select({ id: schema.server.id, name: schema.server.name, status: schema.server.status }).from(schema.server);
  const csv = servicesCsv(services);
  await Promise.all(
    servers
      .filter((s) => s.status === "ready" && (!serverIds || serverIds.includes(s.id)) && !syncing.has(s.id))
      .map(async (s) => {
        syncing.add(s.id);
        try {
          const ctx = await getServer(s.id);
          if (drains.length) await ensureVector(ctx, vectorConfig(s.name, drains, csv), csv);
          else await removeVector(ctx);
        } catch {
          // Unreachable right now: the next run tries again.
        } finally {
          syncing.delete(s.id);
        }
      }),
  );
}
