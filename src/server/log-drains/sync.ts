import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";
import { getServer, type ServerCtx } from "@/server/servers/context";
import { serverAllowsOrg } from "@/server/servers/ownership";
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
      serviceIds: r.serviceIds?.length ? r.serviceIds : null,
      index: r.options?.index ?? null,
      sourcetype: r.options?.sourcetype ?? null,
      insecure: !!r.options?.insecure,
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
  // The table first: a config that names rows the table lacks would drop their lines. The config
  // holds the drains' tokens: readable by root only.
  await writePrivate(ctx, path.posix.join(dir, "services.csv"), csv);
  await writePrivate(ctx, path.posix.join(dir, "vector.json"), config);
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

/** Files written since the worker started: written once anyway, so older copies get the private mode too. */
const written = new Set<string>();

/** Writes a file readable by its owner only, when its content changed. */
async function writePrivate(ctx: ServerCtx, file: string, content: string) {
  const key = `${ctx.id}:${file}`;
  const current = written.has(key) ? await ctx.fs.readFile(file).catch(() => null) : null;
  if (current === content) return;
  await ctx.fs.writeFile(file, content, 0o600);
  written.add(key);
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
  // A drain with nothing picked sends nothing; with none left, Vector is not needed.
  const drains = (await enabledDrains()).filter((d) => d.projectIds?.length || d.serviceIds?.length);
  const services = await drainedServices([...new Set(drains.map((d) => d.organizationId))]);
  const servers = await db
    .select({
      id: schema.server.id,
      name: schema.server.name,
      status: schema.server.status,
      ownerOrganizationId: schema.server.ownerOrganizationId,
      organizationIds: schema.server.organizationIds,
    })
    .from(schema.server);
  await Promise.all(
    servers
      .filter((s) => s.status === "ready" && (!serverIds || serverIds.includes(s.id)) && !syncing.has(s.id))
      .map(async (s) => {
        syncing.add(s.id);
        try {
          const ctx = await getServer(s.id);
          // A server holds the drains (and service names) of the organizations it serves only: its
          // owner can read its files, and must not see other organizations' tokens.
          const here = drains.filter((d) => serverAllowsOrg(s, d.organizationId));
          const csv = servicesCsv(services.filter((r) => serverAllowsOrg(s, r.organizationId)));
          if (here.length) await ensureVector(ctx, vectorConfig(s.name, here, csv), csv);
          else await removeVector(ctx);
        } catch {
          // Unreachable right now: the next run tries again.
        } finally {
          syncing.delete(s.id);
        }
      }),
  );
}

/** The services an organization's drains can pick, with their environment for names like "api (staging)". */
export async function organizationServices(organizationId: string) {
  const rows = await db
    .select({ id: schema.service.id, name: schema.service.name, projectId: schema.service.projectId, environment: schema.environment.name, parent: schema.service.parentServiceId })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .innerJoin(schema.environment, eq(schema.service.environmentId, schema.environment.id))
    .where(eq(schema.project.organizationId, organizationId));
  // Previews come and go with their pull requests: they follow their project, not a pick.
  const envCount = new Map<string, Set<string>>();
  for (const r of rows) envCount.set(r.projectId, (envCount.get(r.projectId) ?? new Set()).add(r.environment));
  return rows
    .filter((r) => !r.parent)
    .map((r) => ({ id: r.id, projectId: r.projectId, name: (envCount.get(r.projectId)?.size ?? 0) > 1 ? `${r.name} (${r.environment})` : r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
