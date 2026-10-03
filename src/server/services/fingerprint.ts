import crypto from "node:crypto";
import { eq, or } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
type Service = typeof schema.service.$inferSelect;

/** Stable JSON: object keys sorted, so the same settings always give the same text. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A hash of everything a deploy reads that only a deploy applies: the source, build, runtime,
 * database and compose settings, the variables and the shared variables they use. Domains,
 * maintenance and proxy settings apply on their own and are left out, and so are values stored
 * encrypted (they are compared decrypted: saving the same value again is no change).
 */
export async function configFingerprint(service: Service) {
  const [own, scope] = await Promise.all([
    db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, service.id)),
    db
      .select({ projectId: schema.environment.projectId, organizationId: schema.project.organizationId })
      .from(schema.environment)
      .innerJoin(schema.project, eq(schema.environment.projectId, schema.project.id))
      .where(eq(schema.environment.id, service.environmentId))
      .then((r) => r[0]),
  ]);
  const vars = own.map((v) => ({ key: v.key, value: decryptOrNull(v.value) ?? "", build: v.buildTime, runtime: v.runtime })).sort((a, b) => a.key.localeCompare(b.key));
  const replicaVars = Object.fromEntries(
    Object.entries(service.replicaVars ?? {}).map(([n, values]) => [n, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, decryptOrNull(v) ?? ""]))]),
  );

  // Shared variables reach a service only by reference: those its values name.
  const texts = [...vars.map((v) => v.value), ...Object.values(replicaVars).flatMap((r) => Object.values(r)), service.compose?.content ?? ""].join("\n");
  const shared = texts.includes("${{")
    ? await db
        .select()
        .from(schema.sharedVar)
        .where(
          or(
            eq(schema.sharedVar.environmentId, service.environmentId),
            scope ? eq(schema.sharedVar.projectId, scope.projectId) : undefined,
            scope ? eq(schema.sharedVar.organizationId, scope.organizationId) : undefined,
          ),
        )
    : [];
  const sharedUsed = shared
    .filter((v) => texts.includes(`.${v.key}}}`))
    .map((v) => ({ scope: v.environmentId ? "environment" : v.projectId ? "project" : "org", key: v.key, value: decryptOrNull(v.value) ?? "" }))
    .sort((a, b) => `${a.scope}.${a.key}`.localeCompare(`${b.scope}.${b.key}`));

  const source = service.source
    ? service.source.type === "git"
      ? { type: "git", repository: service.source.repository, branch: service.source.branch, credentialId: service.source.credentialId ?? null }
      : service.source.type === "image"
        ? { type: "image", image: service.source.image, registryId: service.source.registryId ?? null, registryUsername: service.source.registryUsername ?? null }
        : service.source
    : null;
  const d = service.database;
  const database = d
    ? {
        engine: d.engine,
        version: d.version,
        image: d.image,
        publicPort: d.publicPort,
        publicBind: d.publicBind,
        charset: d.charset,
        collation: d.collation,
        customConfig: d.customConfig,
        extraArgs: d.extraArgs,
        dataMountPath: d.dataMountPath,
        dataVolume: d.dataVolume,
        pgdata: d.pgdata,
        tls: d.tls,
        healthcheck: d.healthcheck,
      }
    : null;
  const c = service.compose;
  const compose = c ? { mode: c.mode, content: c.content, path: c.path, ports: c.ports, isolated: c.isolated } : null;

  const text = stable({
    type: service.type,
    serverId: service.serverId,
    hostname: service.hostname,
    distribution: service.distribution,
    source,
    // "Skip the cache once" is reset by the deploy that uses it.
    build: service.build ? { ...service.build, noCacheOnce: undefined } : null,
    runtime: service.runtime,
    database,
    compose,
    vars,
    replicaVars,
    shared: sharedUsed,
  });
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Whether settings changed since the running deployment: null when that is not known (deployed before this was recorded). */
export async function redeployNeeded(service: Service): Promise<boolean | null> {
  if (!service.currentDeploymentId) return null;
  const [dep] = await db.select({ configHash: schema.deployment.configHash }).from(schema.deployment).where(eq(schema.deployment.id, service.currentDeploymentId));
  if (!dep?.configHash) return null;
  return dep.configHash !== (await configFingerprint(service));
}
