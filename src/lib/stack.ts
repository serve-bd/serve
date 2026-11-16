import YAML from "yaml";
import { z } from "zod";
import { REF, SCOPE_NAMES } from "@/lib/refs";
import { issueText, settingsChecks, settingsShape, where } from "@/lib/serve-config";
import { SERVICE_NAME_RE } from "@/lib/service-name";

export { parseEnvFile } from "@/lib/env-file";

/**
 * serve-compose.yml: many services of one environment in one file, and how they connect. Applied
 * from the CLI (`serve compose up`) or the dashboard's Stack card; Serve never reads it from git.
 *
 * Two kinds of variables: `${{ db.DATABASE_URL }}` is Serve's own link, resolved at each deploy
 * (and a link to another service of the stack makes it a dependency); `${VAR}` is filled in when
 * the file is applied, from the values the CLI sends (the shell, then a .env next to the file).
 */
export const STACK_FILE = "serve-compose.yml";
export const STACK_ENGINES = ["postgres", "mysql", "mariadb", "mongodb", "redis", "valkey", "clickhouse"] as const;
export type StackEngine = (typeof STACK_ENGINES)[number];

const name = z
  .string()
  .regex(SERVICE_NAME_RE, "Use letters, numbers and dashes (it becomes the service's name)")
  .refine((n) => !SCOPE_NAMES.has(n.toLowerCase()), "This name means shared variables in ${{ }} links. Pick another.");
// A path next to the file: relative and inside its folder, so the CLI never reads elsewhere.
export const localPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((p) => !p.startsWith("/") && !p.startsWith("~") && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes(".."), "Use a path inside the stack's folder, like ./api");

const git = z.union([
  z.string().trim().min(1).max(500),
  z.strictObject({
    repo: z.string().trim().min(1).max(500),
    branch: z.string().trim().min(1).max(250).optional(),
    /** A git login's name: only that one is tried. */
    account: z.string().trim().min(1).max(200).optional(),
  }),
]);

const database = z.union([
  z.string().trim().min(1).max(100),
  z.strictObject({
    engine: z.enum(STACK_ENGINES),
    version: z.string().trim().min(1).max(50).optional(),
    username: z.string().trim().min(1).max(63).optional(),
    database: z.string().trim().min(1).max(63).optional(),
    /** Used when the database is created; later changes are made in the dashboard. */
    password: z.string().min(8, "Use at least 8 characters").max(200).optional(),
  }),
]);

const host = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/, "Use a hostname like api.example.com");
const condition = z.enum(["healthy", "started"]);
const envValue = z.union([z.string(), z.number(), z.boolean()]).transform(String);

const service = z
  .strictObject({
    git: git.optional(),
    image: z.string().trim().min(1).max(500).optional(),
    /** A local folder to upload (CLI only), or serve.json's build settings with an optional folder. */
    build: z.union([localPath, settingsShape.build.unwrap().extend({ context: localPath.optional(), rootDir: localPath.optional() })]).optional(),
    database: database.optional(),
    /** A compose file next to this one, or the compose file itself. */
    compose: z.union([localPath, z.record(z.string(), z.unknown())]).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "Use letters, numbers and underscores"), envValue).optional(),
    env_file: z.union([localPath, z.array(localPath).max(20)]).optional(),
    depends_on: z.union([z.array(z.string()).max(100), z.record(z.string(), z.strictObject({ condition: condition.default("healthy") }))]).optional(),
    /** A hostname, or { host, port, service } (service: which compose service receives it). */
    domains: z
      .array(z.union([host, z.strictObject({ host, port: z.number().int().min(1).max(65535).optional(), service: z.string().trim().min(1).max(100).optional() })]))
      .max(50)
      .optional(),
    /** A server's name; the environment's default when left out. */
    server: z.string().trim().min(1).max(100).optional(),
    deploy: settingsShape.deploy,
    healthcheck: settingsShape.healthcheck,
    resources: settingsShape.resources,
    tasks: settingsShape.tasks,
    volumes: settingsShape.volumes,
    files: settingsShape.files,
    http: settingsShape.http,
    monitor: settingsShape.monitor,
  })
  .superRefine((s, ctx) => {
    const local = typeof s.build === "string" || (typeof s.build === "object" && !!s.build.context);
    const sources = [s.git && "git", s.image && "image", local && "build", s.database && "database", s.compose && "compose"].filter(Boolean);
    if (sources.length !== 1)
      ctx.addIssue({
        code: "custom",
        path: [],
        message: sources.length ? `Pick one source, not ${sources.join(" and ")}.` : "Give a source: git, image, build (a folder), database or compose.",
      });
    if (typeof s.build === "object" && !local && !s.git) ctx.addIssue({ code: "custom", path: ["build"], message: "Build settings need git, or a folder in build.context." });
    if (s.database && (s.build || s.port || s.domains?.length)) ctx.addIssue({ code: "custom", path: [], message: "A database takes no build, port or domains." });
    const settings = (["deploy", "healthcheck", "tasks", "volumes", "files", "http", "monitor", "resources"] as const).filter((k) => s[k] !== undefined);
    if (s.database && settings.length)
      ctx.addIssue({ code: "custom", path: [settings[0]], message: "Change a database's settings in the dashboard: the file only names its engine and version." });
    settingsChecks({ ...s, build: undefined }, ctx);
  });

export const stackSchema = z.strictObject({
  $schema: z.string().max(500).optional(),
  name: name.optional(),
  services: z.record(z.string(), service).superRefine((services, ctx) => {
    if (!Object.keys(services).length) ctx.addIssue({ code: "custom", path: [], message: "List at least one service" });
    for (const key of Object.keys(services)) {
      const r = name.safeParse(key);
      if (!r.success) ctx.addIssue({ code: "custom", path: [key], message: r.error.issues[0].message });
    }
  }),
});

export type StackService = z.infer<typeof service>;
export type Stack = z.infer<typeof stackSchema> & { name: string };

/* ------------------------------------------------------------------ ${VAR} values */

// ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?message}, ${VAR?message}; $$ is a literal $.
// Never ${{ … }}: those are Serve's links.
const INTERPOLATE = /\$\$|\$\{(?!\{)([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}/g;

/** The names `${VAR}` asks for in the file's values (not its comments), in order, once each. */
export function stackVariables(text: string): string[] {
  const out = new Set<string>();
  const walk = (node: unknown) => {
    if (typeof node === "string") for (const m of node.matchAll(INTERPOLATE)) m[1] && out.add(m[1]);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  try {
    walk(readYaml(text));
  } catch {
    // Not valid YAML: parseStack says so; nothing is asked for.
  }
  return [...out];
}

/** The YAML document, with aliases kept to a few (a small file must not grow huge). */
function readYaml(text: string): unknown {
  return YAML.parse(text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"), { maxAliasCount: 10 });
}

function interpolate(value: string, values: Record<string, string>, where: string, errors: string[]) {
  return value.replace(INTERPOLATE, (_all, key: string | undefined, op: string | undefined, arg: string | undefined) => {
    if (!key) return "$";
    const v = Object.hasOwn(values, key) ? values[key] : undefined;
    const unset = v === undefined;
    const empty = unset || v === "";
    if (op === ":-" && empty) return arg ?? "";
    if (op === "-" && unset) return arg ?? "";
    if ((op === ":?" && empty) || (op === "?" && unset)) {
      errors.push(`${where}${arg?.trim() || `${key} is not set.`}`);
      return "";
    }
    if (unset) {
      errors.push(`${where}${key} is not set. Set it in your shell or in a .env file next to ${STACK_FILE}.`);
      return "";
    }
    return v;
  });
}

/** Fills `${VAR}` in every string of the parsed document (keys stay as written). */
function interpolateAll(node: unknown, values: Record<string, string>, path: PropertyKey[], errors: string[]): unknown {
  if (typeof node === "string") return interpolate(node, values, where(path), errors);
  if (Array.isArray(node)) return node.map((v, i) => interpolateAll(v, values, [...path, i], errors));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, interpolateAll(v, values, [...path, k], errors)]));
  return node;
}

/* ------------------------------------------------------------------ parsing */

export const STACK_MAX_BYTES = 1_000_000;

/**
 * Reads the file with `${VAR}` filled in from `values`. `fallbackName`: the stack's name when the
 * file gives none (the CLI sends its folder's name). Problems come one per line, each starting
 * with where it is: "services.api.port: …".
 */
export function parseStack(text: string, values: Record<string, string>, fallbackName: string): { stack: Stack } | { errors: string[] } {
  if (Buffer.byteLength(text) > STACK_MAX_BYTES) return { errors: [`${STACK_FILE} is larger than ${STACK_MAX_BYTES / 1000} KB.`] };
  let raw: unknown;
  try {
    raw = readYaml(text);
  } catch (e) {
    return { errors: [`${STACK_FILE} is not valid YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: [`${STACK_FILE} must hold a map with services:, like services: { api: { image: nginx } }.`] };
  const errors: string[] = [];
  const filled = interpolateAll(raw, values, [], errors);
  if (errors.length) return { errors: [...new Set(errors)].slice(0, 20) };
  const result = stackSchema.safeParse(filled);
  if (!result.success) return { errors: result.error.issues.slice(0, 20).map((i) => `${where(i.path)}${issueText(i)}`) };
  const stackName = result.data.name ?? toStackName(fallbackName);
  if (!stackName) return { errors: [`name: give the stack a name (name: shop) in ${STACK_FILE}.`] };
  const stack: Stack = { ...result.data, name: stackName };
  const problems = graphProblems(stack);
  return problems.length ? { errors: problems } : { stack };
}

/** A folder name as a stack name: "My Shop" → "My-Shop"; empty when nothing is left. */
export function toStackName(folder: string) {
  const n = folder
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return SERVICE_NAME_RE.test(n) ? n : "";
}

/* ------------------------------------------------------------------ sources */

export type GitSource = { repository: string; branch: string | null; account: string | null };

/** "github.com/me/api@main", "https://github.com/me/api.git#main", "git@github.com:me/api.git@dev". */
export function gitSource(g: NonNullable<StackService["git"]>): GitSource {
  if (typeof g !== "string") return { repository: normalizeRepo(g.repo), branch: g.branch ?? null, account: g.account ?? null };
  const hash = g.lastIndexOf("#");
  if (hash > 0) return { repository: normalizeRepo(g.slice(0, hash)), branch: g.slice(hash + 1) || null, account: null };
  // An @ after the last slash names the branch; git@host: at the start is a user.
  const slash = g.lastIndexOf("/");
  const at = g.lastIndexOf("@");
  if (at > slash && slash > 0) return { repository: normalizeRepo(g.slice(0, at)), branch: g.slice(at + 1) || null, account: null };
  return { repository: normalizeRepo(g), branch: null, account: null };
}

function normalizeRepo(repo: string) {
  const r = repo.trim();
  if (/^(https?|ssh|git):\/\//.test(r) || /^[\w.-]+@[\w.-]+:/.test(r)) return r;
  return `https://${r.replace(/^\/+/, "")}`;
}

export type DatabaseSource = { engine: StackEngine; version: string | null; username?: string; database?: string; password?: string };

/** "postgres:17", "redis", or the long form. */
export function databaseSource(d: NonNullable<StackService["database"]>): DatabaseSource | { error: string } {
  if (typeof d !== "string") return { ...d, version: d.version ?? null };
  const [engine, version] = d.split(":", 2);
  if (!(STACK_ENGINES as readonly string[]).includes(engine)) return { error: `Unknown database "${engine}". Use one of ${STACK_ENGINES.join(", ")}.` };
  return { engine: engine as StackEngine, version: version || null };
}

export type StackKind = "git" | "image" | "upload" | "database" | "compose";

export function serviceKind(s: StackService): StackKind {
  if (s.database) return "database";
  if (s.compose) return "compose";
  if (s.image) return "image";
  if (s.git) return "git";
  return "upload";
}

export type StackDomain = { host: string; port: number | null; service: string | null };

export function stackDomains(s: StackService): StackDomain[] {
  return (s.domains ?? []).map((d) => (typeof d === "string" ? { host: d, port: null, service: null } : { host: d.host, port: d.port ?? null, service: d.service ?? null }));
}

/** The folder the CLI uploads for a service, or null. */
export function uploadFolder(s: StackService): string | null {
  if (typeof s.build === "string") return s.build;
  return s.build?.context ?? null;
}

/** Files next to the stack the CLI must send: env files and compose files given as paths. */
export function stackFiles(stack: Stack): string[] {
  const out = new Set<string>();
  for (const s of Object.values(stack.services)) {
    for (const f of typeof s.env_file === "string" ? [s.env_file] : (s.env_file ?? [])) out.add(cleanPath(f));
    if (typeof s.compose === "string") out.add(cleanPath(s.compose));
  }
  return [...out];
}

/** "./a//b/" → "a/b": one spelling per file. */
export function cleanPath(p: string) {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .filter((x) => x && x !== ".")
    .join("/");
}

/* ------------------------------------------------------------------ dependencies */

export type Dependency = { on: string; condition: "healthy" | "started" };

const graphs = new WeakMap<Stack, Map<string, Dependency[]>>();

/** Every service's dependencies, worked out once per stack (lists and loops below read it often). */
function graph(stack: Stack): Map<string, Dependency[]> {
  const known = graphs.get(stack);
  if (known) return known;
  const keys = new Map(Object.keys(stack.services).map((k) => [k.toLowerCase(), k]));
  const out = new Map<string, Dependency[]>();
  for (const [key, s] of Object.entries(stack.services)) {
    const deps = new Map<string, Dependency>();
    const dep = s.depends_on;
    if (Array.isArray(dep)) for (const on of dep) deps.set(on, { on, condition: "healthy" });
    else if (dep) for (const [on, d] of Object.entries(dep)) deps.set(on, { on, condition: d.condition });
    for (const v of Object.values(s.env ?? {}))
      for (const [, ref] of v.matchAll(REF)) {
        const dot = ref.indexOf(".");
        const on = dot > 0 ? keys.get(ref.slice(0, dot).toLowerCase()) : undefined;
        if (on && on !== key && !deps.has(on)) deps.set(on, { on, condition: "healthy" });
      }
    out.set(key, [...deps.values()]);
  }
  graphs.set(stack, out);
  return out;
}

/** What a service waits for: its depends_on, and the stack services its env links to. */
export function dependencies(stack: Stack, key: string): Dependency[] {
  return graph(stack).get(key) ?? [];
}

const isService = (stack: Stack, key: string) => Object.hasOwn(stack.services, key);

function graphProblems(stack: Stack): string[] {
  const errors: string[] = [];
  const keys = Object.keys(stack.services);
  const lower = new Map<string, string>();
  for (const k of keys) {
    const other = lower.get(k.toLowerCase());
    if (other) errors.push(`services.${k}: "${k}" and "${other}" differ only in case. Links would not know which one is meant.`);
    lower.set(k.toLowerCase(), k);
  }
  for (const k of keys) {
    const dep = stack.services[k].depends_on;
    const named = Array.isArray(dep) ? dep : Object.keys(dep ?? {});
    for (const on of named) {
      if (on === k) errors.push(`services.${k}.depends_on: a service cannot depend on itself.`);
      else if (!isService(stack, on)) errors.push(`services.${k}.depends_on: "${on}" is not a service in this file.`);
    }
  }
  if (errors.length) return errors.slice(0, 20);
  const loop = findLoop(stack);
  if (loop) errors.push(`services: the services wait for each other in a loop: ${loop.join(" -> ")}. Remove one depends_on or link.`);
  return errors;
}

/** A loop of dependencies, walked without recursion (a long chain must not overflow the stack). */
function findLoop(stack: Stack): string[] | null {
  const g = graph(stack);
  const state = new Map<string, "open" | "done">();
  for (const start of g.keys()) {
    if (state.has(start)) continue;
    const path: string[] = [start];
    const next: number[] = [0];
    state.set(start, "open");
    while (path.length) {
      const k = path[path.length - 1];
      const deps = g.get(k) ?? [];
      const i = next[next.length - 1]++;
      if (i >= deps.length) {
        state.set(k, "done");
        path.pop();
        next.pop();
        continue;
      }
      const on = deps[i].on;
      if (state.get(on) === "open") return [...path.slice(path.indexOf(on)), on];
      if (!state.has(on)) {
        state.set(on, "open");
        path.push(on);
        next.push(0);
      }
    }
  }
  return null;
}

/** Deploy order: each wave holds the services whose dependencies are all in earlier waves. */
export function deployWaves(stack: Stack): string[][] {
  const g = graph(stack);
  const waiting = new Map<string, number>();
  const users = new Map<string, string[]>();
  for (const [k, deps] of g) {
    waiting.set(k, deps.length);
    for (const d of deps) users.set(d.on, [...(users.get(d.on) ?? []), k]);
  }
  const waves: string[][] = [];
  let wave = [...g.keys()].filter((k) => waiting.get(k) === 0);
  let placed = 0;
  while (wave.length) {
    waves.push(wave);
    placed += wave.length;
    const next: string[] = [];
    for (const k of wave)
      for (const u of users.get(k) ?? []) {
        const left = (waiting.get(u) ?? 0) - 1;
        waiting.set(u, left);
        if (left === 0) next.push(u);
      }
    wave = next;
  }
  // graphProblems refused loops; this only guards against a bug turning into a wrong order.
  if (placed !== g.size) throw new Error("The services wait for each other in a loop.");
  return waves;
}

/* ------------------------------------------------------------------ applying again */

/**
 * `${{ db.X }}` in the file means the stack's db. When its service got another name (the name was
 * taken), links are written with that name, so they reach it and not the other service.
 */
export function rewriteLinks(env: Record<string, string>, names: Map<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [
      k,
      v.replace(REF, (all, ref: string) => {
        const dot = ref.indexOf(".");
        const name = dot > 0 ? names.get(ref.slice(0, dot).toLowerCase()) : undefined;
        return name && name !== ref.slice(0, dot) ? `\${{ ${name}.${ref.slice(dot + 1)} }}` : all;
      }),
    ]),
  );
}

/**
 * Which of the file's variables to write: a value changed in the dashboard since the file last
 * set it stays (unless forced). A variable the file set before and no longer lists is removed,
 * unless it was changed in the dashboard since.
 */
export function variableChanges(current: Map<string, string>, file: Record<string, string>, last: Record<string, string>, force: boolean) {
  const set: string[] = [];
  const kept: string[] = [];
  const remove: string[] = [];
  for (const [k, v] of Object.entries(file)) {
    const now = current.get(k);
    if (now === v) continue;
    if (!force && now !== undefined && k in last && now !== last[k]) kept.push(k);
    else set.push(k);
  }
  for (const k of Object.keys(last)) {
    if (k in file || !current.has(k)) continue;
    if (force || current.get(k) === last[k]) remove.push(k);
    else kept.push(k);
  }
  return { set, kept, remove };
}
