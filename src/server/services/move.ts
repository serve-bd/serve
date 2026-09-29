import { and, eq, inArray, or } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull, encrypt } from "@/server/crypto";
import { UserError } from "@/server/action";
import { networkAliases } from "@/lib/hostname";
import { runServerIds } from "@/server/deploy/distribution";
import { listServiceContainers } from "@/server/docker/client";
import { ensureEnvNetwork, envNetworkName } from "@/server/docker/networks";
import { getServer } from "@/server/servers/context";
import { providedVars } from "./variables";
import { type MovePlan, type MoveService, planMove } from "./move-plan";

type Service = typeof schema.service.$inferSelect;

export type MovePreview = MovePlan & {
  target: { projectId: string; projectName: string; environmentId: string; environmentName: string };
  blockers: string[];
  /** Previews and their databases that follow the chosen services. */
  childIds: string[];
};

const light = (s: Service): MoveService => ({
  id: s.id,
  name: s.name,
  slug: s.slug,
  hostname: s.hostname ?? null,
  type: s.type,
  environmentId: s.environmentId,
  projectId: s.projectId,
  parentServiceId: s.parentServiceId ?? null,
});

/** Everything a move needs to know, checked against the organization. */
async function gather(serviceIds: string[], targetEnvironmentId: string, orgId: string) {
  const [target] = await db
    .select({ environmentId: schema.environment.id, environmentName: schema.environment.name, projectId: schema.project.id, projectName: schema.project.name })
    .from(schema.environment)
    .innerJoin(schema.project, eq(schema.environment.projectId, schema.project.id))
    .where(and(eq(schema.environment.id, targetEnvironmentId), eq(schema.project.organizationId, orgId)));
  if (!target) throw new UserError("That environment was not found.");
  const ids = [...new Set(serviceIds)];
  if (!ids.length) throw new UserError("Choose at least one service.");
  const chosen = await db
    .select({ service: schema.service })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(inArray(schema.service.id, ids), eq(schema.project.organizationId, orgId)));
  if (chosen.length !== ids.length) throw new UserError("Some of these services were not found.");
  const envIds = [...new Set(chosen.map((c) => c.service.environmentId))];
  const [sourceRows, targetRows] = await Promise.all([
    db.select().from(schema.service).where(inArray(schema.service.environmentId, envIds)),
    db.select().from(schema.service).where(eq(schema.service.environmentId, targetEnvironmentId)),
  ]);
  // Previews (and their database copies) follow their parent, at any depth.
  const moving = new Set(ids);
  const children: Service[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of sourceRows) {
      if (s.parentServiceId && moving.has(s.parentServiceId) && !moving.has(s.id)) {
        moving.add(s.id);
        children.push(s);
        grew = true;
      }
    }
  }
  const allIds = sourceRows.map((s) => s.id);
  const projectIds = [...new Set([...sourceRows.map((s) => s.projectId), target.projectId])];
  const [vars, shared, busy] = await Promise.all([
    allIds.length ? db.select().from(schema.envVar).where(inArray(schema.envVar.serviceId, allIds)) : [],
    db
      .select({ key: schema.sharedVar.key, environmentId: schema.sharedVar.environmentId, projectId: schema.sharedVar.projectId })
      .from(schema.sharedVar)
      .where(or(inArray(schema.sharedVar.environmentId, [...envIds, targetEnvironmentId]), inArray(schema.sharedVar.projectId, projectIds))),
    db
      .select({ serviceId: schema.deployment.serviceId })
      .from(schema.deployment)
      .where(and(inArray(schema.deployment.serviceId, [...moving]), inArray(schema.deployment.status, ["queued", "building", "deploying"]))),
  ]);
  return { target, chosen: chosen.map((c) => c.service), children, sourceRows, targetRows, vars, shared, busy, envIds };
}

export async function previewMove(serviceIds: string[], targetEnvironmentId: string, orgId: string): Promise<MovePreview> {
  const g = await gather(serviceIds, targetEnvironmentId, orgId);
  const blockers: string[] = [];
  for (const s of g.chosen) {
    if (s.parentServiceId) blockers.push(`${s.name} is a preview; it moves with its parent service.`);
    if (s.environmentId === targetEnvironmentId) blockers.push(`${s.name} is already in ${g.target.environmentName}.`);
  }
  if (g.busy.length) {
    const names = g.sourceRows.filter((s) => g.busy.some((b) => b.serviceId === s.id)).map((s) => s.name);
    blockers.push(`Wait for the running deployment of ${[...new Set(names)].join(", ")} to finish.`);
  }
  const vars: Record<string, { key: string; value: string }[]> = {};
  for (const v of g.vars) (vars[v.serviceId] ??= []).push({ key: v.key, value: decryptOrNull(v.value) ?? "" });
  const envKeys: Record<string, string[]> = {};
  const projectKeys: Record<string, string[]> = {};
  for (const v of g.shared) {
    if (v.environmentId) (envKeys[v.environmentId] ??= []).push(v.key);
    else if (v.projectId) (projectKeys[v.projectId] ??= []).push(v.key);
  }
  const plan = planMove({
    moving: g.chosen.filter((s) => !s.parentServiceId).map(light),
    children: g.children.map(light),
    sourceServices: g.sourceRows.map(light),
    targetServices: g.targetRows.map(light),
    vars,
    selfKeys: Object.fromEntries(g.sourceRows.map((s) => [s.id, Object.keys(providedVars(s))])),
    envKeys,
    targetEnvKeys: envKeys[targetEnvironmentId] ?? [],
    projectKeys,
    targetProjectId: g.target.projectId,
  });
  return { ...plan, target: g.target, blockers, childIds: g.children.map((c) => c.id) };
}

/** Moves the services (and their previews) in one transaction, then switches their containers' private network. */
export async function executeMove(serviceIds: string[], targetEnvironmentId: string, orgId: string) {
  const preview = await previewMove(serviceIds, targetEnvironmentId, orgId);
  if (preview.blockers.length) throw new UserError(preview.blockers[0]);
  const before = await db
    .select()
    .from(schema.service)
    .where(
      inArray(
        schema.service.id,
        preview.services.map((s) => s.id),
      ),
    );

  await db.transaction(async (tx) => {
    for (const s of preview.services) {
      await tx
        .update(schema.service)
        .set({
          projectId: preview.target.projectId,
          environmentId: targetEnvironmentId,
          name: s.newName,
          ...(s.clearHostname ? { hostname: null } : {}),
        })
        .where(eq(schema.service.id, s.id));
    }
    for (const [serviceId, list] of Object.entries(preview.rewrites)) {
      for (const v of list) {
        await tx
          .update(schema.envVar)
          .set({ value: encrypt(v.value) })
          .where(and(eq(schema.envVar.serviceId, serviceId), eq(schema.envVar.key, v.key)));
      }
    }
  });

  // Running containers leave the old environment network and join the new one, with the same names.
  const warnings: string[] = [];
  const after = await db
    .select()
    .from(schema.service)
    .where(
      inArray(
        schema.service.id,
        preview.services.map((s) => s.id),
      ),
    );
  for (const s of after) {
    const old = before.find((b) => b.id === s.id);
    if (!old) continue;
    try {
      await switchNetwork(s, old.environmentId);
    } catch (e) {
      warnings.push(`${s.name}: ${(e as Error).message}. It joins the new environment on its next deploy.`);
    }
    await (await import("@/server/proxy/nginx")).syncServiceProxy(s.id).catch(() => {});
  }
  // The private network follows the new environments (addresses and who may reach whom).
  await (await import("@/server/queue")).enqueue("mesh.sync", {}, { concurrencyKey: "mesh" }).catch(() => {});
  return { preview, warnings };
}

export async function switchNetwork(service: Service, oldEnvironmentId: string) {
  const oldNet = envNetworkName(oldEnvironmentId);
  for (const serverId of runServerIds(service.serverId, service.distribution)) {
    const ctx = await getServer(serverId);
    const containers = await listServiceContainers(service.id, false, ctx.docker);
    if (!containers.length) continue;
    const newNet = await ensureEnvNetwork(service.environmentId, ctx);
    for (const c of containers) {
      const container = ctx.docker.getContainer(c.Id);
      const info = await container.inspect();
      const current = info.NetworkSettings.Networks?.[oldNet];
      if (!current) continue;
      // Stack containers keep their own per-service aliases; apps and databases use the service's names.
      const aliases =
        service.type === "compose" ? ((current.Aliases ?? []) as string[]).filter((a) => a !== c.Id.slice(0, 12) && a !== info.Config.Hostname) : networkAliases(service);
      if (!info.NetworkSettings.Networks?.[newNet]) await ctx.docker.getNetwork(newNet).connect({ Container: c.Id, EndpointConfig: { Aliases: aliases } });
      await ctx.docker.getNetwork(oldNet).disconnect({ Container: c.Id, Force: true });
    }
  }
}
