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

/**
 * Compose options that reach into Serve's own networks: joining an outside network (Serve's own,
 * or another environment's) or taking a name Serve's containers answer to (serve, serve-db…).
 * A container there could pose as Serve's database or dashboard. Nobody's compose file may do this;
 * Serve attaches stacks to their environment network itself.
 */
export function composeNetworkIssues(content: string): string[] {
  let doc: { services?: Record<string, Record<string, unknown>>; networks?: Record<string, Record<string, unknown> | null> };
  try {
    doc = YAML.parse(content) ?? {};
  } catch {
    return [];
  }
  const issues: string[] = [];
  const reserved = (name: unknown) => typeof name === "string" && /^serve($|[-_.])/i.test(name.trim());
  for (const [name, net] of Object.entries(doc.networks ?? {})) {
    if (net && typeof net === "object" && (net.external || net.name !== undefined)) issues.push(`network ${name}: outside networks are not allowed`);
  }
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    if (!svc || typeof svc !== "object") continue;
    if (reserved(svc.container_name)) issues.push(`${name}: container_name "${svc.container_name}" is reserved`);
    if (reserved(svc.hostname)) issues.push(`${name}: hostname "${svc.hostname}" is reserved`);
    const mode = svc.network_mode;
    if (typeof mode === "string" && mode.startsWith("container:")) issues.push(`${name}: "network_mode: ${mode}" is not allowed`);
    const nets = svc.networks;
    if (nets && typeof nets === "object" && !Array.isArray(nets)) {
      for (const [net, cfg] of Object.entries(nets as Record<string, { aliases?: unknown } | null>)) {
        const aliases = Array.isArray(cfg?.aliases) ? cfg.aliases : [];
        for (const a of aliases) if (reserved(a)) issues.push(`${name}: alias "${a}" on ${net} is reserved`);
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
  let doc: { services?: Record<string, Record<string, unknown>>; volumes?: Record<string, { driver_opts?: Record<string, unknown> } | null> };
  try {
    doc = YAML.parse(content) ?? {};
  } catch {
    return [];
  }
  const issues: string[] = [];
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    if (!svc || typeof svc !== "object") continue;
    for (const key of DANGEROUS_KEYS) if (svc[key]) issues.push(`${name}: "${key}" is not allowed`);
    // Sharing namespaces with the host or with arbitrary containers breaks isolation.
    for (const key of HOST_MODES) {
      const v = svc[key];
      if (typeof v === "string" && (v === "host" || v.startsWith("container:"))) {
        issues.push(`${name}: "${key}: ${v}" is not allowed`);
      }
    }
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
      if (source.startsWith("/") || source.startsWith("~") || source.includes("..") || source.includes("docker.sock")) {
        issues.push(`${name}: bind mount "${source}" is not allowed`);
      }
    }
  }
  for (const [name, vol] of Object.entries(doc.volumes ?? {})) {
    const opts = vol?.driver_opts;
    if (opts && (opts.device || opts.o)) issues.push(`volume ${name}: driver_opts with host devices are not allowed`);
  }
  return [...issues, ...composeNetworkIssues(content)];
}
