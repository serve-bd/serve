/**
 * Name used in ${{name.VAR}} references: lowercase letters, digits and dashes.
 * "Postgresql SD" → "postgresql-sd".
 */
export function referenceName(serviceName: string) {
  return (
    serviceName
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "service"
  );
}

export function referenceOf(serviceName: string, key: string) {
  return `\${{${referenceName(serviceName)}.${key}}}`;
}

/** A reference in a variable value: ${{KEY}} or ${{service.KEY}}. */
/** The suffix of a compose service's own domain variables: SERVE_PUBLIC_URL_<SUFFIX>. */
export function composeVarSuffix(composeService: string) {
  return composeService.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export const REF = /\$\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Variables that hold private names: they only work on the same server or across a shared private network. */
export const PRIVATE_VARS = /^(HOST|PORT|DATABASE_URL|REDIS_URL|MONGO_URL|POSTGRES_URL|MYSQL_URL|SERVE_PRIVATE_DOMAIN)$/;

/** Names that mean shared variables, not a service: they win over services with the same name. */
export const SCOPE_NAMES = new Set(["shared", "environment", "project", "org", "team", "replica"]);

/**
 * The sibling service a `${{name.KEY}}` reference points at, matched like variable resolution does:
 * by slug first, by name (as typed or dashed) only when no other service shares it. Scope names
 * (`shared`, `environment`, `project`, `org`, `team`) never mean a service.
 */
export function referencedService<T extends { id: string; name: string; slug: string }>(siblings: T[], name: string): T | undefined {
  const n = name.toLowerCase();
  if (SCOPE_NAMES.has(n)) return undefined;
  const bySlug = siblings.find((s) => s.slug.toLowerCase() === n);
  if (bySlug) return bySlug;
  const byName = siblings.filter((s) => s.name.toLowerCase() === n || referenceName(s.name) === n);
  if (byName.length !== 1) return undefined;
  // Two services with the same dashed name answer to neither name.
  return siblings.filter((s) => referenceName(s.name) === referenceName(byName[0].name)).length === 1 ? byName[0] : undefined;
}

/** Service references in values: `${{name.KEY}}` (scope references included). */
export function referencesIn(values: string[]): { name: string; key: string }[] {
  const out: { name: string; key: string }[] = [];
  for (const value of values)
    for (const [, ref] of value.matchAll(REF)) {
      const dot = ref.indexOf(".");
      if (dot > 0) out.push({ name: ref.slice(0, dot), key: ref.slice(dot + 1) });
    }
  return out;
}

/**
 * Service references a variable ends up using, following references like variable resolution
 * does (5 levels): `${{KEY}}` to the service's own variables, `${{environment.KEY}}` and the other
 * scopes to shared variables. `own` and `scope` return the raw value, or undefined.
 */
export function serviceReferencesIn(
  value: string,
  own: (key: string) => string | undefined,
  scope: (scope: string, key: string) => string | undefined,
): { name: string; key: string }[] {
  const out: { name: string; key: string }[] = [];
  const walk = (v: string, depth: number) => {
    for (const [, ref] of v.matchAll(REF)) {
      const dot = ref.indexOf(".");
      const inner = dot === -1 ? own(ref) : SCOPE_NAMES.has(ref.slice(0, dot).toLowerCase()) ? scope(ref.slice(0, dot).toLowerCase(), ref.slice(dot + 1)) : null;
      if (inner === null) out.push({ name: ref.slice(0, dot), key: ref.slice(dot + 1) });
      else if (inner !== undefined && depth < 5) walk(inner, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/** Shared variables as `serviceReferencesIn` reads them: environment (also "shared"), project, organization (also "team"). */
export function scopeReader(maps: { environment: Record<string, string>; project: Record<string, string>; org: Record<string, string> }) {
  return (scope: string, key: string) => (scope === "shared" || scope === "environment" ? maps.environment[key] : scope === "project" ? maps.project[key] : maps.org[key]);
}

/**
 * Per-replica references, filled in for each container: ${{replica.index}}, ${{replica.number}},
 * ${{replica.count}}, and ${{replica.pick(a,b,c)}} (replica 1 gets a, replica 2 gets b, ...).
 */
export const REPLICA_REF = /\$\{\{\s*replica\.(?:(index|number|count)|pick\(((?:[^)\\]|\\[\s\S])*)\))\s*\}\}/gi;

/** Replicas an app runs in all: 1 to 20 per server, on its main server and each extra server. */
export function replicaCount(replicas: number | null | undefined, extraServers = 0) {
  return Math.max(1, Math.min(replicas || 1, 20)) * (1 + extraServers);
}

/**
 * The environment of one replica: fills the replica references and sets SERVE_REPLICA_INDEX
 * (from 0) and SERVE_REPLICA_COUNT, e.g. SHARD_ID=${{replica.index}} for a sharded bot.
 */
export function replicaEnv(env: Record<string, string>, index: number, count: number): Record<string, string> {
  const values = { index: String(index), number: String(index + 1), count: String(count) } as const;
  const out: Record<string, string> = { SERVE_REPLICA_INDEX: values.index, SERVE_REPLICA_COUNT: values.count };
  for (const [k, v] of Object.entries(env))
    out[k] = v.replace(REPLICA_REF, (_m, part: string | undefined, list: string | undefined) =>
      part ? values[part.toLowerCase() as keyof typeof values] : (pickList(list ?? "")[index] ?? ""),
    );
  return out;
}

/**
 * Values of a pick list, split on commas. Spaces around a value are ignored; `\,` `\)` `\\` and
 * `\ ` stand for the characters themselves (replicaPick escapes them).
 */
export function pickList(list: string) {
  const out: string[] = [];
  let cur: { ch: string; esc: boolean }[] = [];
  const flush = () => {
    while (cur.length && !cur[0].esc && /\s/.test(cur[0].ch)) cur.shift();
    while (cur.length && !cur.at(-1)!.esc && /\s/.test(cur.at(-1)!.ch)) cur.pop();
    out.push(cur.map((c) => c.ch).join(""));
    cur = [];
  };
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "\\" && i + 1 < list.length) cur.push({ ch: list[++i], esc: true });
    else if (list[i] === ",") flush();
    else cur.push({ ch: list[i], esc: false });
  }
  flush();
  return out;
}

/** Variables whose ${{replica.pick(...)}} has fewer values than there are replicas. */
export function shortReplicaPicks(env: Record<string, string>, count: number): string[] {
  return Object.entries(env)
    .filter(([, v]) => [...v.matchAll(REPLICA_REF)].some((m) => m[2] !== undefined && pickList(m[2]).length < count))
    .map(([k]) => k);
}

/** The values of a variable that is exactly ${{replica.pick(...)}}, or null. */
export function parseReplicaPick(value: string): string[] | null {
  const m = /^\$\{\{\s*replica\.pick\(((?:[^)\\]|\\[\s\S])*)\)\s*\}\}$/i.exec(value.trim());
  return m ? pickList(m[1]) : null;
}

/** ${{replica.pick(...)}} for a list of values, escaping what would end a value or the list. */
export function replicaPick(values: string[]) {
  const escapeValue = (v: string) => v.replace(/[\\,)]/g, "\\$&").replace(/^\s+|\s+$/g, (ws) => ws.replace(/[\s\S]/g, "\\$&"));
  return `\${{replica.pick(${values.map(escapeValue).join(",")})}}`;
}
