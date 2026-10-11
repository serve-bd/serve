import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { MONITOR_INTERVALS } from "@/lib/monitor-intervals";
import { headerName, headerValue, origin, redirectsSchema, type ProxyRedirect, type ServiceProxyConfig } from "@/server/services/proxy-config";
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
    /** Database services of the same environment, by name, backed up before the pre-deploy command. */
    backupBefore: z.array(z.string().trim().min(1).max(100)).max(20),
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
  /** Stacks: the compose service whose container runs it. */
  service: z.string().trim().min(1).max(100).optional(),
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

const varName = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use variable names like DATABASE_URL");
// A plain value: a reference reads other services' variables, which only the dashboard may grant.
const plainValue = z
  .string()
  .max(32_000)
  .refine((v) => !v.includes("${{"), "References like ${{postgres.DATABASE_URL}} are set in the dashboard, not in serve.json");
export const GENERATED = ["password", "strongPassword", "secret", "hex32", "hex16", "base64key"] as const;

const variables = z
  .strictObject({
    /** Names that must have a value before the app is built. */
    required: z.array(varName).max(200),
    /** Plain values the file sets (not secrets: those stay in the dashboard). */
    values: z.record(varName, z.union([plainValue, z.strictObject({ value: plainValue, build: z.boolean().optional(), runtime: z.boolean().optional() })])),
    /** Secrets Serve makes once, when the variable has no value yet. They never leave Serve. */
    generate: z.record(varName, z.enum(GENERATED)),
  })
  .partial();

const http = z
  .strictObject({
    maxBodySize: z
      .string()
      .trim()
      .regex(/^\d{1,6}[kmg]?$/i, "Use a size like 10m or 1g"),
    connectTimeout: z.number().int().min(1).max(3600),
    readTimeout: z.number().int().min(1).max(86_400),
    websockets: z.boolean(),
    buffering: z.boolean(),
    headers: z.record(headerName, headerValue).refine((h) => Object.keys(h).length <= 30, "Use at most 30 headers"),
    securityHeaders: z.boolean(),
    cors: z.array(origin).max(30),
    wwwRedirect: z.enum(["none", "to-apex", "to-www"]),
    gzip: z.boolean(),
    cacheStatic: z.boolean(),
    redirects: redirectsSchema,
  })
  .partial();

const monitor = z
  .strictObject({
    enabled: z.boolean(),
    /** http requests the app's primary domain; container checks the containers run. */
    kind: z.enum(["http", "container"]),
    path: z
      .string()
      .trim()
      .max(500)
      .regex(/^\/[^\s]*$/, "Start the path with /"),
    expectedStatus: z
      .string()
      .trim()
      .regex(/^\s*([1-5]xx|\d{3}(\s*-\s*\d{3})?)(\s*,\s*([1-5]xx|\d{3}(\s*-\s*\d{3})?))*\s*$/, "Use codes and ranges like 200-399, 200,204 or 2xx"),
    keyword: z.string().trim().min(1).max(200),
    /** Seconds between checks. */
    interval: z.union(MONITOR_INTERVALS.map((n) => z.literal(n)) as unknown as [z.ZodLiteral<number>, z.ZodLiteral<number>]),
    /** Milliseconds. */
    timeout: z.number().int().min(1000).max(30_000),
    /** Failed checks in a row before the app counts as down. */
    failures: z.number().int().min(1).max(10),
  })
  .partial();

/** Everything a serve.json sets for one deploy: the file, or an environment's or previews' block. */
const settingsShape = {
  build: build.optional(),
  deploy: deploy.optional(),
  healthcheck: healthcheck.optional(),
  resources: resources.optional(),
  tasks: z.array(task).max(50).optional(),
  volumes: z.array(volume).max(50).optional(),
  files: z.array(file).max(20).optional(),
  variables: variables.optional(),
  http: http.optional(),
  monitor: monitor.optional(),
};

function settingsChecks(c: z.infer<z.ZodObject<typeof settingsShape>>, ctx: z.RefinementCtx) {
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
  for (const key of Object.keys(c.variables?.generate ?? {}))
    if (key in (c.variables?.values ?? {})) ctx.addIssue({ code: "custom", path: ["variables", "generate", key], message: `${key} has a value and is generated: keep one.` });
}

const settingsSchema = z.strictObject(settingsShape).superRefine(settingsChecks);

export const serveConfigSchema = z
  .strictObject({
    $schema: z.string().max(500).optional(),
    ...settingsShape,
    /** Per environment, by name: merged over the settings above for services in that environment. */
    environments: z
      .record(z.string().trim().min(1).max(64), z.strictObject(settingsShape))
      .refine((e) => Object.keys(e).length <= 20, "Use at most 20 environments")
      .optional(),
    /** Merged last for pull request previews. */
    previews: z.strictObject(settingsShape).optional(),
  })
  .superRefine(settingsChecks);

export type ServeConfig = z.infer<typeof serveConfigSchema>;
/** The settings one deploy uses: the file with its environment's and previews' blocks merged in. */
export type ServeSettings = z.infer<typeof settingsSchema>;

/** Readable problems, one per line, each starting with where it is: "tasks[0].schedule: …". */
export function parseServeConfig(text: string): { config: ServeConfig } | { errors: string[] } {
  if (Buffer.byteLength(text) > SERVE_CONFIG_MAX_BYTES) return { errors: [`${SERVE_CONFIG_FILE} is larger than ${SERVE_CONFIG_MAX_BYTES / 1000} KB.`] };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    return { errors: [`${SERVE_CONFIG_FILE} is not valid JSON: ${(e as Error).message}`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: [`${SERVE_CONFIG_FILE} must hold one JSON object, like { "deploy": { … } }.`] };
  const result = serveConfigSchema.safeParse(raw);
  if (result.success) return { config: result.data };
  return { errors: result.error.issues.slice(0, 20).map((i) => `${where(i.path)}${issueText(i)}`) };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Objects merge key by key; anything else (lists included) is replaced. */
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(out[k]) ? merge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

/**
 * The settings of one deploy: the file, then the block of the service's environment, then the
 * previews block for a pull request preview. The result is checked again (a block may, for
 * example, give two tasks the same name).
 */
export function resolveServeConfig(config: ServeConfig, at: { environment: string; preview: boolean }): { settings: ServeSettings; applied: string[] } | { errors: string[] } {
  const { $schema: _schema, environments, previews, ...base } = config;
  let merged: Record<string, unknown> = base;
  const applied: string[] = [];
  const env = environments?.[at.environment];
  if (env) {
    merged = merge(merged, env);
    applied.push(`environments.${at.environment}`);
  }
  if (at.preview && previews) {
    merged = merge(merged, previews);
    applied.push("previews");
  }
  const result = settingsSchema.safeParse(merged);
  if (result.success) return { settings: result.data, applied };
  const from = applied.length ? ` (with ${applied.join(" and ")})` : "";
  return { errors: result.error.issues.slice(0, 20).map((i) => `${where(i.path)}${issueText(i)}${from}`) };
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
export type FileTask = { name: string; schedule: string; command: string; timeoutSeconds: number; enabled: boolean; composeService?: string | null };

/** HTTP options serve.json may set: what only shapes the app's own responses (never logins, IP lists or raw proxy code). */
export type FileHttp = Pick<
  ServiceProxyConfig,
  | "maxBodySize"
  | "connectTimeout"
  | "readTimeout"
  | "websockets"
  | "buffering"
  | "headers"
  | "securityHeaders"
  | "corsOrigins"
  | "wwwRedirect"
  | "gzip"
  | "cacheStatic"
  | "redirects"
>;

/** The uptime check serve.json sets, in the monitor table's terms. */
export type FileMonitor = Partial<{
  enabled: boolean;
  kind: "http" | "container";
  path: string;
  expectedStatus: string;
  keyword: string;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
}>;

export type FileVariable = { key: string; value: string; build: boolean; runtime: boolean };

/** What a serve.json changes on a service, computed from the file and the current settings. */
export type ServeConfigPlan = {
  build: BuildConfig;
  runtime: RuntimeConfig;
  /** Settings the file set ("runtime.replicas", "build.dockerfile", …), with the file's value. */
  settings: FileSetting[];
  tasks: FileTask[];
  required: string[];
  /** Variables with values from the file (set on every new deploy). */
  values: FileVariable[];
  /** Variables Serve generates once, by kind. */
  generate: { key: string; kind: (typeof GENERATED)[number] }[];
  /** HTTP options to merge over the saved ones; null: the file sets none. */
  http: FileHttp | null;
  monitor: FileMonitor | null;
  /** Names of the databases to back up before each deploy; null: the file does not say. */
  backupBefore: string[] | null;
};

/**
 * Applies a parsed serve.json to the current build and runtime settings. Pure: the caller saves.
 * `previousMounts`: container paths the last applied file mounted, removed when it no longer lists them.
 */
export function planServeConfig(config: ServeSettings, current: { build: BuildConfig; runtime: RuntimeConfig; previousMounts?: string[] }): ServeConfigPlan {
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

  const tasks = (config.tasks ?? []).map((t) => ({
    name: t.name,
    schedule: t.schedule,
    command: t.command,
    timeoutSeconds: t.timeout ?? 3600,
    enabled: t.enabled ?? true,
    composeService: t.service ?? null,
  }));
  const values = Object.entries(config.variables?.values ?? {}).map(([key, v]) =>
    typeof v === "string" ? { key, value: v, build: false, runtime: true } : { key, value: v.value, build: v.build ?? false, runtime: v.runtime ?? true },
  );
  const generate = Object.entries(config.variables?.generate ?? {}).map(([key, kind]) => ({ key, kind }));

  const hp = config.http;
  let http: FileHttp | null = null;
  if (hp) {
    http = {};
    const put = <K extends keyof FileHttp>(key: K, value: FileHttp[K] | undefined) => {
      if (value === undefined) return;
      http![key] = value;
      settings.push({ field: `http.${key}`, value });
    };
    put("maxBodySize", hp.maxBodySize);
    put("connectTimeout", hp.connectTimeout);
    put("readTimeout", hp.readTimeout);
    put("websockets", hp.websockets);
    put("buffering", hp.buffering);
    put("headers", hp.headers && Object.entries(hp.headers).map(([name, value]) => ({ name, value })));
    put("securityHeaders", hp.securityHeaders);
    put("corsOrigins", hp.cors);
    put("wwwRedirect", hp.wwwRedirect);
    put("gzip", hp.gzip);
    put("cacheStatic", hp.cacheStatic);
    put("redirects", hp.redirects as ProxyRedirect[] | undefined);
  }

  const m = config.monitor;
  let monitor: FileMonitor | null = null;
  if (m) {
    monitor = {};
    const put = <K extends keyof FileMonitor>(key: K, value: FileMonitor[K] | undefined) => {
      if (value === undefined) return;
      monitor![key] = value;
      settings.push({ field: `monitor.${key}`, value });
    };
    put("enabled", m.enabled);
    put("kind", m.kind);
    put("path", m.path);
    put("expectedStatus", m.expectedStatus);
    put("keyword", m.keyword);
    put("intervalSeconds", m.interval);
    put("timeoutMs", m.timeout);
    put("failureThreshold", m.failures);
  }

  return {
    build,
    runtime,
    settings,
    tasks,
    required: config.variables?.required ?? [],
    values,
    generate,
    http,
    monitor,
    backupBefore: config.deploy?.backupBefore ?? null,
  };
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
export function serveConfigFrom(
  svc: {
    build: BuildConfig;
    runtime: RuntimeConfig;
    tasks: FileTask[];
    /** Stacks: only tasks, HTTP options and the uptime check (the rest is in the compose file). */
    compose?: boolean;
    proxy?: ServiceProxyConfig | null;
    monitor?: (Required<Omit<FileMonitor, "keyword">> & { keyword: string | null }) | null;
  },
  defaults: { build: BuildConfig; runtime: RuntimeConfig },
): ServeConfig {
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
  if (svc.compose) for (const key of ["build", "deploy", "healthcheck", "resources", "volumes", "files"] as const) delete config[key];
  if (svc.tasks.length)
    config.tasks = svc.tasks.map((t) => ({
      name: t.name,
      schedule: t.schedule,
      command: t.command,
      ...(t.timeoutSeconds !== 3600 ? { timeout: t.timeoutSeconds } : {}),
      ...(t.enabled ? {} : { enabled: false }),
      ...(svc.compose && t.composeService ? { service: t.composeService } : {}),
    }));
  const p = svc.proxy;
  if (p) {
    config.http = pick([
      ["maxBodySize", p.maxBodySize, null],
      ["connectTimeout", p.connectTimeout, null],
      ["readTimeout", p.readTimeout, null],
      ["websockets", p.websockets, true],
      ["buffering", p.buffering, true],
      ["headers", p.headers?.length ? Object.fromEntries(p.headers.map((h) => [h.name, h.value])) : undefined, undefined],
      ["securityHeaders", p.securityHeaders, false],
      ["cors", p.corsOrigins, []],
      ["wwwRedirect", p.wwwRedirect, "none"],
      ["gzip", p.gzip, true],
      ["cacheStatic", p.cacheStatic, false],
      ["redirects", p.redirects, []],
    ]);
  }
  const m = svc.monitor;
  if (m)
    config.monitor = pick([
      ["enabled", m.enabled, true],
      ["kind", m.kind, "http"],
      ["path", m.path, "/"],
      ["expectedStatus", m.expectedStatus, "200-399"],
      ["keyword", m.keyword, null],
      ["interval", m.intervalSeconds, 60],
      ["timeout", m.timeoutMs, 10_000],
      ["failures", m.failureThreshold, 3],
    ]) ?? { enabled: true };
  for (const k of Object.keys(config) as (keyof ServeConfig)[]) if (config[k] === undefined) delete config[k];
  return config;
}
