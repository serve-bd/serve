import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { UserError } from "@/server/action";

/** Characters allowed in a redirect URL written into nginx config. */
const SAFE_URL = /^https?:\/\/[A-Za-z0-9._~:/?#@!&'()*+,=%-]+$/;

/** Normalize a redirect target and reject anything that could break out of the nginx directive. */
export function safeRedirectUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UserError("Enter a full URL like https://www.example.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UserError("Redirects must use http or https.");
  const href = url.href;
  if (!SAFE_URL.test(href) || href.includes("'")) throw new UserError("The redirect URL contains characters that are not allowed.");
  return href;
}

/** Join a user-supplied relative path onto a base directory, refusing to escape it. */
export function containedPath(base: string, relative: string, label = "Path"): string {
  const resolved = path.resolve(base, `.${path.sep}${(relative || "").replace(/^[/\\]+/, "")}`);
  const root = path.resolve(base);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${label} "${relative}" points outside the repository.`);
  }
  return resolved;
}

const DANGEROUS_KEYS = ["privileged", "cap_add", "devices", "security_opt", "sysctls", "userns_mode", "cgroup_parent", "device_cgroup_rules"];
const HOST_MODES = ["pid", "ipc", "uts", "network_mode"];

/** Compose YAML as Docker Compose reads it: merge keys (`<<: *anchor`) resolved. */
function parseCompose(content: string): Record<string, unknown> | null {
  try {
    return (YAML.parse(content, { merge: true }) as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }
}

/** `${VAR}` in a value: Compose fills it in later, from the service's variables (`$$` is a plain `$`). */
const interpolated = (v: unknown) => typeof v === "string" && v.replaceAll("$$", "").includes("$");

/**
 * Compose options that reach into Serve's own networks: joining an outside network (Serve's own,
 * or another environment's) or taking a name Serve's containers answer to (serve, serve-db…).
 * A container there could pose as Serve's database or dashboard. Serve attaches stacks to their
 * environment network itself.
 */
export function composeNetworkIssues(content: string): string[] {
  const doc = parseCompose(content) as { services?: Record<string, Record<string, unknown>>; networks?: Record<string, Record<string, unknown> | null> } | null;
  if (!doc) return [];
  const issues: string[] = [];
  const reserved = (name: unknown) => typeof name === "string" && /^serve($|[-_.])/i.test(name.trim());
  for (const [name, net] of Object.entries(doc.networks ?? {})) {
    if (!net || typeof net !== "object") continue;
    // Naming the stack's own network is fine; an outside one, a reserved or a variable name is not.
    if (net.external) issues.push(`network ${name}: outside networks are not allowed`);
    else if (reserved(net.name) || interpolated(net.name)) issues.push(`network ${name}: the name "${net.name}" is not allowed`);
  }
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    // The service name is a network alias too.
    if (reserved(name)) issues.push(`service ${name}: the name is reserved`);
    if (!svc || typeof svc !== "object") continue;
    for (const key of ["container_name", "hostname"] as const) {
      if (reserved(svc[key])) issues.push(`${name}: ${key} "${svc[key]}" is reserved`);
      else if (interpolated(svc[key])) issues.push(`${name}: ${key} cannot use variables`);
    }
    const mode = svc.network_mode;
    if (typeof mode === "string" && (mode.startsWith("container:") || interpolated(mode))) issues.push(`${name}: "network_mode: ${mode}" is not allowed`);
    const nets = svc.networks;
    if (nets && typeof nets === "object" && !Array.isArray(nets)) {
      for (const [net, cfg] of Object.entries(nets as Record<string, { aliases?: unknown } | null>)) {
        const aliases = Array.isArray(cfg?.aliases) ? cfg.aliases : [];
        for (const a of aliases) if (reserved(a) || interpolated(a)) issues.push(`${name}: alias "${a}" on ${net} is not allowed`);
      }
    }
  }
  return issues;
}

/**
 * Compose options that give containers control over the host. Only the Root
 * organization may use them; everyone else gets a readable error.
 */
export function composeSecurityIssues(content: string): string[] {
  const doc = parseCompose(content) as {
    services?: Record<string, Record<string, unknown>>;
    volumes?: Record<string, { driver_opts?: Record<string, unknown>; external?: unknown; name?: unknown } | null>;
    secrets?: Record<string, { file?: unknown } | null>;
    configs?: Record<string, { file?: unknown } | null>;
    include?: unknown;
  } | null;
  if (!doc) return [];
  const issues: string[] = [];
  // Other files are not checked here, so they cannot be pulled in.
  if (doc.include) issues.push(`"include" is not allowed`);
  // Secrets and configs from files are mounted into containers: a file outside the stack is a host file.
  for (const kind of ["secrets", "configs"] as const) {
    for (const [name, def] of Object.entries(doc[kind] ?? {})) {
      const file = def && typeof def === "object" ? def.file : undefined;
      if (typeof file === "string" && (file.startsWith("/") || file.startsWith("~") || file.split(/[\\/]/).includes("..") || interpolated(file))) {
        issues.push(`${kind} ${name}: file "${file}" is not allowed`);
      }
    }
  }
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    if (!svc || typeof svc !== "object") continue;
    for (const key of DANGEROUS_KEYS) if (svc[key]) issues.push(`${name}: "${key}" is not allowed`);
    // Sharing namespaces with the host or with arbitrary containers breaks isolation.
    for (const key of HOST_MODES) {
      const v = svc[key];
      if (typeof v === "string" && (v === "host" || v.startsWith("container:") || interpolated(v))) {
        issues.push(`${name}: "${key}: ${v}" is not allowed`);
      }
    }
    const ext = svc.extends;
    if (ext && typeof ext === "object" && (ext as { file?: unknown }).file) issues.push(`${name}: "extends" from another file is not allowed`);
    // Another container's volumes (Serve's database among them), the host's cgroups.
    if (svc.volumes_from) issues.push(`${name}: "volumes_from" is not allowed`);
    // Host ports: the file's own, like the ones Serve publishes, are for the Root organization.
    if (Array.isArray(svc.ports) ? svc.ports.length : svc.ports) issues.push(`${name}: publishing host ports ("ports") is not allowed; use Domains & ports`);
    if (svc.cgroup === "host" || interpolated(svc.cgroup)) issues.push(`${name}: "cgroup: ${svc.cgroup}" is not allowed`);
    const outside = (p: string) => p.startsWith("/") || p.startsWith("~") || p.split(/[\\/]/).includes("..");
    const build = svc.build;
    const context = typeof build === "string" ? build : (build as { context?: string } | undefined)?.context;
    if (context && !/^[a-z]+:\/\//i.test(context) && (outside(context) || interpolated(context))) issues.push(`${name}: build context "${context}" is not allowed`);
    if (build && typeof build === "object") {
      const b = build as { additional_contexts?: unknown; ssh?: unknown; secrets?: unknown; dockerfile?: unknown };
      // Extra contexts are build contexts too; ssh would hand the build Serve's own SSH agent.
      const extra = Array.isArray(b.additional_contexts)
        ? b.additional_contexts.map((e) => String(e).split("=").slice(1).join("="))
        : Object.values((b.additional_contexts as Record<string, unknown>) ?? {}).map(String);
      for (const c of extra) {
        if (!/^(docker-image|service|oci-layout|https?|git):/i.test(c) && (outside(c) || interpolated(c))) issues.push(`${name}: build context "${c}" is not allowed`);
      }
      if (b.ssh) issues.push(`${name}: "build.ssh" is not allowed`);
      if (b.secrets) issues.push(`${name}: "build.secrets" is not allowed`);
      if (typeof b.dockerfile === "string" && (outside(b.dockerfile) || interpolated(b.dockerfile))) issues.push(`${name}: dockerfile "${b.dockerfile}" is not allowed`);
    }
    const envFiles = typeof svc.env_file === "string" ? [svc.env_file] : Array.isArray(svc.env_file) ? svc.env_file : [];
    for (const f of envFiles) {
      const file = typeof f === "string" ? f : ((f as { path?: string })?.path ?? "");
      if (file && outside(file)) issues.push(`${name}: env_file "${file}" is not allowed`);
    }
    const volumes = Array.isArray(svc.volumes) ? svc.volumes : [];
    for (const v of volumes) {
      const source = typeof v === "string" ? v.split(":")[0] : (v as { source?: string; type?: string })?.type === "bind" ? ((v as { source?: string }).source ?? "") : "";
      if (!source) continue;
      // A variable could turn into any host path once Compose fills it in.
      if (interpolated(source)) issues.push(`${name}: volume source "${source}" cannot use variables`);
      else if (source.startsWith("/") || source.startsWith("~") || source.includes("..") || source.includes("docker.sock")) {
        issues.push(`${name}: bind mount "${source}" is not allowed`);
      }
    }
  }
  for (const [name, vol] of Object.entries(doc.volumes ?? {})) {
    const opts = vol?.driver_opts;
    if (opts && (opts.device || opts.o)) issues.push(`volume ${name}: driver_opts with host devices are not allowed`);
    // A volume by its own name could be another stack's data on the same server.
    const v = vol as { external?: unknown; name?: unknown } | null;
    if (v?.external) issues.push(`volume ${name}: outside volumes are not allowed`);
    else if (v?.name !== undefined) issues.push(`volume ${name}: a custom volume name is not allowed`);
  }
  return [...issues, ...composeNetworkIssues(content)];
}

/**
 * Host paths a compose file reads relative to its own folder: bind-mount sources, env files,
 * build contexts and Dockerfiles, secret and config files. Docker follows symlinks in these, so
 * each is checked on disk (see pathsOutside) once the repository is cloned.
 */
export function composeLocalPaths(content: string, composeDir: string): string[] {
  const doc = parseCompose(content) as {
    services?: Record<string, Record<string, unknown>>;
    secrets?: Record<string, { file?: unknown } | null>;
    configs?: Record<string, { file?: unknown } | null>;
  } | null;
  if (!doc) return [];
  const out: string[] = [];
  const add = (p: unknown, base = composeDir) => {
    if (typeof p === "string" && p && !/^[a-z][a-z0-9+.-]*:/i.test(p)) out.push(path.resolve(base, p));
  };
  for (const svc of Object.values(doc.services ?? {})) {
    if (!svc || typeof svc !== "object") continue;
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
      if (typeof v === "string") {
        const source = v.split(":")[0];
        if (source.startsWith(".")) add(source);
      } else if ((v as { type?: string })?.type === "bind") add((v as { source?: string }).source);
    }
    const envFiles = typeof svc.env_file === "string" ? [svc.env_file] : Array.isArray(svc.env_file) ? svc.env_file : [];
    for (const f of envFiles) add(typeof f === "string" ? f : (f as { path?: string })?.path);
    const build = svc.build;
    const context = typeof build === "string" ? build : (build as { context?: string } | undefined)?.context;
    const contextDir = context && !/^[a-z]+:\/\//i.test(context) ? path.resolve(composeDir, context) : composeDir;
    if (context) add(context);
    if (build && typeof build === "object") {
      const b = build as { dockerfile?: unknown; additional_contexts?: unknown };
      add(b.dockerfile, contextDir);
      const extra = Array.isArray(b.additional_contexts)
        ? b.additional_contexts.map((e) => String(e).split("=").slice(1).join("="))
        : Object.values((b.additional_contexts as Record<string, unknown>) ?? {}).map(String);
      for (const c of extra) add(c);
    }
  }
  for (const kind of ["secrets", "configs"] as const) for (const def of Object.values(doc[kind] ?? {})) add(def && typeof def === "object" ? def.file : undefined);
  return out;
}

/** Paths that lead outside `root` once symlinks are followed (paths that do not exist are fine). */
export async function pathsOutside(root: string, paths: string[]): Promise<string[]> {
  const realRoot = await fs.realpath(root);
  const out: string[] = [];
  for (const p of paths) {
    const real = await fs.realpath(p).catch(() => null);
    if (real !== null && real !== realRoot && !real.startsWith(realRoot + path.sep)) out.push(p);
  }
  return out;
}

/**
 * Names in a compose file that another service answers to on the networks the proxy shares with
 * it (its slug, or "<slug>-<name>" for stack services): taking one would receive that service's
 * traffic. `otherSlugs`: the slugs of every other service.
 */
export function composeNameClashes(content: string, otherSlugs: string[]): string[] {
  const doc = parseCompose(content) as { services?: Record<string, Record<string, unknown>> } | null;
  if (!doc || !otherSlugs.length) return [];
  const slugs = otherSlugs.map((s) => s.toLowerCase());
  const taken = (name: unknown) => typeof name === "string" && slugs.some((slug) => name.toLowerCase() === slug || name.toLowerCase().startsWith(`${slug}-`));
  const issues: string[] = [];
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    if (taken(name)) issues.push(`service ${name}: the name belongs to another service`);
    if (!svc || typeof svc !== "object") continue;
    for (const key of ["container_name", "hostname"] as const) if (taken(svc[key])) issues.push(`${name}: ${key} "${svc[key]}" belongs to another service`);
    const nets = svc.networks;
    if (nets && typeof nets === "object" && !Array.isArray(nets)) {
      for (const cfg of Object.values(nets as Record<string, { aliases?: unknown } | null>)) {
        for (const a of Array.isArray(cfg?.aliases) ? cfg.aliases : []) if (taken(a)) issues.push(`${name}: alias "${a}" belongs to another service`);
      }
    }
  }
  return issues;
}

const SECRET_FLAGS = /^(--requirepass|--masterauth|--password|--pass|--passwd|--token|--secret|-a)$/i;

/** A container's command as shown to anyone who can see the service: secret flag values hidden. */
export function maskCommand(parts: string[]): string[] {
  return parts.map((part, i) => {
    if (i > 0 && SECRET_FLAGS.test(parts[i - 1])) return "********";
    const eq = part.match(/^(--(?:requirepass|masterauth|password|pass|passwd|token|secret))=/i);
    return eq ? `${eq[1]}=********` : part;
  });
}

/**
 * Gives every BuildKit cache mount (`RUN --mount=type=cache`) an id under `scope`. Cache mounts
 * are shared by every build on a server, keyed only by id (the target path when unset): without
 * this, one organization could fill a cache another organization's build then trusts.
 */
export function scopeCacheMounts(text: string, scope: string): string {
  return text.replace(/--mount=("[^"]*"|\S+)/g, (whole, raw: string) => {
    const quoted = raw.startsWith('"');
    const parts = (quoted ? raw.slice(1, -1) : raw).split(",");
    const get = (k: string) => parts.find((p) => p.startsWith(`${k}=`))?.slice(k.length + 1);
    if (get("type") !== "cache") return whole;
    const base = get("id") ?? get("target") ?? get("dst") ?? get("destination") ?? "";
    const next = [...parts.filter((p) => !p.startsWith("id=")), `id=${scope}-${base}`].join(",");
    return `--mount=${quoted ? `"${next}"` : next}`;
  });
}

/** Local Dockerfiles a compose file builds from (default `Dockerfile` in each local build context). */
export function composeDockerfiles(content: string, composeDir: string): string[] {
  const doc = parseCompose(content) as { services?: Record<string, { build?: unknown }> } | null;
  const out: string[] = [];
  for (const svc of Object.values(doc?.services ?? {})) {
    const build = svc?.build;
    if (!build) continue;
    const context = typeof build === "string" ? build : ((build as { context?: string }).context ?? ".");
    if (/^[a-z][a-z0-9+.-]*:/i.test(context)) continue;
    const dockerfile = typeof build === "object" ? (build as { dockerfile?: unknown }).dockerfile : undefined;
    out.push(path.resolve(composeDir, context, typeof dockerfile === "string" && dockerfile ? dockerfile : "Dockerfile"));
  }
  return [...new Set(out)];
}
