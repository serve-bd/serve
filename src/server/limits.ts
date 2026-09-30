import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { UserError } from "@/server/action";
import { getSettings } from "@/server/settings";
import { type CountedLimit, DEFAULT_RESERVATION, firstOverLimit, formatLimitValue, limitCatalog, limitError, type OrgLimits, type Usage, usageLevel } from "@/lib/limits";

/**
 * Limits per organization. Root admins set them; every create and deploy path
 * checks here. The Root organization is unlimited unless limits are set for it.
 */

type ServiceType = "app" | "compose" | "database";

/** Limits that apply to an organization: its own, else the instance defaults (none for Root). */
export async function effectiveLimits(organizationId: string): Promise<OrgLimits> {
  const [[row], settings] = await Promise.all([
    db
      .select({ custom: schema.organizationLimit.custom, limits: schema.organizationLimit.limits })
      .from(schema.organizationLimit)
      .where(eq(schema.organizationLimit.organizationId, organizationId)),
    getSettings(),
  ]);
  if (row?.custom) return row.limits;
  return organizationId === settings.rootOrganizationId ? {} : (settings.defaultOrgLimits ?? {});
}

/** What a service counts as against the CPU and memory limits. */
export function serviceReservation(runtime: { cpuLimit?: number | null; memoryLimit?: number | null } | null | undefined, limits: OrgLimits) {
  return {
    cpu: runtime?.cpuLimit ?? (limits.cpu != null ? (limits.defaultCpu ?? DEFAULT_RESERVATION.cpu) : 0),
    memory: runtime?.memoryLimit ?? (limits.memory != null ? (limits.defaultMemory ?? DEFAULT_RESERVATION.memory) : 0),
  };
}

/** Current usage of every counted limit. */
export async function orgUsage(organizationId: string, limits?: OrgLimits): Promise<Required<Usage>> {
  const lim = limits ?? (await effectiveLimits(organizationId));
  const services = await db
    .select({ id: schema.service.id, type: schema.service.type, runtime: schema.service.runtime, serverId: schema.service.serverId })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.project.id, schema.service.projectId))
    .where(eq(schema.project.organizationId, organizationId));
  const ids = services.map((s) => s.id);
  const [[projects], [domains], [builds], [backups], [disk]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(schema.project).where(eq(schema.project.organizationId, organizationId)),
    ids.length ? db.select({ n: sql<number>`count(*)::int` }).from(schema.domain).where(inArray(schema.domain.serviceId, ids)) : [{ n: 0 }],
    ids.length
      ? db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.deployment)
          .where(and(inArray(schema.deployment.serviceId, ids), inArray(schema.deployment.status, ["building", "deploying"])))
      : [{ n: 0 }],
    ids.length
      ? db
          .select({ bytes: sql<number>`coalesce(sum(${schema.backup.size}), 0)::float8` })
          .from(schema.backup)
          .where(and(inArray(schema.backup.serviceId, ids), eq(schema.backup.status, "success")))
      : [{ bytes: 0 }],
    db.select({ bytes: schema.organizationLimit.diskBytes }).from(schema.organizationLimit).where(eq(schema.organizationLimit.organizationId, organizationId)),
  ]);
  let cpu = 0;
  let memory = 0;
  for (const s of services) {
    const r = serviceReservation(s.runtime, lim);
    cpu += r.cpu;
    memory += r.memory;
  }
  const count = (t: ServiceType) => services.filter((s) => s.type === t).length;
  return {
    projects: projects?.n ?? 0,
    services: services.length,
    apps: count("app"),
    compose: count("compose"),
    databases: count("database"),
    domains: domains?.n ?? 0,
    cpu: Math.round(cpu * 100) / 100,
    memory,
    disk: (disk?.bytes ?? 0) / 1e9,
    backupStorage: Number(backups?.bytes ?? 0) / 1e9,
    concurrentBuilds: builds?.n ?? 0,
    servers: new Set(services.map((s) => s.serverId)).size,
  };
}

/** Whether the organization may use this server (allow list and number of servers). */
export function serverProblem(limits: OrgLimits, usedServers: Set<string>, serverId: string | null | undefined) {
  if (!serverId) return null;
  if (limits.allowedServers && !limits.allowedServers.includes(serverId)) return "This organization may not use that server. Ask an administrator to allow it.";
  if (limits.servers != null && !usedServers.has(serverId) && usedServers.size + 1 > limits.servers) {
    return `This organization has reached its servers limit (${usedServers.size} of ${limits.servers} used). Deploy to a server it already uses, or ask an administrator to raise it.`;
  }
  return null;
}

export type Room = {
  projects?: number;
  /** One new service of this type (gets the default CPU and memory when a limit applies). */
  services?: number;
  type?: ServiceType;
  /** Several services at once, like an environment clone. Pass their CPU and memory totals too. */
  byType?: Partial<Record<ServiceType, number>>;
  domains?: number;
  cpu?: number;
  memory?: number;
  serverId?: string | null;
};

const typeKey = { app: "apps", compose: "compose", database: "databases" } as const;

/**
 * Throws a clear error when adding these would go over a limit. Returns the CPU and
 * memory a new service without its own limits should get (null when no limit applies).
 */
export async function requireRoom(organizationId: string, room: Room): Promise<{ cpuLimit: number | null; memoryLimit: number | null }> {
  const limits = await effectiveLimits(organizationId);
  const single = !!room.services && !room.byType;
  const reservation = {
    cpuLimit: single && limits.cpu != null ? (room.cpu ?? limits.defaultCpu ?? DEFAULT_RESERVATION.cpu) : null,
    memoryLimit: single && limits.memory != null ? (room.memory ?? limits.defaultMemory ?? DEFAULT_RESERVATION.memory) : null,
  };
  if (!Object.keys(limits).length) return reservation;
  const usage = await orgUsage(organizationId, limits);
  const byType: Partial<Record<ServiceType, number>> = room.byType ?? (room.type && room.services ? { [room.type]: room.services } : {});
  const newServices = room.byType ? Object.values(byType).reduce((a, b) => a + (b ?? 0), 0) : (room.services ?? 0);
  const adds: Partial<Record<CountedLimit, number>> = {
    projects: room.projects ?? 0,
    services: newServices,
    domains: room.domains ?? 0,
    cpu: single ? (reservation.cpuLimit ?? 0) : (room.cpu ?? 0),
    memory: single ? (reservation.memoryLimit ?? 0) : (room.memory ?? 0),
  };
  for (const [t, n] of Object.entries(byType) as [ServiceType, number][]) adds[typeKey[t]] = n;
  const problem = firstOverLimit(limits, usage, adds);
  if (problem) {
    void noteLimitReached(organizationId, problem.key, usage[problem.key], limits[problem.key] ?? 0);
    throw new UserError(problem.message);
  }
  if (room.serverId) {
    // Its own servers are outside the allow list and the servers limit: those govern shared servers.
    const [own] = await db.select({ owner: schema.server.ownerOrganizationId }).from(schema.server).where(eq(schema.server.id, room.serverId));
    if (own?.owner !== organizationId) {
      const servers = await usedServerIds(organizationId);
      const problem = serverProblem(limits, servers, room.serverId);
      if (problem) throw new UserError(problem);
    }
  }
  return reservation;
}

/** Room for copies of existing services (environment clones, previews), with their own CPU and memory. */
export async function requireRoomFor(organizationId: string, services: { type: string; runtime: { cpuLimit?: number | null; memoryLimit?: number | null } | null }[]) {
  if (!services.length) return;
  const limits = await effectiveLimits(organizationId);
  if (!Object.keys(limits).length) return;
  const byType: Partial<Record<ServiceType, number>> = {};
  let cpu = 0;
  let memory = 0;
  for (const s of services) {
    const t = s.type as ServiceType;
    byType[t] = (byType[t] ?? 0) + 1;
    const r = serviceReservation(s.runtime, limits);
    cpu += r.cpu;
    memory += r.memory;
  }
  await requireRoom(organizationId, { byType, cpu, memory });
}

/** Like requireRoom, but answers instead of throwing. */
export async function hasRoom(organizationId: string, room: Room) {
  try {
    await requireRoom(organizationId, room);
    return true;
  } catch (e) {
    if (e instanceof UserError) return false;
    throw e;
  }
}

/** A new service's runtime with the CPU and memory it counts as, when it has none of its own. */
export function withReservation<R extends { cpuLimit?: number | null; memoryLimit?: number | null }>(
  runtime: R,
  reserved: { cpuLimit: number | null; memoryLimit: number | null },
): R {
  return { ...runtime, cpuLimit: runtime.cpuLimit ?? reserved.cpuLimit ?? null, memoryLimit: runtime.memoryLimit ?? reserved.memoryLimit ?? null };
}

/** Whether a counted limit still has room (see requireNotOver). */
export async function hasRoomFor(organizationId: string, key: CountedLimit) {
  try {
    await requireNotOver(organizationId, key);
    return true;
  } catch (e) {
    if (e instanceof UserError) {
      const limits = await effectiveLimits(organizationId);
      const usage = await orgUsage(organizationId, limits);
      void noteLimitReached(organizationId, key, usage[key], limits[key] ?? 0);
      return false;
    }
    throw e;
  }
}

/** Throws when a counted limit is already over (for example backup storage before a backup). */
export async function requireNotOver(organizationId: string, key: CountedLimit) {
  const limits = await effectiveLimits(organizationId);
  if (limits[key] == null) return;
  const usage = await orgUsage(organizationId, limits);
  // Full counts as over here: the next backup or volume would add to it.
  if (usage[key] >= (limits[key] ?? 0)) throw new UserError(limitError(key, usage[key], 1, limits[key]) ?? "Limit reached.");
}

async function usedServerIds(organizationId: string) {
  const rows = await db
    .selectDistinct({ serverId: schema.service.serverId })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.project.id, schema.service.projectId))
    .innerJoin(schema.server, eq(schema.server.id, schema.service.serverId))
    // Its own servers do not count toward the servers limit.
    .where(and(eq(schema.project.organizationId, organizationId), sql`${schema.server.ownerOrganizationId} is distinct from ${organizationId}`));
  return new Set(rows.map((r) => r.serverId));
}

/** A service's CPU or memory limit changes: the new totals must fit. */
export async function requireResourceChange(
  organizationId: string,
  current: { cpuLimit?: number | null; memoryLimit?: number | null },
  next: { cpuLimit?: number | null; memoryLimit?: number | null },
) {
  const limits = await effectiveLimits(organizationId);
  if (limits.cpu == null && limits.memory == null) return;
  if (limits.cpu != null && next.cpuLimit === null) throw new UserError("This organization has a CPU limit, so every service needs a CPU limit.");
  if (limits.memory != null && next.memoryLimit === null) throw new UserError("This organization has a memory limit, so every service needs a memory limit.");
  const before = serviceReservation(current, limits);
  const after = serviceReservation(
    { cpuLimit: next.cpuLimit === undefined ? current.cpuLimit : next.cpuLimit, memoryLimit: next.memoryLimit === undefined ? current.memoryLimit : next.memoryLimit },
    limits,
  );
  const usage = await orgUsage(organizationId, limits);
  for (const key of ["cpu", "memory"] as const) {
    const delta = after[key] - before[key];
    if (delta <= 0) continue;
    const error = limitError(key, usage[key], delta, limits[key]);
    if (error) throw new UserError(error);
  }
}

/** A deploy may start when the organization has a free build slot. */
export async function buildSlotFree(organizationId: string, deploymentId: string) {
  const limits = await effectiveLimits(organizationId);
  if (limits.concurrentBuilds == null) return true;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.deployment)
    .innerJoin(schema.service, eq(schema.service.id, schema.deployment.serviceId))
    .innerJoin(schema.project, eq(schema.project.id, schema.service.projectId))
    .where(and(eq(schema.project.organizationId, organizationId), inArray(schema.deployment.status, ["building", "deploying"]), sql`${schema.deployment.id} <> ${deploymentId}`));
  return (row?.n ?? 0) < Math.max(1, limits.concurrentBuilds);
}

/** Tells the organization once when a limit fills up (again after usage dropped below it). */
async function noteLimitReached(organizationId: string, key: CountedLimit, used: number, limit: number) {
  try {
    const [row] = await db
      .select({ notified: schema.organizationLimit.notified })
      .from(schema.organizationLimit)
      .where(eq(schema.organizationLimit.organizationId, organizationId));
    if (row?.notified.includes(key)) return;
    await db
      .insert(schema.organizationLimit)
      .values({ organizationId, notified: [key] })
      .onConflictDoUpdate({ target: schema.organizationLimit.organizationId, set: { notified: sql`array_append(${schema.organizationLimit.notified}, ${key})` } });
    const label = limitCatalog.find((l) => l.key === key)?.label ?? key;
    const { notify } = await import("@/server/notify");
    await notify(organizationId, "org.limit", {
      ok: false,
      severity: "warning",
      status: "limit reached",
      title: `${label} limit reached`,
      body: `This organization uses ${formatLimitValue(key, used)} of ${formatLimitValue(key, limit)}. New ${label.toLowerCase()} are refused until an administrator raises the limit or something is removed.`,
      url: "/organization/usage",
      data: { limit: key, used, max: limit },
    });
  } catch {
    // Notices are best effort.
  }
}

/**
 * Worker tick: announce limits that are full, and forget notices for limits that
 * have room again, so a later fill notifies again.
 */
export async function checkLimitNotices() {
  const orgs = await db.select({ id: schema.organization.id }).from(schema.organization);
  for (const { id } of orgs) {
    const limits = await effectiveLimits(id);
    if (!Object.keys(limits).length) continue;
    const usage = await orgUsage(id, limits);
    const [row] = await db.select({ notified: schema.organizationLimit.notified }).from(schema.organizationLimit).where(eq(schema.organizationLimit.organizationId, id));
    const full = limitCatalog.filter(({ key }) => key !== "concurrentBuilds" && usageLevel(usage[key], limits[key]) === "full").map((l) => l.key);
    for (const key of full) await noteLimitReached(id, key, usage[key], limits[key] ?? 0);
    const cleared = (row?.notified ?? []).filter((k) => !full.includes(k as CountedLimit));
    if (cleared.length && row) {
      await db
        .update(schema.organizationLimit)
        .set({ notified: row.notified.filter((k) => !cleared.includes(k)) })
        .where(eq(schema.organizationLimit.organizationId, id));
    }
  }
}

/**
 * Worker tick: measure volume sizes per organization (Docker reports them in `system df`).
 * Volumes are matched to services by Serve's labels or the compose project name (the slug).
 */
export async function measureOrgDisk() {
  const { getServer } = await import("@/server/servers/context");
  const services = await db
    .select({ id: schema.service.id, slug: schema.service.slug, serverId: schema.service.serverId, organizationId: schema.project.organizationId })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.project.id, schema.service.projectId));
  const byServer = new Map<string, typeof services>();
  for (const s of services) byServer.set(s.serverId, [...(byServer.get(s.serverId) ?? []), s]);
  const totals = new Map<string, number>();
  const measured = new Set<string>();
  for (const [serverId, list] of byServer) {
    try {
      const ctx = await getServer(serverId);
      const df = (await ctx.docker.df()) as { Volumes?: { Name: string; Labels?: Record<string, string> | null; UsageData?: { Size?: number } | null }[] };
      for (const v of df.Volumes ?? []) {
        const size = v.UsageData?.Size ?? 0;
        if (size <= 0) continue;
        const labels = v.Labels ?? {};
        const owner = list.find(
          (s) => labels["serve.service"] === s.id || labels["com.docker.compose.project"] === s.slug || v.Name.startsWith(`serve-${s.id}`) || v.Name.startsWith(`${s.slug}_`),
        );
        if (owner) totals.set(owner.organizationId, (totals.get(owner.organizationId) ?? 0) + size);
      }
      for (const s of list) measured.add(s.organizationId);
    } catch {
      // An unreachable server keeps its last measurement.
    }
  }
  const now = new Date();
  for (const organizationId of measured) {
    const diskBytes = totals.get(organizationId) ?? 0;
    await db
      .insert(schema.organizationLimit)
      .values({ organizationId, diskBytes, diskMeasuredAt: now })
      .onConflictDoUpdate({ target: schema.organizationLimit.organizationId, set: { diskBytes, diskMeasuredAt: now } });
  }
}
