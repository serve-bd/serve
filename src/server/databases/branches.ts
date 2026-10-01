import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { logActivity } from "@/server/activity";
import { enqueue, type JobPayloads } from "@/server/queue";
import { serverOf } from "@/server/servers/context";
import { execCommand } from "@/server/services/exec";
import { databaseContainer } from "./container";
import { databaseUrl } from "./options";
import { engines } from "./engines";
import { privateHost } from "@/lib/hostname";
import { branchDatabaseName, previewBranchName } from "@/lib/database-branches";

type Service = typeof schema.service.$inferSelect;
type Branch = typeof schema.databaseBranch.$inferSelect;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Branch databases and roles are made of [a-z0-9_] only (branchDatabaseName), so plain quoting is safe. */
const ident = (s: string) => {
  if (!/^[a-z0-9_]+$/.test(s)) throw new Error(`Unexpected name ${s}`);
  return `"${s}"`;
};
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function branchesSupported(service: Pick<Service, "type" | "database">) {
  return service.type === "database" && service.database?.engine === "postgres";
}

/**
 * Hand every object of the branch to its role, so its login can change the schema. Statements
 * that cannot apply (objects of extensions) are skipped.
 */
const ownershipSql = (role: string) => `DO $serve$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT format('ALTER SCHEMA %I OWNER TO %I', nspname, ${literal(role)}) AS stmt FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
    UNION ALL
    SELECT format('ALTER %s %s OWNER TO %I',
        CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
        c.oid::regclass, ${literal(role)})
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT format('ALTER ROUTINE %s OWNER TO %I', p.oid::regprocedure, ${literal(role)})
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
    UNION ALL
    SELECT format('ALTER TYPE %s OWNER TO %I', t.oid::regtype, ${literal(role)})
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND t.typtype IN ('d', 'e', 'r')
  LOOP
    BEGIN
      EXECUTE r.stmt;
    EXCEPTION WHEN others THEN NULL;
    END;
  END LOOP;
END
$serve$;`;

/** Shell script that (re)creates a branch: an empty database owned by its role, filled with a copy of the main one. */
export function createScript(
  main: { username: string; password: string; database: string },
  branch: { database: string; username: string; password: string },
  scrubSql: string | null,
) {
  // Query results are not needed; errors still go to stderr.
  const psql = (database: string, quiet = true) => `psql -X -v ON_ERROR_STOP=1 -q${quiet ? " -o /dev/null" : ""} -U ${q(main.username)} -d ${q(database)}`;
  const dropDb = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${literal(branch.database)} AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${ident(branch.database)};`;
  return [
    "set -e",
    "set -o pipefail 2>/dev/null || true",
    `export PGPASSWORD=${q(main.password)}`,
    `${psql(main.database)} <<'SERVE_SQL'
${dropDb}
DO $serve$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(branch.username)}) THEN
    CREATE ROLE ${ident(branch.username)} LOGIN PASSWORD ${literal(branch.password)};
  ELSE
    ALTER ROLE ${ident(branch.username)} LOGIN PASSWORD ${literal(branch.password)};
  END IF;
END $serve$;
CREATE DATABASE ${ident(branch.database)} OWNER ${ident(branch.username)};
REVOKE CONNECT ON DATABASE ${ident(branch.database)} FROM PUBLIC;
SERVE_SQL`,
    // Streams inside the container: nothing is written to disk but the new database.
    `pg_dump -U ${q(main.username)} -d ${q(main.database)} -Fc --no-owner --no-privileges | pg_restore -U ${q(main.username)} -d ${q(branch.database)} --no-owner --no-privileges --exit-on-error`,
    `${psql(branch.database)} <<'SERVE_SQL'
${ownershipSql(branch.username)}
SERVE_SQL`,
    ...(scrubSql?.trim() ? [`${psql(branch.database)} <<'SERVE_SCRUB_SQL_END'\n${scrubSql}\nSERVE_SCRUB_SQL_END`] : []),
    `echo "SERVE_SIZE=$(${psql(main.database, false)} -At -c "SELECT pg_database_size(${literal(branch.database)})")"`,
  ].join("\n");
}

export function deleteScript(main: { username: string; password: string; database: string }, branch: { database: string; username: string }) {
  return [
    "set -e",
    `export PGPASSWORD=${q(main.password)}`,
    `psql -X -v ON_ERROR_STOP=1 -q -o /dev/null -U ${q(main.username)} -d ${q(main.database)} <<'SERVE_SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${literal(branch.database)} AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${ident(branch.database)};
DROP ROLE IF EXISTS ${ident(branch.username)};
SERVE_SQL`,
  ].join("\n");
}

async function run(service: Service, script: string, secrets: string[]) {
  const { docker } = await serverOf(service);
  const container = await databaseContainer(docker, service);
  const res = await execCommand(container.id, script, { docker, timeoutSeconds: 4 * 3600 });
  let output = res.output;
  for (const s of secrets) if (s) output = output.replaceAll(s, "***");
  if (res.timedOut) throw new Error("The copy took longer than 4 hours and was stopped.");
  if (res.exitCode !== 0) throw new Error(output.trim().split("\n").slice(-6).join("\n") || `Exited with code ${res.exitCode}`);
  return output;
}

/** Add a branch and queue its copy. */
export async function createBranch(service: Service, name: string, opts: { userId?: string | null; previewServiceId?: string | null } = {}) {
  if (!branchesSupported(service) || !service.database) throw new Error("Branches are available for PostgreSQL databases.");
  const database = branchDatabaseName(service.database.database, name);
  const [branch] = await db
    .insert(schema.databaseBranch)
    .values({
      id: newId(),
      serviceId: service.id,
      name,
      database,
      username: database,
      password: encrypt(crypto.randomBytes(18).toString("base64url")),
      createdBy: opts.userId ?? null,
      previewServiceId: opts.previewServiceId ?? null,
    })
    .returning();
  return branch;
}

export const enqueueBranchJob = (payload: JobPayloads["database.branch"], serviceId: string) =>
  enqueue("database.branch", payload, { concurrencyKey: `branch:${serviceId}`, maxAttempts: 1 });

/** Job: create, refill or remove a branch inside its database container. */
export async function runBranchJob(payload: JobPayloads["database.branch"]) {
  const [branch] = await db.select().from(schema.databaseBranch).where(eq(schema.databaseBranch.id, payload.branchId));
  if (!branch) return;
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, branch.serviceId));
  if (!service?.database) return;
  const mainPassword = decrypt(service.database.password);
  const main = { username: service.database.username, password: mainPassword, database: service.database.database };
  const branchPassword = decrypt(branch.password);

  if (payload.op === "delete") {
    try {
      if (service.status === "running") await run(service, deleteScript(main, branch), [mainPassword, branchPassword]);
    } finally {
      // A stopped database keeps the data until it runs again; the row goes either way.
      await db.delete(schema.databaseBranch).where(eq(schema.databaseBranch.id, branch.id));
    }
    return;
  }

  const scrubSql = payload.preview ? await previewScrubSql(payload.preview.previewId) : null;
  try {
    if (service.status !== "running") throw new Error(`${service.name} is not running. Start it, then reset the branch.`);
    const out = await run(service, createScript(main, { database: branch.database, username: branch.username, password: branchPassword }, scrubSql), [
      mainPassword,
      branchPassword,
    ]);
    const size = Number(out.match(/SERVE_SIZE=(\d+)/)?.[1] ?? Number.NaN);
    await db
      .update(schema.databaseBranch)
      .set({ status: "ready", error: null, copiedAt: new Date(), sizeBytes: Number.isFinite(size) ? size : null, updatedAt: new Date() })
      .where(eq(schema.databaseBranch.id, branch.id));
    await logActivity({
      projectId: service.projectId,
      action: payload.op === "reset" ? "database.branch-reset" : "database.branch-created",
      targetType: "service",
      targetId: service.id,
      message: `${payload.op === "reset" ? "Reset" : "Created"} branch ${branch.name} of ${service.name}`,
    });
  } catch (e) {
    const message = (e as Error).message.slice(0, 2000);
    await db.update(schema.databaseBranch).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(schema.databaseBranch.id, branch.id));
    // With clean-up SQL, a preview never runs on data that was meant to be cleaned.
    if (payload.preview && scrubSql?.trim()) return;
    if (!payload.preview) throw e;
  }
  if (payload.preview) {
    const { queueDeployment } = await import("@/server/services/create");
    await queueDeployment(payload.preview.previewId, "webhook", payload.preview.deployment);
  }
}

async function previewScrubSql(previewId: string) {
  const [preview] = await db.select({ parentServiceId: schema.service.parentServiceId }).from(schema.service).where(eq(schema.service.id, previewId));
  if (!preview?.parentServiceId) return null;
  const [parent] = await db.select({ previewDatabase: schema.service.previewDatabase }).from(schema.service).where(eq(schema.service.id, preview.parentServiceId));
  return parent?.previewDatabase?.scrubSql ?? null;
}

/** Queue removal of the branches that belong to these preview services. */
export async function removePreviewBranches(previewIds: string[]) {
  if (!previewIds.length) return;
  const rows = await db.select().from(schema.databaseBranch).where(inArray(schema.databaseBranch.previewServiceId, previewIds));
  for (const b of rows) {
    await db.update(schema.databaseBranch).set({ status: "deleting" }).where(eq(schema.databaseBranch.id, b.id));
    await enqueueBranchJob({ branchId: b.id, op: "delete" }, b.serviceId);
  }
}

/**
 * A pull request preview's own branch of the source database: created (or refilled) now, its
 * URL put into the preview's variable as a reference. Returns the branch to fill.
 */
export async function createPreviewBranch(preview: Service, source: Service, prNumber: number, variable: string) {
  const name = previewBranchName(prNumber);
  const [existing] = await db
    .select()
    .from(schema.databaseBranch)
    .where(and(eq(schema.databaseBranch.serviceId, source.id), eq(schema.databaseBranch.name, name)));
  const branch = existing
    ? (await db.update(schema.databaseBranch).set({ status: "resetting", previewServiceId: preview.id }).where(eq(schema.databaseBranch.id, existing.id)).returning())[0]
    : await createBranch(source, name, { previewServiceId: preview.id });
  const value = encrypt(`\${{${source.slug}.branches.${name}.DATABASE_URL}}`);
  await db
    .insert(schema.envVar)
    .values({ id: newId(), serviceId: preview.id, key: variable, value, buildTime: false, runtime: true })
    .onConflictDoUpdate({ target: [schema.envVar.serviceId, schema.envVar.key], set: { value } });
  return branch;
}

/** Variables each ready branch provides, keyed like `branches.<name>.DATABASE_URL`. */
export function branchVars(service: Service, branches: Branch[]): Record<string, string> {
  const cfg = service.database;
  if (!cfg) return {};
  const out: Record<string, string> = {};
  const host = privateHost(service);
  const port = String(engines[cfg.engine].port);
  for (const b of branches) {
    if (b.status !== "ready" && b.status !== "resetting") continue;
    const password = decrypt(b.password);
    const url = databaseUrl({ ...cfg, username: b.username, database: b.database }, { username: b.username, password, database: b.database }, host, engines[cfg.engine].port);
    const p = `branches.${b.name}.`;
    Object.assign(out, {
      [`${p}DATABASE_URL`]: url,
      [`${p}POSTGRES_URL`]: url,
      [`${p}HOST`]: host,
      [`${p}PORT`]: port,
      [`${p}USERNAME`]: b.username,
      [`${p}PASSWORD`]: password,
      [`${p}DATABASE`]: b.database,
    });
  }
  return out;
}
