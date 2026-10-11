import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { BuildConfig, RuntimeConfig, VolumeMount } from "@/server/services/types";

/**
 * serve.json: settings kept in the repository next to the code. Read on each new deploy of a Git
 * or CLI source; what it sets wins over the dashboard then. Changes made in the dashboard stay
 * until the next new deploy (a redeploy keeps them), so a setting can be tried without a commit.
 *
 * Only settings that cannot reach past the app are allowed: no secrets, host paths, host ports,
 * privileges, servers or domains. Unknown keys are errors, so a typo is never silently ignored.
 */
export const SERVE_CONFIG_FILE = "serve.json";
export const SERVE_CONFIG_SCHEMA_URL = "https://serve.bd/schema/serve.json";
/** The file is settings, not data: anything bigger is a mistake. */
export const SERVE_CONFIG_MAX_BYTES = 256_000;

const cron = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((s) => {
    try {
      CronExpressionParser.parse(s);
      return true;
    } catch {
      return false;
    }
  }, "Use a cron expression like 0 3 * * * (every day at 03:00)");

const command = z.string().trim().min(1, "Enter a command").max(4000);
// A path inside the repository: relative, never leaving it.
const repoPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."), "Use a path inside the repository, like docker/Dockerfile");
const absolute = z
  .string()
  .trim()
  .regex(/^\/[^:]*$/, "Use an absolute path, like /data")
  .max(500);

const build = z
  .strictObject({
    builder: z.enum(["auto", "dockerfile", "nixpacks", "railpack", "buildpacks", "static"]),
    dockerfile: repoPath,
    target: z.string().trim().min(1).max(200),
    buildpacksBuilder: z
      .string()
      .trim()
      .max(300)
      .regex(/^[a-z0-9][a-z0-9._/:@-]*$/i, "Use an image name like heroku/builder:24"),
    installCommand: command,
    buildCommand: command,
    startCommand: command,
    publishDir: repoPath,
    args: z.record(z.string().trim().min(1).max(200), z.string().max(4000)).refine((r) => Object.keys(r).length <= 100, "Use at most 100 build arguments"),
    noCache: z.boolean(),
    timeoutMinutes: z.number().int().min(1).max(240),
    submodules: z.boolean(),
    watchPaths: z.array(z.string().trim().min(1).max(300)).max(50),
  })
  .partial();

const deploy = z
  .strictObject({
    startCommand: command,
    entrypoint: z.array(z.string().max(4000)).min(1).max(100),
    workingDir: absolute,
    user: z.string().regex(/^[a-zA-Z0-9_.-]+(:[a-zA-Z0-9_.-]+)?$/, "Use a user like node or 1000:1000"),
    port: z.number().int().min(1).max(65535),
    replicas: z.number().int().min(1),
    strategy: z.enum(["rolling", "recreate"]),
    drainSeconds: z.number().int().min(0).max(600),
    preDeployCommand: command,
    postDeployCommand: command,
    restartPolicy: z.enum(["always", "unless-stopped", "on-failure", "no"]),
    crashLimit: z.number().int().min(1).max(1000).nullable(),
    stopSignal: z.enum(["SIGTERM", "SIGINT", "SIGQUIT", "SIGHUP", "SIGUSR1", "SIGUSR2"]),
    stopTimeout: z.number().int().min(0).max(3600),
    init: z.boolean(),
    restartSchedule: cron,
  })
  .partial();

const healthcheck = z
  .strictObject({
    path: z
      .string()
      .trim()
      .max(300)
      .regex(/^\/[A-Za-z0-9._~%/?=&+,:@!*()-]*$/, "Use a path like /health"),
    port: z.number().int().min(1).max(65535),
    timeout: z.number().int().min(10).max(1800),
    interval: z.number().int().min(1).max(300),
    startPeriod: z.number().int().min(0).max(1800),
    status: z.string().regex(/^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/, "Use a status or range like 200-399"),
    successes: z.number().int().min(1).max(20),
  })
  .partial();

const resources = z
  .strictObject({
    /** CPU cores, like 0.5 or 2. */
    cpu: z.number().min(0.05).max(256),
    /** Megabytes. */
    memory: z
      .number()
      .int()
      .min(16)
      .max(1024 * 1024),
    memoryReservation: z
      .number()
      .int()
      .min(16)
      .max(1024 * 1024),
    shm: z.number().int().min(1).max(65536),
    logMaxSizeMb: z.number().int().min(1).max(1024),
    logMaxFiles: z.number().int().min(1).max(50),
  })
  .partial();

const task = z.strictObject({
  name: z.string().trim().min(1).max(100),
  schedule: cron,
  command,
  /** Seconds. */
  timeout: z.number().int().min(10).max(86_400).optional(),
  enabled: z.boolean().optional(),
});

const volume = z.strictObject({
  name: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9][\w.-]*$/, "Volume names use letters, numbers, dots and dashes")
    .max(200),
  path: absolute,
  readOnly: z.boolean().optional(),
});

const file = z.strictObject({
  path: absolute,
  content: z.string().max(256_000, "Files are limited to 250 KB"),
});

export const serveConfigSchema = z
  .strictObject({
    $schema: z.string().max(500).optional(),
    build: build.optional(),
    deploy: deploy.optional(),
    healthcheck: healthcheck.optional(),
    resources: resources.optional(),
    tasks: z.array(task).max(50).optional(),
    volumes: z.array(volume).max(50).optional(),
    files: z.array(file).max(20).optional(),
    variables: z
      .strictObject({
        /** Names that must have a value before the app is built. Values stay in the dashboard. */
        required: z
          .array(
            z
              .string()
              .trim()
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use variable names like DATABASE_URL"),
          )
          .max(200),
      })
      .partial()
      .optional(),
  })
  .superRefine((c, ctx) => {
    const names = new Set<string>();
    for (const [i, t] of (c.tasks ?? []).entries()) {
      if (names.has(t.name)) ctx.addIssue({ code: "custom", path: ["tasks", i, "name"], message: `Two tasks are named "${t.name}". Give each task its own name.` });
      names.add(t.name);
    }
    const mounted = new Set<string>();
    const mounts = [...(c.volumes ?? []).map((v, i) => ["volumes", i, v.path] as const), ...(c.files ?? []).map((f, i) => ["files", i, f.path] as const)];
    for (const [list, i, p] of mounts) {
      const norm = p.length > 1 ? p.replace(/\/+$/, "") : p;
      if (norm === "/") ctx.addIssue({ code: "custom", path: [list, i, "path"], message: "Mount a path inside the container, like /data, not / itself." });
      else if (mounted.has(norm)) ctx.addIssue({ code: "custom", path: [list, i, "path"], message: `${norm} is mounted twice.` });
      mounted.add(norm);
    }
    if (c.resources?.memoryReservation && c.resources.memory && c.resources.memoryReservation > c.resources.memory)
      ctx.addIssue({ code: "custom", path: ["resources", "memoryReservation"], message: "The reservation must not be above the memory limit." });
  });

export type ServeConfig = z.infer<typeof serveConfigSchema>;

/** Readable problems, one per line, each starting with where it is: "tasks[0].schedule: …". */
export function parseServeConfig(text: string): { config: ServeConfig } | { errors: string[] } {
  if (Buffer.byteLength(text) > SERVE_CONFIG_MAX_BYTES) return { errors: [`${SERVE_CONFIG_FILE} is larger than ${SERVE_CONFIG_MAX_BYTES / 1000} KB.`] };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return { errors: [`${SERVE_CONFIG_FILE} is not valid JSON: ${(e as Error).message}`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: [`${SERVE_CONFIG_FILE} must hold one JSON object, like { "deploy": { … } }.`] };
  const result = serveConfigSchema.safeParse(raw);
  if (result.success) return { config: result.data };
  return { errors: result.error.issues.slice(0, 20).map((i) => `${where(i.path)}${issueText(i)}`) };
}

function where(path: PropertyKey[]) {
  if (!path.length) return "";
  return `${path.map((p, i) => (typeof p === "number" ? `[${p}]` : `${i ? "." : ""}${String(p)}`)).join("")}: `;
}

function issueText(i: z.core.$ZodIssue) {
  if (i.code === "unrecognized_keys") return `unknown ${i.keys.length === 1 ? "setting" : "settings"} ${i.keys.map((k) => `"${k}"`).join(", ")}`;
  return i.message;
}

/** One setting serve.json controls: where it lives in the service and the value the file gives it. */
export type FileSetting = { field: string; value: unknown };

/** A scheduled task serve.json defines. Tasks are known by name: renaming one replaces it. */
export type FileTask = { name: string; schedule: string; command: string; timeoutSeconds: number; enabled: boolean };

/** What a serve.json changes on a service, computed from the file and the current settings. */
export type ServeConfigPlan = {
  build: BuildConfig;
  runtime: RuntimeConfig;
  /** Settings the file set ("runtime.replicas", "build.dockerfile", …), with the file's value. */
  settings: FileSetting[];
  tasks: FileTask[];
  required: string[];
};

/**
 * Applies a parsed serve.json to the current build and runtime settings. Pure: the caller saves.
 * `previousMounts`: container paths the last applied file mounted, removed when it no longer lists them.
 */
export function planServeConfig(config: ServeConfig, current: { build: BuildConfig; runtime: RuntimeConfig; previousMounts?: string[] }): ServeConfigPlan {
  const settings: FileSetting[] = [];
  const build: BuildConfig = { ...current.build };
  const runtime: RuntimeConfig = { ...current.runtime };
  const setBuild = <K extends keyof BuildConfig>(key: K, value: BuildConfig[K] | undefined) => {
    if (value === undefined) return;
    build[key] = value;
    settings.push({ field: `build.${key}`, value });
  };
  const setRuntime = <K extends keyof RuntimeConfig>(key: K, value: RuntimeConfig[K] | undefined) => {
    if (value === undefined) return;
    runtime[key] = value;
    settings.push({ field: `runtime.${key}`, value });
  };

  const b = config.build ?? {};
  setBuild("builder", b.builder);
  setBuild("dockerfile", b.dockerfile);
  setBuild("target", b.target);
  setBuild("buildpacksBuilder", b.buildpacksBuilder);
  setBuild("installCommand", b.installCommand);
  setBuild("buildCommand", b.buildCommand);
  setBuild("startCommand", b.startCommand);
  setBuild("publishDir", b.publishDir);
  setBuild("buildArgs", b.args && Object.entries(b.args).map(([key, value]) => ({ key, value })));
  setBuild("noCache", b.noCache);
  setBuild("buildTimeoutMinutes", b.timeoutMinutes);
  setBuild("submodules", b.submodules);
  setBuild("watchPaths", b.watchPaths);

  const d = config.deploy ?? {};
  setRuntime("command", d.startCommand);
  setRuntime("entrypoint", d.entrypoint);
  setRuntime("workingDir", d.workingDir);
  setRuntime("user", d.user);
  setRuntime("port", d.port);
  if (d.port !== undefined) setRuntime("detectPort", false);
  setRuntime("replicas", d.replicas);
  setRuntime("deployStrategy", d.strategy);
  setRuntime("drainSeconds", d.drainSeconds);
  setRuntime("preDeployCommand", d.preDeployCommand);
  setRuntime("postDeployCommand", d.postDeployCommand);
  setRuntime("restartPolicy", d.restartPolicy);
  setRuntime("crashLimit", d.crashLimit);
  setRuntime("stopSignal", d.stopSignal);
  setRuntime("stopTimeout", d.stopTimeout);
  setRuntime("init", d.init);
  setRuntime("restartSchedule", d.restartSchedule);

  const h = config.healthcheck ?? {};
  setRuntime("healthcheckPath", h.path);
  setRuntime("healthcheckPort", h.port);
  setRuntime("healthcheckTimeout", h.timeout);
  setRuntime("healthcheckInterval", h.interval);
  setRuntime("healthcheckStartPeriod", h.startPeriod);
  setRuntime("healthcheckStatus", h.status);
  setRuntime("healthcheckSuccesses", h.successes);

  const r = config.resources ?? {};
  setRuntime("cpuLimit", r.cpu);
  setRuntime("memoryLimit", r.memory);
  setRuntime("memoryReservation", r.memoryReservation);
  setRuntime("shmSize", r.shm);
  setRuntime("logMaxSizeMb", r.logMaxSizeMb);
  setRuntime("logMaxFiles", r.logMaxFiles);

  // Mounts: the file's own (by container path) replace what was there; mounts the dashboard added
  // stay, unless the file now uses their path. Mounts an earlier file added and this one dropped go.
  if (config.volumes || config.files || current.previousMounts?.length) {
    const fileMounts: VolumeMount[] = [
      ...(config.volumes ?? []).map((v): VolumeMount => ({ kind: "volume", source: v.name, mountPath: v.path, ...(v.readOnly ? { readOnly: true } : {}) })),
      ...(config.files ?? []).map((f): VolumeMount => ({ kind: "file", source: fileSource(f.path), mountPath: f.path, content: f.content, readOnly: true })),
    ];
    const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
    const ours = new Set(fileMounts.map((m) => norm(m.mountPath)));
    const dropped = new Set((current.previousMounts ?? []).map(norm));
    const kept = current.runtime.volumes.filter((m) => !ours.has(norm(m.mountPath)) && !dropped.has(norm(m.mountPath)));
    // A file mount's content is stored under its name: two of them must never share one.
    const taken = new Set(kept.filter((m) => m.kind === "file").map((m) => m.source));
    for (const m of fileMounts) {
      if (m.kind !== "file") continue;
      let name = m.source;
      for (let n = 2; taken.has(name); n++) name = `${m.source.slice(0, 115)}-${n}`;
      m.source = name;
      taken.add(name);
    }
    runtime.volumes = [...kept, ...fileMounts];
    if (fileMounts.length) settings.push({ field: `runtime.volumes`, value: fileMounts.map((m) => m.mountPath) });
  }

  const tasks = (config.tasks ?? []).map((t) => ({ name: t.name, schedule: t.schedule, command: t.command, timeoutSeconds: t.timeout ?? 3600, enabled: t.enabled ?? true }));
  return { build, runtime, settings, tasks, required: config.variables?.required ?? [] };
}

/** A file mount's stored name, from its container path: /app/config/app.yml → app-config-app.yml. */
export function fileSource(mountPath: string) {
  const name = mountPath
    .replace(/^\/+/, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[^\w]+/, "")
    .slice(-120);
  return name || "file";
}

/** The settings of a service as a serve.json, for "Download serve.json": only what differs from the defaults. */
export function serveConfigFrom(svc: { build: BuildConfig; runtime: RuntimeConfig; tasks: FileTask[] }, defaults: { build: BuildConfig; runtime: RuntimeConfig }): ServeConfig {
  const pick = <T extends object>(entries: [string, unknown, unknown][]) => {
    const out: Record<string, unknown> = {};
    for (const [key, value, def] of entries) {
      if (value === undefined || value === null || value === "") continue;
      if (JSON.stringify(value) === JSON.stringify(def)) continue;
      if (Array.isArray(value) && !value.length) continue;
      out[key] = value;
    }
    return Object.keys(out).length ? (out as T) : undefined;
  };
  const b = svc.build;
  const db = defaults.build;
  const r = svc.runtime;
  const dr = defaults.runtime;
  const config: ServeConfig = {
    $schema: SERVE_CONFIG_SCHEMA_URL,
    build: pick([
      ["builder", b.builder, db.builder],
      ["dockerfile", b.dockerfile, db.dockerfile],
      ["target", b.target, null],
      ["buildpacksBuilder", b.buildpacksBuilder, null],
      ["installCommand", b.installCommand, null],
      ["buildCommand", b.buildCommand, null],
      ["startCommand", b.startCommand, null],
      ["publishDir", b.publishDir, null],
      ["args", b.buildArgs?.length ? Object.fromEntries(b.buildArgs.filter((a) => a.key).map((a) => [a.key, a.value])) : undefined, undefined],
      ["noCache", b.noCache, false],
      ["timeoutMinutes", b.buildTimeoutMinutes, null],
      ["submodules", b.submodules, true],
      ["watchPaths", b.watchPaths, []],
    ]),
    deploy: pick([
      ["startCommand", r.command, null],
      ["entrypoint", r.entrypoint, null],
      ["workingDir", r.workingDir, null],
      ["user", r.user, null],
      ["port", r.port, null],
      ["replicas", r.replicas, dr.replicas],
      ["strategy", r.deployStrategy, "rolling"],
      ["drainSeconds", r.drainSeconds, null],
      ["preDeployCommand", r.preDeployCommand, null],
      ["postDeployCommand", r.postDeployCommand, null],
      ["restartPolicy", r.restartPolicy, dr.restartPolicy],
      ["stopSignal", r.stopSignal, null],
      ["stopTimeout", r.stopTimeout, null],
      ["init", r.init, false],
      ["restartSchedule", r.restartSchedule, null],
    ]),
    healthcheck: pick([
      ["path", r.healthcheckPath, null],
      ["port", r.healthcheckPort, null],
      ["timeout", r.healthcheckTimeout, null],
      ["interval", r.healthcheckInterval, null],
      ["startPeriod", r.healthcheckStartPeriod, null],
      ["status", r.healthcheckStatus, null],
      ["successes", r.healthcheckSuccesses, null],
    ]),
    resources: pick([
      ["cpu", r.cpuLimit, null],
      ["memory", r.memoryLimit, null],
      ["memoryReservation", r.memoryReservation, null],
      ["shm", r.shmSize, null],
      ["logMaxSizeMb", r.logMaxSizeMb, null],
      ["logMaxFiles", r.logMaxFiles, null],
    ]),
  };
  const volumes = r.volumes.filter((v) => v.kind === "volume" && !v.external).map((v) => ({ name: v.source, path: v.mountPath, ...(v.readOnly ? { readOnly: true } : {}) }));
  const files = r.volumes.filter((v) => v.kind === "file").map((v) => ({ path: v.mountPath, content: v.content ?? "" }));
  if (volumes.length) config.volumes = volumes;
  if (files.length) config.files = files;
  if (svc.tasks.length)
    config.tasks = svc.tasks.map((t) => ({
      name: t.name,
      schedule: t.schedule,
      command: t.command,
      ...(t.timeoutSeconds !== 3600 ? { timeout: t.timeoutSeconds } : {}),
      ...(t.enabled ? {} : { enabled: false }),
    }));
  for (const k of Object.keys(config) as (keyof ServeConfig)[]) if (config[k] === undefined) delete config[k];
  return config;
}
