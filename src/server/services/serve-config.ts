import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { requireResourceChange, runCopies } from "@/server/limits";
import { containedPath, pathsOutside, serviceHasHostAccess } from "@/server/security";
import { parseServeConfig, planServeConfig, SERVE_CONFIG_FILE, SERVE_CONFIG_MAX_BYTES } from "@/lib/serve-config";
import type { ServiceConfigFile } from "@/server/db/schema";

type Service = typeof schema.service.$inferSelect;

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

type Log = { step: (s: string) => void; line: (s: string) => void };

/**
 * Applies serve.json to the service before it is built: its settings win over the dashboard.
 * Saves and updates `service` in place, so the rest of the deploy runs with them. Throws with every
 * problem listed when the file is not valid. Its tasks wait for the new version to be live
 * (syncServeConfigTasks), so a failed deploy never runs them against the old one; `tasksNow`
 * syncs them at once (putting the file's values back from the dashboard).
 */
export async function applyServeConfig(
  service: Service,
  file: { path: string; text: string },
  ctx: { deploymentId: string; commitSha: string | null; organizationId: string; log: Log; tasksNow?: boolean },
) {
  const { log } = ctx;
  log.step(`Applying ${file.path}`);
  const parsed = parseServeConfig(file.text);
  if ("errors" in parsed) {
    throw new Error(`${file.path} has ${parsed.errors.length === 1 ? "a problem" : "problems"}. Fix it and deploy again:\n${parsed.errors.map((e) => `  ${e}`).join("\n")}`);
  }
  // What runs with host-level access is a Root admin's decision, made in the dashboard: a file
  // anyone who can push may edit must not change it.
  if (serviceHasHostAccess(service)) {
    throw new Error(
      `This service has host-level access (host paths, host ports or extra privileges), so ${file.path} cannot change it. Remove the file, or remove that access in the dashboard.`,
    );
  }
  const before = { build: service.build, runtime: service.runtime };
  const plan = planServeConfig(parsed.config, { build: service.build ?? ({} as never), runtime: service.runtime, previousMounts: service.configFile?.mounts });

  // The file is held to the organization's limits like the dashboard.
  const copies = { before: runCopies(service.type, before.runtime, service.distribution), after: runCopies(service.type, plan.runtime, service.distribution) };
  if (plan.runtime.cpuLimit !== before.runtime.cpuLimit || plan.runtime.memoryLimit !== before.runtime.memoryLimit || copies.after > copies.before) {
    await requireResourceChange(ctx.organizationId, before.runtime, { cpuLimit: plan.runtime.cpuLimit ?? null, memoryLimit: plan.runtime.memoryLimit ?? null }, copies);
  }

  const changed = plan.settings.filter((s) => {
    const [group, key] = s.field.split(".") as ["build" | "runtime", string];
    const was = (before[group] as Record<string, unknown> | null)?.[key];
    if (key === "volumes") return JSON.stringify(before.runtime.volumes) !== JSON.stringify(plan.runtime.volumes);
    return JSON.stringify(was ?? null) !== JSON.stringify(s.value ?? null);
  });
  const mounts = plan.runtime.volumes.filter((m) => [...(parsed.config.volumes ?? []), ...(parsed.config.files ?? [])].some((f) => f.path === m.mountPath)).map((m) => m.mountPath);
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
  };

  const taskLog = ctx.tasksNow && !service.parentServiceId ? await syncTasks(service.id, plan.tasks) : null;

  await db.update(schema.service).set({ build: plan.build, runtime: plan.runtime, configFile }).where(eq(schema.service.id, service.id));
  service.build = plan.build;
  service.runtime = plan.runtime;
  service.configFile = configFile;

  const parts = [`${plan.settings.length} ${plan.settings.length === 1 ? "setting" : "settings"}`];
  if (plan.tasks.length) parts.push(`${plan.tasks.length} ${plan.tasks.length === 1 ? "task" : "tasks"}`);
  log.line(`${file.path}: ${parts.join(", ")}${changed.length ? `, ${changed.length} changed` : ", nothing changed"}`);
  for (const s of changed.slice(0, 15))
    log.line(`  ${s.field}: ${show((before as Record<string, Record<string, unknown> | null>)[s.field.split(".")[0]]?.[s.field.split(".")[1]])} → ${show(s.value)}`);
  if (changed.length > 15) log.line(`  and ${changed.length - 15} more`);
  if (taskLog) for (const l of taskLog) log.line(`  ${l}`);
  if (!ctx.tasksNow && plan.tasks.length && !service.parentServiceId) log.line("  Scheduled tasks are updated once the new version is live.");
}

/**
 * After a deploy went live: the tasks of the serve.json it applied are created, updated or
 * removed to match. Previews are copies for a pull request: they never get the schedules.
 */
export async function syncServeConfigTasks(serviceId: string, deploymentId: string, log: Log) {
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  const file = service?.configFile;
  if (!file || file.deploymentId !== deploymentId) return;
  const parsed = parseServeConfig(file.text);
  if ("errors" in parsed) return;
  const plan = planServeConfig(parsed.config, { build: service.build ?? ({} as never), runtime: service.runtime, previousMounts: file.mounts });
  if (service.parentServiceId) {
    if (plan.tasks.length) log.line(`Scheduled tasks in ${file.path} are left out of pull request previews.`);
    return;
  }
  for (const l of await syncTasks(service.id, plan.tasks)) log.line(l);
}

/** The settings serve.json controlled stay as they are: the file is gone, the dashboard owns them again. */
export async function forgetServeConfig(service: Service, log: Log) {
  if (!service.configFile) return;
  log.line(`${service.configFile.path} is gone: its settings stay as they are and can be changed in the dashboard. Its tasks stay too.`);
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
async function syncTasks(serviceId: string, tasks: { name: string; schedule: string; command: string; timeoutSeconds: number; enabled: boolean }[]) {
  const existing = await db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.serviceId, serviceId));
  const out: string[] = [];
  for (const t of tasks) {
    const row = existing.find((e) => e.name === t.name);
    const values = { schedule: t.schedule, command: t.command, timeoutSeconds: t.timeoutSeconds, enabled: t.enabled, fromFile: true };
    if (!row) {
      await db.insert(schema.scheduledTask).values({ id: newId(), serviceId, name: t.name, ...values });
      out.push(`Task "${t.name}" added (${t.schedule})`);
      continue;
    }
    const same = row.fromFile && row.schedule === t.schedule && row.command === t.command && row.timeoutSeconds === t.timeoutSeconds && row.enabled === t.enabled;
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
