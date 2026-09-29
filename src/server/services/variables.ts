import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, decryptOrNull } from "@/server/crypto";
import { engines } from "@/server/databases/engines";
import { referenceName } from "@/lib/refs";

type Service = typeof schema.service.$inferSelect;
type Domain = typeof schema.domain.$inferSelect;

/** Variables every service exposes to others via ${{service.VAR}} references. */
export function providedVars(service: Service, domains: Domain[] = []): Record<string, string> {
  const vars: Record<string, string> = {
    SERVE_SERVICE_NAME: service.name,
    SERVE_PRIVATE_DOMAIN: service.slug,
  };
  const primary = domains.find((d) => !d.redirectTo) ?? null;
  if (primary) {
    vars.SERVE_PUBLIC_DOMAIN = primary.hostname;
    vars.SERVE_PUBLIC_URL = `${primary.https ? "https" : "http"}://${primary.hostname}`;
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
    const url = engine.url({ ...creds, host: service.slug, port: engine.port });
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
  const [own, shared, siblings, siblingDomains] = await Promise.all([
    db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, service.id)),
    db.select().from(schema.sharedVar).where(eq(schema.sharedVar.environmentId, service.environmentId)),
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

  const sharedMap: Record<string, string> = {};
  for (const v of shared) sharedMap[v.key] = decryptOrNull(v.value) ?? "";

  const lookup = new Map<string, Record<string, string>>();
  for (const s of siblings) {
    const provided = providedVars(s, domainsBy.get(s.id) ?? []);
    lookup.set(s.slug.toLowerCase(), provided);
    lookup.set(s.name.toLowerCase(), provided);
    // Preferred form: names with spaces or symbols become dashed ("postgresql-sd").
    if (!lookup.has(referenceName(s.name))) lookup.set(referenceName(s.name), provided);
  }
  lookup.set("shared", sharedMap);

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
  const secrets = Object.entries(runtime)
    .concat(Object.entries(build))
    .filter(([k, v]) => v.length >= 6 && (secretKey.test(k) || v.length >= 20))
    .map(([, v]) => v);

  return { runtime, build, secrets: [...new Set(secrets)], missing: [...missing] };
}
