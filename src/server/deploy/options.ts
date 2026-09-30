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
