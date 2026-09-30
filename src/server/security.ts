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
    include?: unknown;
  } | null;
  if (!doc) return [];
  const issues: string[] = [];
  // Other files are not checked here, so they cannot be pulled in.
  if (doc.include) issues.push(`"include" is not allowed`);
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
    const outside = (p: string) => p.startsWith("/") || p.startsWith("~") || p.split(/[\\/]/).includes("..");
    const build = svc.build;
    const context = typeof build === "string" ? build : (build as { context?: string } | undefined)?.context;
    if (context && !/^[a-z]+:\/\//i.test(context) && outside(context)) issues.push(`${name}: build context "${context}" is not allowed`);
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
