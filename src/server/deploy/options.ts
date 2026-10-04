/**
 * Pure helpers for build, deploy and health check settings.
 * Kept free of I/O so they can be unit tested.
 */

/** Glob to RegExp: `**` spans directories, `*` and `?` stay within one path segment. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.?\//, "");
  // "src/" or "src" (no wildcard, no extension) means everything under that directory too.
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const plainDir = !/[*?]/.test(g) && !/\.[^/]+$/.test(g);
  return new RegExp(`^${re}${plainDir ? "(?:/.*)?" : ""}$`);
}

/**
 * Whether a push that changed `files` should deploy. No patterns, or an unknown
 * file list (some providers omit it), always deploys. Patterns starting with `!` exclude.
 */
export function matchesWatchPaths(files: string[] | null, patterns: string[] | undefined): boolean {
  const list = (patterns ?? []).map((p) => p.trim()).filter(Boolean);
  if (!list.length || !files) return true;
  const include = list.filter((p) => !p.startsWith("!")).map(globToRegExp);
  const exclude = list.filter((p) => p.startsWith("!")).map((p) => globToRegExp(p.slice(1)));
  return files.some((f) => {
    const file = f.replace(/^\//, "");
    if (exclude.some((r) => r.test(file))) return false;
    return include.length ? include.some((r) => r.test(file)) : true;
  });
}

/** Parse "200-399", "200,204" or "200-299,304" into a checker. Invalid specs accept < 500. */
export function statusMatcher(spec: string | null | undefined): (status: number) => boolean {
  const parts = (spec ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(\d{3})(?:\s*-\s*(\d{3}))?$/);
      return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
    });
  if (!parts.length || parts.some((p) => !p)) return (s) => s > 0 && s < 500;
  return (s) => parts.some((p) => s >= p![0] && s <= p![1]);
}

/** `--build-arg` flags from key/value pairs, skipping empty keys. */
export function buildArgFlags(args: { key: string; value: string }[] | undefined): string[] {
  return (args ?? []).filter((a) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(a.key.trim())).flatMap((a) => ["--build-arg", `${a.key.trim()}=${a.value}`]);
}

/** Valid "hostname:ip" lines for ExtraHosts. */
export function validExtraHosts(lines: string[] | undefined): string[] {
  return (lines ?? []).map((l) => l.trim()).filter((l) => /^[a-z0-9.-]+:[0-9a-f.:]+$/i.test(l) || /^[a-z0-9.-]+:host-gateway$/i.test(l));
}

/** Labels users may set: reserved serve.* keys are ignored. */
export function userLabels(labels: { key: string; value: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of labels ?? []) {
    const key = l.key.trim();
    if (!key || /^(serve\.|com\.docker\.)/.test(key) || !/^[a-zA-Z0-9._/-]+$/.test(key)) continue;
    out[key] = l.value;
  }
  return out;
}

/** Linux capabilities that can be added (without the CAP_ prefix). */
export const CAPABILITIES = [
  "NET_ADMIN",
  "NET_RAW",
  "NET_BIND_SERVICE",
  "SYS_ADMIN",
  "SYS_PTRACE",
  "SYS_TIME",
  "SYS_NICE",
  "SYS_RESOURCE",
  "IPC_LOCK",
  "MKNOD",
  "AUDIT_WRITE",
] as const;

/**
 * Capabilities that can be dropped: Docker's defaults, or ALL of them. Dropping only takes rights
 * away, so any member may do it.
 */
export const DROP_CAPABILITIES = [
  "ALL",
  "AUDIT_WRITE",
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "MKNOD",
  "NET_BIND_SERVICE",
  "NET_RAW",
  "SETFCAP",
  "SETGID",
  "SETPCAP",
  "SETUID",
  "SYS_CHROOT",
] as const;

/** `--security-opt` values: AppArmor, seccomp and SELinux profiles, and systempaths=unconfined. */
export const SECURITY_OPT_RE = /^(apparmor|seccomp|label|systempaths)[=:][^\s,]{1,200}$/;

/** Resource limits Docker can set per container (`--ulimit`). */
export const ULIMIT_NAMES = ["core", "cpu", "data", "fsize", "locks", "memlock", "msgqueue", "nice", "nofile", "nproc", "rss", "rtprio", "rttime", "sigpending", "stack"] as const;

/** Highest ulimit value accepted; -1 means unlimited. nofile is capped by the kernel's nr_open. */
export const ULIMIT_MAX = 2 ** 31 - 1;
export const NOFILE_MAX = 1_048_576;

/** Why a ulimit is refused, or null. */
export function ulimitProblem(u: { name: string; soft: number; hard: number }): string | null {
  if (!(ULIMIT_NAMES as readonly string[]).includes(u.name)) return `${u.name} is not a limit Docker can set. Use one of ${ULIMIT_NAMES.join(", ")}.`;
  const max = u.name === "nofile" ? NOFILE_MAX : ULIMIT_MAX;
  for (const v of [u.soft, u.hard]) {
    if (!Number.isInteger(v) || v < -1 || v > max) return `${u.name}: use a whole number up to ${max}, or -1 for unlimited.`;
  }
  if (u.name === "nofile" && (u.soft === -1 || u.hard === -1)) return "nofile cannot be unlimited.";
  // -1 is unlimited: above every number.
  const rank = (v: number) => (v === -1 ? Number.POSITIVE_INFINITY : v);
  if (rank(u.soft) > rank(u.hard)) return `${u.name}: the soft limit cannot be above the hard limit.`;
  return null;
}

/**
 * Why a sysctl is refused, or null. Only parameters the container's own namespaces hold may be
 * set: the network namespace (net.*) and the IPC namespace (kernel.shm*, kernel.msg*,
 * kernel.sem, fs.mqueue.*). Others would change the whole server.
 */
export function sysctlProblem(key: string, value: string): string | null {
  if (!/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/.test(key)) return `${key} is not a valid kernel parameter name.`;
  const ipc = ["kernel.msgmax", "kernel.msgmnb", "kernel.msgmni", "kernel.sem", "kernel.shmall", "kernel.shmmax", "kernel.shmmni", "kernel.shm_rmid_forced"];
  if (!key.startsWith("net.") && !key.startsWith("fs.mqueue.") && !ipc.includes(key)) {
    return `${key} applies to the whole server, not only this container. Allowed: net.*, kernel.shm*, kernel.msg*, kernel.sem and fs.mqueue.*.`;
  }
  if (!/^[\w .:/,-]{1,256}$/.test(value)) return `${key}: the value can use letters, numbers, spaces and . : / , - only.`;
  return null;
}

/** Resolver options (resolv.conf `options`), with the value they take if any. */
const DNS_OPTIONS: Record<string, "number" | null> = {
  ndots: "number",
  timeout: "number",
  attempts: "number",
  rotate: null,
  edns0: null,
  "single-request": null,
  "single-request-reopen": null,
  "no-tld-query": null,
  "use-vc": null,
  "no-reload": null,
  "trust-ad": null,
  inet6: null,
  debug: null,
};

/** Why a resolver option is refused, or null. */
export function dnsOptionProblem(option: string): string | null {
  const [name, value, ...rest] = option.split(":");
  const kind = DNS_OPTIONS[name];
  if (kind === undefined || rest.length) return `${option} is not a resolver option. Use options like ndots:2, timeout:1 or rotate.`;
  if (kind === "number" ? !/^\d{1,2}$/.test(value ?? "") : value !== undefined) return kind === "number" ? `${name} needs a number, like ${name}:2.` : `${name} takes no value.`;
  return null;
}

export const PLATFORMS = ["linux/amd64", "linux/arm64", "linux/arm/v7"] as const;

/** The platform of a server from `docker info` (Architecture), or null when unknown. */
export function serverPlatform(architecture: string | undefined): string | null {
  const arch = (architecture ?? "").toLowerCase();
  if (arch === "x86_64" || arch === "amd64") return "linux/amd64";
  if (arch === "aarch64" || arch === "arm64") return "linux/arm64";
  if (arch.startsWith("armv7") || arch === "arm") return "linux/arm/v7";
  return null;
}

/** Splits a command line into arguments like a shell does: spaces separate, quotes group, \ escapes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (c === "\\" && i + 1 < line.length && (quote === null || /["\\$`]/.test(line[i + 1]))) {
      cur += line[++i];
      has = true;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (quote) throw new Error("A quote is not closed.");
  if (has || cur) out.push(cur);
  return out;
}

/** Arguments as one line that splitArgs reads back the same. */
export function joinArgs(args: string[]): string {
  return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
