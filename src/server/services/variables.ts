import { eq, or } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, decryptOrNull } from "@/server/crypto";
import { engines } from "@/server/databases/engines";
import { databaseUrl } from "@/server/databases/options";
import { referenceName } from "@/lib/refs";

type Service = typeof schema.service.$inferSelect;
type Domain = typeof schema.domain.$inferSelect;

/** Variables every service exposes to others via ${{service.VAR}} references. */
export function providedVars(service: Service, domains: Domain[] = []): Record<string, string> {
  const vars: Record<string, string> = {
    SERVE_SERVICE_NAME: service.name,
    SERVE_PRIVATE_DOMAIN: service.slug,
  };
  // Custom domains win over generated ones (sslip.io / wildcard); the oldest of each kind first.
  const primary =
    domains
      .filter((d) => !d.redirectTo)
      .sort((a, b) => Number(a.generated) - Number(b.generated) || a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
  if (primary) {
    vars.SERVE_PUBLIC_DOMAIN = primary.hostname;
    // Tunnel domains are HTTPS at Cloudflare even though the proxy serves them over HTTP.
    vars.SERVE_PUBLIC_URL = `${primary.https || primary.tunnelId ? "https" : "http"}://${primary.hostname}`;
  }
  if (service.type === "app" && service.runtime.port) {
    vars.PORT = String(service.runtime.port);
  }
  if (service.type === "database" && service.database) {
    const cfg = service.database;
    const engine = engines[cfg.engine];
    const creds = {
      username: cfg.username,
      password: decryptOrNull(cfg.password) ?? "",
      database: cfg.database,
    };
    const url = databaseUrl(cfg, creds, service.slug, engine.port);
    Object.assign(vars, {
      HOST: service.slug,
      PORT: String(engine.port),
      USERNAME: creds.username,
      PASSWORD: creds.password,
      DATABASE: creds.database,
      DATABASE_URL: url,
    });
    if (cfg.engine === "redis" || cfg.engine === "valkey") vars.REDIS_URL = url;
    if (cfg.engine === "mongodb") vars.MONGO_URL = url;
    if (cfg.engine === "postgres") vars.POSTGRES_URL = url;
    if (cfg.engine === "mysql" || cfg.engine === "mariadb") vars.MYSQL_URL = url;
    if (cfg.publicPort) vars.DATABASE_PUBLIC_PORT = String(cfg.publicPort);
  }
  return vars;
}

/** Variables that point at the private network (unreachable from another server). */
const PRIVATE_VARS = /^(HOST|PORT|DATABASE_URL|REDIS_URL|MONGO_URL|POSTGRES_URL|MYSQL_URL|SERVE_PRIVATE_DOMAIN)$/;

const REF = /\$\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export type ResolvedEnv = {
  runtime: Record<string, string>;
  build: Record<string, string>;
  /** Secrets that must be redacted from logs. */
  secrets: string[];
  /** References that could not be resolved. */
  missing: string[];
};

/** Resolve service variables, shared variables and ${{ref}} references. */
export async function resolveEnv(service: Service): Promise<ResolvedEnv> {
  const [scope] = await db
    .select({ projectId: schema.project.id, organizationId: schema.project.organizationId })
    .from(schema.environment)
    .innerJoin(schema.project, eq(schema.environment.projectId, schema.project.id))
    .where(eq(schema.environment.id, service.environmentId));
  const [own, shared, siblings, siblingDomains] = await Promise.all([
    db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, service.id)),
    db
      .select()
      .from(schema.sharedVar)
      .where(
        or(
          eq(schema.sharedVar.environmentId, service.environmentId),
          scope ? eq(schema.sharedVar.projectId, scope.projectId) : undefined,
          scope ? eq(schema.sharedVar.organizationId, scope.organizationId) : undefined,
        ),
      ),
    db.select().from(schema.service).where(eq(schema.service.environmentId, service.environmentId)),
    db
      .select({ domain: schema.domain })
      .from(schema.domain)
      .innerJoin(schema.service, eq(schema.domain.serviceId, schema.service.id))
      .where(eq(schema.service.environmentId, service.environmentId)),
  ]);

  const domainsBy = new Map<string, Domain[]>();
  for (const { domain } of siblingDomains) {
    domainsBy.set(domain.serviceId, [...(domainsBy.get(domain.serviceId) ?? []), domain]);
  }

  // Environment variables apply to every service; organization and project ones only by reference.
  const sharedMap: Record<string, string> = {};
  const projectMap: Record<string, string> = {};
  const orgMap: Record<string, string> = {};
  for (const v of shared) {
    const target = v.environmentId ? sharedMap : v.projectId ? projectMap : orgMap;
    target[v.key] = decryptOrNull(v.value) ?? "";
  }

  const lookup = new Map<string, Record<string, string>>();
  // Private hostnames only resolve on the same server; drop them for services elsewhere.
  const remoteOnly = new Map<string, Set<string>>();
  for (const s of siblings) {
    let provided = providedVars(s, domainsBy.get(s.id) ?? []);
    if (s.id !== service.id && s.serverId !== service.serverId) {
      const hidden = new Set(Object.keys(provided).filter((k) => PRIVATE_VARS.test(k)));
      provided = Object.fromEntries(Object.entries(provided).filter(([k]) => !hidden.has(k)));
      for (const name of [s.slug, s.name, referenceName(s.name)]) remoteOnly.set(name.toLowerCase(), hidden);
    }
    lookup.set(s.slug.toLowerCase(), provided);
    lookup.set(s.name.toLowerCase(), provided);
    // Preferred form: names with spaces or symbols become dashed ("postgresql-sd").
    if (!lookup.has(referenceName(s.name))) lookup.set(referenceName(s.name), provided);
  }
  // Scope names win over services with the same name.
  lookup.set("shared", sharedMap);
  lookup.set("environment", sharedMap);
  lookup.set("project", projectMap);
  lookup.set("org", orgMap);
  lookup.set("team", orgMap);

  const ownRaw: Record<string, { value: string; build: boolean; runtime: boolean }> = {};
  for (const v of own) ownRaw[v.key] = { value: decrypt(v.value), build: v.buildTime, runtime: v.runtime };

  const self = providedVars(service, domainsBy.get(service.id) ?? []);
  const missing = new Set<string>();

  const expand = (value: string, depth = 0): string =>
    value.replace(REF, (match, ref: string) => {
      const dot = ref.indexOf(".");
      let result: string | undefined;
      if (dot === -1) {
        result = ownRaw[ref]?.value ?? sharedMap[ref] ?? self[ref];
      } else {
        const scope = lookup.get(ref.slice(0, dot).toLowerCase());
        result = scope?.[ref.slice(dot + 1)];
        if (result === undefined && remoteOnly.get(ref.slice(0, dot).toLowerCase())?.has(ref.slice(dot + 1))) {
          missing.add(`${ref} (runs on another server; use its public domain or port)`);
          return "";
        }
      }
      if (result === undefined) {
        missing.add(ref);
        return "";
      }
      return depth < 5 ? expand(result, depth + 1) : result;
    });

  const runtime: Record<string, string> = {};
  const build: Record<string, string> = {};
  // Shared variables apply to every service unless overridden.
  for (const [k, v] of Object.entries(sharedMap)) runtime[k] = expand(v);
  if (service.type === "app" && service.runtime.port) runtime.PORT = String(service.runtime.port);
  for (const [k, v] of Object.entries(ownRaw)) {
    const value = expand(v.value);
    if (v.runtime) runtime[k] = value;
    if (v.build) build[k] = value;
  }

  const secretKey = /SECRET|TOKEN|PASS|KEY|URL|DSN|AUTH|PRIVATE|CREDENTIAL/i;
  const values = Object.entries(runtime).concat(Object.entries(build));
  const secrets = values.filter(([k, v]) => v.length >= 6 && (secretKey.test(k) || v.length >= 20)).map(([, v]) => v);
  // Shared values of any scope that ended up in the environment are redacted too.
  for (const [k, v] of [...Object.entries(sharedMap), ...Object.entries(projectMap), ...Object.entries(orgMap)]) {
    if (v.length >= 6 && secretKey.test(k) && values.some(([, x]) => x.includes(v))) secrets.push(v);
  }

  return { runtime, build, secrets: [...new Set(secrets)], missing: [...missing] };
}
