import { and, eq, inArray } from "drizzle-orm";
import YAML from "yaml";
import { db, schema } from "@/server/db";
import { decryptOrNull, hmac } from "@/server/crypto";
import { REF, referencedService, SCOPE_NAMES } from "@/lib/refs";
import {
  cleanPath,
  databaseSource,
  type DatabaseSource,
  deployWaves,
  dependencies,
  type Dependency,
  gitSource,
  type GitSource,
  parseEnvFile,
  graphProblems,
  parseStackDoc,
  readStackYaml,
  rewriteLinks,
  serviceKind,
  type Stack,
  stackDomains,
  type StackDomain,
  stackFiles,
  type StackKind,
  type StackService,
  variablesIn,
  STACK_FILE,
  uploadFolder,
  variableChanges,
} from "@/lib/stack";
import { PASSWORD_PATTERN } from "@/server/databases/password";
import { engines } from "@/server/databases/engines";
import type { DbEngine } from "@/server/services/types";
import { parseCompose } from "@/server/deploy/compose";
import { findGitAccess } from "@/server/git/access";
import { serversForOrg } from "@/server/servers/access";

type Service = typeof schema.service.$inferSelect;

export type StackInput = {
  /** The file's text. */
  text: string;
  /** ${VAR} values: from the shell and the .env next to the file (the CLI sends only those named). */
  values?: Record<string, string>;
  /** Files next to the stack named in it (env_file, compose), by path. */
  files?: Record<string, string>;
  /** The stack's name when the file gives none: the CLI sends its folder's name. */
  folder?: string;
};

export type StackOptions = {
  /** The file's values win over changes made in the dashboard. */
  force?: boolean;
  /** Services of the stack no longer in the file are removed. */
  removeOrphans?: boolean;
  /** From the dashboard: no local folders. */
  dashboard?: boolean;
};

export type PlanService = {
  key: string;
  kind: StackKind;
  action: "create" | "update" | "unchanged";
  serviceId: string | null;
  /** The service's name in Serve (a new one may get a suffix when the name is taken). */
  name: string;
  /** What changes, readable: "image: nginx:1 → nginx:2", "variables: +API_KEY". */
  changes: string[];
  /** Values changed in the dashboard since the last up, kept (without --force). */
  kept: string[];
  wave: number;
  needs: Dependency[];
  /** The folder the CLI uploads, relative to the file. */
  upload: string | null;
  /** The git login it uses. */
  gitLogin: string | null;
};

export type StackPlan = {
  stack: string | null;
  /** True when the file can be applied: nothing missing, no errors. */
  ready: boolean;
  needs: { variables: string[]; files: string[] };
  errors: string[];
  warnings: string[];
  services: PlanService[];
  /** Services of the stack that left the file. */
  orphans: { key: string; serviceId: string; name: string; remove: boolean }[];
  waves: string[][];
};

/** What apply needs for one service, worked out by the plan. */
export type Resolved = {
  key: string;
  spec: StackService;
  kind: StackKind;
  existing: Service | null;
  /** Variables the file sets, env_file first, then env. */
  env: Record<string, string>;
  git: (GitSource & { credentialId: string | null }) | null;
  database: DatabaseSource | null;
  compose: string | null;
  serverId: string | null;
  domains: StackDomain[];
  /** serve.json-style settings as JSON, or null. */
  settings: string | null;
};

export type PlanContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  /** The caller may see secrets: the plan compares the file with the stored values. */
  seesSecrets: boolean;
  /** The caller may change HTTP options (an organization admin with domains.manage). */
  mayChangeHttp: boolean;
};

/** Fingerprints of the file's variables: compared and stored instead of the values. */
export const fingerprints = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, hmac(v)]));

/** Fingerprints of a service's stored variables. */
export async function storedFingerprints(serviceId: string) {
  const rows = await db.select({ key: schema.envVar.key, value: schema.envVar.value }).from(schema.envVar).where(eq(schema.envVar.serviceId, serviceId));
  return new Map(rows.map((r) => [r.key, hmac(decryptOrNull(r.value) ?? "")]));
}

const SETTING_KEYS = ["deploy", "healthcheck", "resources", "tasks", "volumes", "files", "http", "monitor"] as const;

function settingsOf(spec: StackService): string | null {
  const out: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) if (spec[k] !== undefined) out[k] = spec[k];
  if (typeof spec.build === "object") {
    const { context: _c, rootDir: _r, ...build } = spec.build;
    if (Object.keys(build).length) out.build = build;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** "17" → "17-alpine": the file names a version as people say it, Serve keeps its own tags. */
export function engineVersion(engine: DbEngine, version: string): { version: string } | { error: string } {
  const list = engines[engine].versions;
  const found = list.find((v) => v === version) ?? list.find((v) => v.startsWith(`${version}-`) || v.startsWith(`${version}.`));
  return found ? { version: found } : { error: `database: ${engine} ${version} is not offered. Use one of ${list.join(", ")}.` };
}

const emptyPlan = (): StackPlan => ({ stack: null, ready: false, needs: { variables: [], files: [] }, errors: [], warnings: [], services: [], orphans: [], waves: [] });

/**
 * Reads a stack file against an environment and says what `up` would do, changing nothing. The
 * CLI calls it first without values: the answer names the ${VAR}s and files it needs.
 */
export async function planStack(ctx: PlanContext, input: StackInput, opts: StackOptions = {}): Promise<{ plan: StackPlan; resolved: Resolved[]; stack: Stack | null }> {
  const plan = emptyPlan();
  const values = input.values ?? {};
  const read = readStackYaml(input.text);
  if ("errors" in read) {
    plan.errors = read.errors;
    return { plan, resolved: [], stack: null };
  }
  plan.needs.variables = variablesIn(read.doc).filter((v) => !Object.hasOwn(values, v));
  const parsed = parseStackDoc(read.doc, values, input.folder ?? "");
  if ("errors" in parsed) {
    plan.errors = parsed.errors;
    return { plan, resolved: [], stack: null };
  }
  const stack = parsed.stack;
  plan.stack = stack.name;
  const files = new Map(Object.entries(input.files ?? {}).map(([p, t]) => [cleanPath(p), t]));
  plan.needs.files = stackFiles(stack).filter((f) => !files.has(f));
  if (plan.needs.files.length) return { plan, resolved: [], stack };

  const services = await db.select().from(schema.service).where(eq(schema.service.environmentId, ctx.environmentId));
  const live = services.filter((s) => !s.parentServiceId);
  const mine = new Map(live.filter((s) => s.stackName === stack.name && s.stackKey).map((s) => [s.stackKey as string, s]));
  const servers = await serversForOrg(ctx.organizationId);
  const keys = Object.keys(stack.services);
  const lowerKeys = new Set(keys.map((k) => k.toLowerCase()));
  const err = (key: string, message: string) => plan.errors.push(`services.${key}: ${message}`);

  // Variables: env files in order, then env. Links in env files make dependencies too.
  const envs = new Map<string, Record<string, string>>();
  for (const key of keys) {
    const spec = stack.services[key];
    const env: Record<string, string> = {};
    for (const f of typeof spec.env_file === "string" ? [spec.env_file] : (spec.env_file ?? [])) {
      const r = parseEnvFile(files.get(cleanPath(f)) ?? "");
      if ("error" in r) err(key, `env_file ${f}: ${r.error}`);
      else Object.assign(env, r.values);
    }
    envs.set(key, Object.assign(env, spec.env ?? {}));
  }
  const linked: Stack = { ...stack, services: Object.fromEntries(keys.map((k) => [k, { ...stack.services[k], env: envs.get(k) }])) };
  const order = graphProblems(linked);
  if (order.length) {
    plan.errors.push(...order);
    return { plan, resolved: [], stack };
  }
  const waves = deployWaves(linked);
  plan.waves = waves;
  const waveOf = new Map(waves.flatMap((w, i) => w.map((k) => [k, i] as const)));
  const resolved: Resolved[] = [];
  // Each login's repositories are listed once per plan, however many services use git.
  const gitCache = new Map();
  // Links in the file name stack keys; a stack service with another name is linked by that name.
  const names = new Map([...mine].map(([k, s]) => [k.toLowerCase(), s.name]));

  for (const key of keys) {
    const spec = stack.services[key];
    const kind = serviceKind(spec);
    const existing = mine.get(key) ?? null;
    const item: PlanService = {
      key,
      kind,
      action: existing ? "unchanged" : "create",
      serviceId: existing?.id ?? null,
      name: existing?.name ?? key,
      changes: [],
      kept: [],
      wave: waveOf.get(key) ?? 0,
      needs: dependencies(linked, key),
      upload: uploadFolder(spec),
      gitLogin: null,
    };
    plan.services.push(item);
    if (item.upload && opts.dashboard) err(key, "local folders are uploaded by the CLI. Use serve compose up, or give git or image.");

    const env = envs.get(key) ?? {};
    for (const [k, v] of Object.entries(env))
      for (const [, ref] of v.matchAll(REF)) {
        const dot = ref.indexOf(".");
        if (dot <= 0) continue;
        const target = ref.slice(0, dot);
        if (SCOPE_NAMES.has(target.toLowerCase()) || lowerKeys.has(target.toLowerCase())) continue;
        if (!referencedService(live, target)) err(key, `env.${k} links to "${target}", which is not in this file or this environment.`);
      }

    if (existing) {
      const was = existing.type === "database" ? "database" : existing.type === "compose" ? "compose" : "app";
      const now = kind === "database" ? "database" : kind === "compose" ? "compose" : "app";
      if (was !== now)
        err(
          key,
          `it is ${was === "app" ? "an" : "a"} ${was} in Serve and ${now === "app" ? "an" : "a"} ${now} in the file. Remove it first (serve compose down), or give it another name.`,
        );
    }

    let database: DatabaseSource | null = null;
    if (spec.database) {
      const d = databaseSource(spec.database);
      if ("error" in d) err(key, d.error);
      else {
        database = d;
        const version = d.version ? engineVersion(d.engine, d.version) : null;
        if (version && "error" in version) err(key, version.error);
        else if (version) d.version = version.version;
        if (d.password && !PASSWORD_PATTERN.test(d.password)) err(key, "database.password: use 12 to 128 letters, numbers, dots, dashes, underscores or tildes.");
        const cfg = existing?.database;
        if (cfg && cfg.engine !== d.engine) err(key, `the database is ${cfg.engine} in Serve and ${d.engine} in the file. Serve does not change a database's engine.`);
        else if (cfg && d.version && cfg.version !== d.version)
          err(key, `the database runs version ${cfg.version} and the file asks for ${d.version}. Change the version in the dashboard (it may need a dump and restore).`);
      }
    }

    // HTTP options: set, changed or dropped (a dropped block removes them) only by those who may.
    if (!ctx.mayChangeHttp) {
      const lastHttp = existing?.stackFile?.settings ? (JSON.parse(existing.stackFile.settings) as { http?: unknown }).http : undefined;
      if (JSON.stringify(spec.http ?? null) !== JSON.stringify(lastHttp ?? null))
        err(key, "http: only organization admins who manage domains can change HTTP options. Keep the file's http: block as it was, or ask one of them.");
      // --force puts the file's HTTP options back over an admin's changes.
      else if (opts.force && spec.http) err(key, "http: --force would put back HTTP options an admin may have changed. Run up without --force, or ask an admin.");
      // Settings from the stack replace a repository's serve.json, HTTP options included.
      const repoFile = existing?.configFile;
      if (repoFile && !repoFile.path.startsWith(STACK_FILE) && repoFile.httpKeys?.length && settingsOf(spec) !== null)
        err(key, `its ${repoFile.path} sets HTTP options, which these settings would replace. Only admins who manage domains can do that.`);
    }

    let compose: string | null = null;
    if (spec.compose) {
      compose = typeof spec.compose === "string" ? (files.get(cleanPath(spec.compose)) ?? "") : YAML.stringify(spec.compose);
      try {
        parseCompose(compose);
      } catch (e) {
        err(key, `compose: the compose file is not valid: ${(e as Error).message}`);
      }
      if (existing && existing.compose?.content !== compose) item.changes.push("compose file");
    }

    let serverId: string | null = existing?.serverId ?? null;
    if (spec.server) {
      const server = servers.find((s) => s.name.toLowerCase() === spec.server?.toLowerCase());
      if (!server) err(key, `server: no server is named "${spec.server}".`);
      else if (existing && existing.serverId !== server.id) err(key, `server: it runs on another server. Move it in the dashboard.`);
      else serverId = server.id;
    }

    let git: Resolved["git"] = null;
    if (spec.git) {
      const g = gitSource(spec.git);
      const host = URL.canParse(g.repository) ? new URL(g.repository).hostname : null;
      if (host !== null && !host.includes(".") && host !== "localhost") err(key, `git: name the host too, like github.com/${g.repository.replace(/^https:\/\//, "")}.`);
      const current = existing?.source?.type === "git" ? existing.source : null;
      // A repository the service already uses keeps its login; a new one looks for a login with access.
      if (current && current.repository === g.repository && !g.account) {
        git = { ...g, credentialId: current.credentialId ?? null };
      } else {
        const access = await findGitAccess(ctx.organizationId, g.repository, g.account, gitCache);
        if ("error" in access) err(key, `git: ${access.error}`);
        else {
          git = { ...g, credentialId: access.credentialId };
          item.gitLogin = access.login;
          if (access.note) plan.warnings.push(`${key}: ${access.note}`);
        }
      }
      if (current && (current.repository !== g.repository || (g.branch && current.branch !== g.branch)))
        item.changes.push(`git: ${current.repository}@${current.branch} → ${g.repository}@${g.branch ?? current.branch}`);
    }
    if (spec.image && existing?.source?.type === "image" && existing.source.image !== spec.image) item.changes.push(`image: ${existing.source.image} → ${spec.image}`);

    const domains = stackDomains(spec);
    const settings = settingsOf(spec);
    const last = existing?.stackFile ?? null;
    if (existing) {
      if (spec.port !== undefined && existing.runtime.port !== spec.port) {
        if (last?.port != null && existing.runtime.port !== last.port && !opts.force) item.kept.push("port");
        else item.changes.push(`port: ${existing.runtime.port ?? "none"} → ${spec.port}`);
      }
      // Settings the file no longer lists stay as they are: only new ones count.
      if (settings !== null && (last?.settings ?? null) !== settings) item.changes.push("settings");
      const current = await storedFingerprints(existing.id);
      const v = variableChanges(current, fingerprints(rewriteLinks(env, names)), last?.variables ?? {}, !!opts.force);
      if (ctx.seesSecrets) {
        if (v.set.length) item.changes.push(`variables: ${v.set.map((k) => (current.has(k) ? `~${k}` : `+${k}`)).join(" ")}`);
        if (v.remove.length) item.changes.push(`variables: ${v.remove.map((k) => `-${k}`).join(" ")}`);
        item.kept.push(...v.kept.map((k) => `variable ${k}`));
      } else if (Object.keys(env).length || Object.keys(last?.variables ?? {}).length) {
        // Saying which values differ would tell whether a guess at a secret is right: without the
        // right to see secrets, the file's variables are set again, as if all had changed.
        item.changes.push("variables: set again (values are compared only for members who may see secrets)");
      }
    }

    // Domains: taken by another service is an error before anything changes.
    if (domains.length) {
      const taken = await db
        .select({ hostname: schema.domain.hostname, serviceId: schema.domain.serviceId })
        .from(schema.domain)
        .where(
          inArray(
            schema.domain.hostname,
            domains.map((d) => d.host),
          ),
        );
      for (const t of taken) {
        if (t.serviceId === existing?.id) continue;
        const owner = services.find((s) => s.id === t.serviceId);
        err(key, `domains: ${t.hostname} is used by ${owner ? owner.name : "a service in another project"}.`);
      }
      if (kind === "compose")
        for (const d of domains) if (!d.service) err(key, `domains: say which compose service receives ${d.host}: { host: ${d.host}, service: web, port: 80 }.`);
    }
    if (existing) {
      const ours = await db.select({ hostname: schema.domain.hostname }).from(schema.domain).where(eq(schema.domain.serviceId, existing.id));
      const have = new Set(ours.map((d) => d.hostname));
      const added = domains.filter((d) => !have.has(d.host)).map((d) => `+${d.host}`);
      const removed = (last?.domains ?? []).filter((h) => have.has(h) && !domains.some((d) => d.host === h)).map((h) => `-${h}`);
      if (added.length + removed.length) item.changes.push(`domains: ${[...added, ...removed].join(" ")}`);
    }

    if (!existing) {
      const clash = live.find((s) => s.name.toLowerCase() === key.toLowerCase());
      if (clash)
        plan.warnings.push(`${key}: a service named ${clash.name} is already in this environment, so the new one gets another name. Links in the file still reach the new one.`);
    } else if (item.changes.length) item.action = "update";

    resolved.push({ key, spec, kind, existing, env, git, database, compose, serverId, domains, settings });
  }

  for (const [key, s] of mine) {
    if (Object.hasOwn(stack.services, key)) continue;
    plan.orphans.push({ key, serviceId: s.id, name: s.name, remove: !!opts.removeOrphans });
    if (!opts.removeOrphans) plan.warnings.push(`${key} (${s.name}) is no longer in ${STACK_FILE}: it stays. Use --remove-orphans to remove it.`);
  }
  plan.ready = !plan.errors.length && !plan.needs.files.length;
  return { plan, resolved, stack };
}

/** Services of a stack in an environment. */
export async function stackServices(environmentId: string, stackName: string) {
  return db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.environmentId, environmentId), eq(schema.service.stackName, stackName)));
}
