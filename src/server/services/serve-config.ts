import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { encrypt, decryptOrNull } from "@/server/crypto";
import { newId } from "@/server/id";
import { generatedValue } from "@/server/services/generated-values";
import { requireResourceChange, runCopies } from "@/server/limits";
import { containedPath, pathsOutside, serviceHasHostAccess } from "@/server/security";
import {
  type FileHttp,
  type FileTask,
  parseServeConfig,
  planServeConfig,
  resolveServeConfig,
  SERVE_CONFIG_FILE,
  SERVE_CONFIG_MAX_BYTES,
  type ServeConfigPlan,
  type ServeSettings,
} from "@/lib/serve-config";
import type { ServiceConfigFile } from "@/server/db/schema";

type Service = typeof schema.service.$inferSelect;
type Log = { step: (s: string) => void; line: (s: string) => void };

/** The HTTP options serve.json may set (FileHttp's keys). */
const HTTP_KEYS = [
  "maxBodySize",
  "connectTimeout",
  "readTimeout",
  "websockets",
  "buffering",
  "headers",
  "securityHeaders",
  "corsOrigins",
  "wwwRedirect",
  "gzip",
  "cacheStatic",
  "redirects",
] as const satisfies readonly (keyof FileHttp)[];

/** Sections a stack sets in its compose file instead. */
const APP_ONLY = ["build", "deploy", "healthcheck", "resources", "volumes", "files"] as const;

/**
 * The serve.json of a checked-out repository or upload: the one in the root directory first (a
 * monorepo app keeps its own), else the repository's. Null when there is none. A file reached
 * through a symlink that leaves the checkout is refused, like the Dockerfile.
 */
export async function readServeConfigFile(workDir: string, rootDir: string): Promise<{ path: string; text: string } | null> {
  const dirs = [...new Set([rootDir || "/", "/"])];
  for (const dir of dirs) {
    const rel = path.posix.join(dir.replace(/^\/+/, ""), SERVE_CONFIG_FILE);
    const full = containedPath(workDir, rel, SERVE_CONFIG_FILE);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    if (!stat.isFile()) throw new Error(`${rel} is not a file.`);
    if ((await pathsOutside(workDir, [full])).length) throw new Error(`${rel} leads outside the repository.`);
    if (stat.size > SERVE_CONFIG_MAX_BYTES) throw new Error(`${rel} is larger than ${SERVE_CONFIG_MAX_BYTES / 1000} KB.`);
    return { path: rel, text: await fs.readFile(full, "utf8") };
  }
  return null;
}

const problems = (file: string, errors: string[]) =>
  new Error(`${file} has ${errors.length === 1 ? "a problem" : "problems"}. Fix it and deploy again:\n${errors.map((e) => `  ${e}`).join("\n")}`);

async function environmentName(service: Service) {
  const [env] = await db.select({ name: schema.environment.name }).from(schema.environment).where(eq(schema.environment.id, service.environmentId));
  return env?.name ?? "production";
}

/**
 * The file's settings for this service: its environment's block and, for a pull request preview,
 * the previews block merged in, checked against what the service type can take.
 */
async function settingsFor(service: Service, file: { path: string; text: string }, opts: { composeServices?: string[]; environment?: string }) {
  const parsed = parseServeConfig(file.text);
  if ("errors" in parsed) throw problems(file.path, parsed.errors);
  const environment = opts.environment ?? (await environmentName(service));
  const resolved = resolveServeConfig(parsed.config, { environment, preview: !!service.parentServiceId });
  if ("errors" in resolved) throw problems(file.path, resolved.errors);
  const s = resolved.settings;
  const errors: string[] = [];
  if (service.type === "compose") {
    for (const key of APP_ONLY) if (s[key]) errors.push(`${key}: for apps. A stack sets it in its compose file.`);
    const names = opts.composeServices ?? [];
    for (const [i, t] of (s.tasks ?? []).entries()) {
      if (t.service && names.length && !names.includes(t.service)) errors.push(`tasks[${i}].service: the compose file has no service "${t.service}" (it has ${names.join(", ")}).`);
      if (!t.service && names.length > 1) errors.push(`tasks[${i}].service: name the compose service that runs it (${names.join(", ")}).`);
    }
  } else {
    for (const [i, t] of (s.tasks ?? []).entries()) if (t.service) errors.push(`tasks[${i}].service: for stacks. An app runs tasks in its own container.`);
  }
  if (errors.length) throw problems(file.path, errors);
  return { settings: s, environment, blocks: resolved.applied, config: parsed.config };
}

/** Database services of the environment, by name, for "back up before each deploy". */
async function databaseIds(service: Service, names: string[], file: string) {
  if (!names.length) return [];
  const rows = await db
    .select({ id: schema.service.id, name: schema.service.name })
    .from(schema.service)
    .where(and(eq(schema.service.environmentId, service.environmentId), eq(schema.service.type, "database"), inArray(schema.service.name, names)));
  const missing = names.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length)
    throw new Error(`${file}: deploy.backupBefore names ${missing.join(", ")}, which ${missing.length === 1 ? "is not a database" : "are not databases"} in this environment.`);
  return names.map((n) => rows.find((r) => r.name === n)!.id);
}

/**
 * Applies serve.json to the service before it is built: its settings and variables win over the
 * dashboard. Saves and updates `service` in place, so the rest of the deploy runs with them.
 * Throws with every problem listed when the file is not valid. What only matters once the new
 * version runs (tasks, HTTP options, the uptime check) waits for it to be live (finishServeConfig),
 * so a failed deploy never changes them; `now` applies them at once (putting the file's values
 * back from the dashboard). Returns whether variables changed, so the caller reads them again.
 */
export async function applyServeConfig(
  service: Service,
  file: { path: string; text: string },
  ctx: { deploymentId: string; commitSha: string | null; organizationId: string; log: Log; now?: boolean; composeServices?: string[] },
) {
  const { log } = ctx;
  log.step(`Applying ${file.path}`);
  // What runs with host-level access is a Root admin's decision, made in the dashboard: a file
  // anyone who can push may edit must not change it.
  if (serviceHasHostAccess(service)) {
    throw new Error(
      `This service has host-level access (host paths, host ports or extra privileges), so ${file.path} cannot change it. Remove the file, or remove that access in the dashboard.`,
    );
  }
  const { settings, environment, blocks } = await settingsFor(service, file, ctx);
  const before = { build: service.build, runtime: service.runtime };
  const plan = planServeConfig(settings, { build: service.build ?? ({} as never), runtime: service.runtime, previousMounts: service.configFile?.mounts });
  if (plan.backupBefore) {
    plan.runtime.backupBeforeDeploy = await databaseIds(service, plan.backupBefore, file.path);
    plan.settings.push({ field: "runtime.backupBeforeDeploy", value: plan.runtime.backupBeforeDeploy });
  }

  // The file is held to the organization's limits like the dashboard.
  const copies = { before: runCopies(service.type, before.runtime, service.distribution), after: runCopies(service.type, plan.runtime, service.distribution) };
  if (plan.runtime.cpuLimit !== before.runtime.cpuLimit || plan.runtime.memoryLimit !== before.runtime.memoryLimit || copies.after > copies.before) {
    await requireResourceChange(ctx.organizationId, before.runtime, { cpuLimit: plan.runtime.cpuLimit ?? null, memoryLimit: plan.runtime.memoryLimit ?? null }, copies);
  }

  const changed = plan.settings.filter((s) => {
    const [group, key] = s.field.split(".") as [string, string];
    if (group !== "build" && group !== "runtime") return false;
    if (key === "volumes") return JSON.stringify(before.runtime.volumes) !== JSON.stringify(plan.runtime.volumes);
    const was = (before[group] as Record<string, unknown> | null)?.[key];
    return JSON.stringify(was ?? null) !== JSON.stringify(s.value ?? null);
  });
  const mounts = plan.runtime.volumes.filter((m) => [...(settings.volumes ?? []), ...(settings.files ?? [])].some((f) => f.path === m.mountPath)).map((m) => m.mountPath);
  const httpKeys = HTTP_KEYS.filter((k) => plan.http && k in plan.http);
  const previous = service.configFile;
  const httpDropped = [...new Set([...(previous?.httpKeys ?? []), ...(previous?.httpDropped ?? [])])].filter((k) => !(httpKeys as string[]).includes(k));
  const configFile: ServiceConfigFile = {
    path: file.path,
    text: file.text,
    appliedAt: new Date().toISOString(),
    deploymentId: ctx.deploymentId,
    commitSha: ctx.commitSha,
    settings: plan.settings,
    mounts,
    tasks: plan.tasks.map((t) => t.name),
    required: plan.required,
    environment,
    blocks,
    variables: plan.values.map((v) => v.key),
    generated: plan.generate.map((g) => g.key),
    httpKeys,
    httpDropped,
  };

  const varLog = await syncVariables(service.id, plan, previous?.variables ?? []);
  await db.update(schema.service).set({ build: plan.build, runtime: plan.runtime, configFile }).where(eq(schema.service.id, service.id));
  service.build = plan.build;
  service.runtime = plan.runtime;
  service.configFile = configFile;

  const parts = [`${plan.settings.length} ${plan.settings.length === 1 ? "setting" : "settings"}`];
  if (plan.tasks.length) parts.push(`${plan.tasks.length} ${plan.tasks.length === 1 ? "task" : "tasks"}`);
  if (plan.values.length + plan.generate.length) parts.push(`${plan.values.length + plan.generate.length} variables`);
  log.line(`${file.path}${blocks.length ? ` with ${blocks.join(" and ")}` : ""}: ${parts.join(", ")}${changed.length ? `, ${changed.length} changed` : ", nothing changed"}`);
  for (const s of changed.slice(0, 15)) {
    const [group, key] = s.field.split(".") as ["build" | "runtime", string];
    log.line(`  ${s.field}: ${show((before[group] as Record<string, unknown> | null)?.[key])} → ${show(s.value)}`);
  }
  if (changed.length > 15) log.line(`  and ${changed.length - 15} more`);
  for (const l of varLog) log.line(`  ${l}`);
  if (ctx.now) {
    for (const l of await finishPlan(service, plan, configFile)) log.line(`  ${l}`);
  } else if (plan.tasks.length || plan.http || plan.monitor) {
    log.line("  Scheduled tasks, HTTP options and the uptime check are updated once the new version is live.");
  }
  return { variablesChanged: varLog.length > 0 };
}

/** The build settings a second build (another CPU type) uses: the same file's, saved by the main build. */
export async function fileBuildSettings(service: Service, file: { path: string; text: string }) {
  const { settings } = await settingsFor(service, file, {});
  return planServeConfig(settings, { build: service.build ?? ({} as never), runtime: service.runtime, previousMounts: service.configFile?.mounts }).build;
}

/**
 * After a deploy went live: the tasks, HTTP options and uptime check of the serve.json it applied.
 * Previews are copies for a pull request: they never get the schedules.
 */
export async function finishServeConfig(serviceId: string, deploymentId: string, log: Log) {
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  const file = service?.configFile;
  if (!file || file.deploymentId !== deploymentId) return;
  let settings: ServeSettings;
  try {
    settings = (await settingsFor(service, file, { environment: file.environment, composeServices: [] })).settings;
  } catch {
    return;
  }
  const plan = planServeConfig(settings, { build: service.build ?? ({} as never), runtime: service.runtime, previousMounts: file.mounts });
  for (const l of await finishPlan(service, plan, file)) log.line(l);
}

async function finishPlan(service: Service, plan: ServeConfigPlan, file: ServiceConfigFile) {
  const out: string[] = [];
  if (service.parentServiceId) {
    if (plan.tasks.length) out.push(`Scheduled tasks in ${file.path} are left out of pull request previews.`);
  } else {
    out.push(...(await syncTasks(service.id, plan.tasks)));
  }
  out.push(...(await applyHttp(service, plan.http, file)));
  if (plan.monitor) out.push(...(await applyMonitor(service, plan.monitor)));
  return out;
}

/** HTTP options: the file's over the saved ones; options an earlier file set and this one dropped go back to their defaults. */
async function applyHttp(service: Service, http: FileHttp | null, file: ServiceConfigFile) {
  if (!http && !file.httpDropped.length) return [];
  const previous = service.proxy ?? null;
  const next: Record<string, unknown> = { ...(previous ?? {}) };
  for (const k of file.httpDropped) delete next[k];
  Object.assign(next, http ?? {});
  if (JSON.stringify(next) === JSON.stringify(previous ?? {})) return [];
  await db.update(schema.service).set({ proxy: next }).where(eq(schema.service.id, service.id));
  try {
    const { syncServiceProxy } = await import("@/server/proxy/nginx");
    await syncServiceProxy(service.id);
    return ["HTTP options updated"];
  } catch (error) {
    await db.update(schema.service).set({ proxy: previous }).where(eq(schema.service.id, service.id));
    return [`Warning: the proxy refused the HTTP options in ${file.path}, so the previous ones stay: ${(error as Error).message.split("\n")[0]}`];
  }
}

/** The uptime check: created, or updated where the file differs. A new setting starts a fresh status, like the dashboard. */
async function applyMonitor(service: Service, m: NonNullable<ServeConfigPlan["monitor"]>) {
  const [existing] = await db.select().from(schema.monitor).where(eq(schema.monitor.serviceId, service.id));
  if (!existing) {
    const enabled = m.enabled ?? true;
    await db.insert(schema.monitor).values({ id: newId(), serviceId: service.id, ...m, enabled, status: enabled ? "pending" : "paused" });
    return ["Uptime check added"];
  }
  const differs = Object.entries(m).some(([k, v]) => (existing as Record<string, unknown>)[k] !== v);
  if (!differs) return [];
  const enabled = m.enabled ?? existing.enabled;
  const status = enabled ? (existing.status === "down" ? "down" : "pending") : "paused";
  await db
    .update(schema.monitor)
    .set({ ...m, status, consecutiveFailures: 0, lastCheckedAt: null })
    .where(eq(schema.monitor.id, existing.id));
  if (!enabled && existing.enabled) {
    const { resolveIncident } = await import("@/server/monitoring/incidents");
    await resolveIncident(`down:${service.id}`);
  }
  return ["Uptime check updated"];
}

/**
 * Variables: the file's values are set (and removed again once the file stops listing them);
 * generated ones are made only while they have no value, and never removed: they are secrets
 * the app may have used to encrypt data.
 */
async function syncVariables(serviceId: string, plan: ServeConfigPlan, previousKeys: string[]) {
  if (!plan.values.length && !plan.generate.length && !previousKeys.length) return [];
  const rows = await db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, serviceId));
  const out: string[] = [];
  for (const v of plan.values) {
    const row = rows.find((r) => r.key === v.key);
    if (!row) {
      await db.insert(schema.envVar).values({ id: newId(), serviceId, key: v.key, value: encrypt(v.value), buildTime: v.build, runtime: v.runtime, literal: true });
      out.push(`${v.key} set`);
    } else if (decryptOrNull(row.value) !== v.value || row.buildTime !== v.build || row.runtime !== v.runtime || !row.literal) {
      await db
        .update(schema.envVar)
        .set({ value: encrypt(v.value), buildTime: v.build, runtime: v.runtime, literal: true })
        .where(eq(schema.envVar.id, row.id));
      out.push(`${v.key} updated`);
    }
  }
  for (const g of plan.generate) {
    const row = rows.find((r) => r.key === g.key);
    if (row && decryptOrNull(row.value)) continue;
    const value = encrypt(generatedValue(g.kind));
    if (row) await db.update(schema.envVar).set({ value, literal: true }).where(eq(schema.envVar.id, row.id));
    else await db.insert(schema.envVar).values({ id: newId(), serviceId, key: g.key, value, buildTime: false, runtime: true, literal: true });
    out.push(`${g.key} generated`);
  }
  // A key now generated stays: it holds the value the file set before, which the app may rely on.
  const dropped = previousKeys.filter((k) => !plan.values.some((v) => v.key === k) && !plan.generate.some((g) => g.key === k));
  if (dropped.length) {
    await db.delete(schema.envVar).where(and(eq(schema.envVar.serviceId, serviceId), inArray(schema.envVar.key, dropped)));
    for (const k of dropped) out.push(`${k} removed`);
  }
  return out;
}

/** The settings serve.json controlled stay as they are: the file is gone, the dashboard owns them again. */
export async function forgetServeConfig(service: Service, log: Log) {
  if (!service.configFile) return;
  log.line(`${service.configFile.path} is gone: its settings, variables and tasks stay as they are and can be changed in the dashboard.`);
  await db
    .update(schema.scheduledTask)
    .set({ fromFile: false })
    .where(and(eq(schema.scheduledTask.serviceId, service.id), eq(schema.scheduledTask.fromFile, true)));
  await db.update(schema.service).set({ configFile: null }).where(eq(schema.service.id, service.id));
  service.configFile = null;
}

/** Variables serve.json requires that have no value: the deploy stops before building. */
export function missingRequired(required: string[], env: { runtime: Record<string, string>; build: Record<string, string> }) {
  return required.filter((k) => !(env.runtime[k] ?? env.build[k]));
}

/** Tasks by name: the file's are created or updated (a dashboard task of the same name is taken over), the file's old ones removed. */
async function syncTasks(serviceId: string, tasks: FileTask[]) {
  const existing = await db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.serviceId, serviceId));
  const out: string[] = [];
  for (const t of tasks) {
    const row = existing.find((e) => e.name === t.name);
    const values = { schedule: t.schedule, command: t.command, timeoutSeconds: t.timeoutSeconds, enabled: t.enabled, composeService: t.composeService ?? null, fromFile: true };
    if (!row) {
      await db.insert(schema.scheduledTask).values({ id: newId(), serviceId, name: t.name, ...values });
      out.push(`Task "${t.name}" added (${t.schedule})`);
      continue;
    }
    const same =
      row.fromFile &&
      row.schedule === t.schedule &&
      row.command === t.command &&
      row.timeoutSeconds === t.timeoutSeconds &&
      row.enabled === t.enabled &&
      (row.composeService ?? null) === (t.composeService ?? null);
    if (same) continue;
    await db.update(schema.scheduledTask).set(values).where(eq(schema.scheduledTask.id, row.id));
    out.push(row.fromFile ? `Task "${t.name}" updated` : `Task "${t.name}" is now defined in ${SERVE_CONFIG_FILE}`);
  }
  const gone = existing.filter((e) => e.fromFile && !tasks.some((t) => t.name === e.name));
  if (gone.length) {
    await db.delete(schema.scheduledTask).where(
      inArray(
        schema.scheduledTask.id,
        gone.map((g) => g.id),
      ),
    );
    for (const g of gone) out.push(`Task "${g.name}" removed`);
  }
  return out;
}

function show(v: unknown) {
  if (v === null || v === undefined || v === "") return "(none)";
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
