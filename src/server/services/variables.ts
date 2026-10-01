import { eq, or } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, decryptOrNull } from "@/server/crypto";
import { engines } from "@/server/databases/engines";
import { databaseUrl } from "@/server/databases/options";
import { composeVarSuffix, PRIVATE_VARS, pickList, REF, REPLICA_REF, referenceName, replicaCount, replicaEnv, replicaPick } from "@/lib/refs";
import { pickPrimaryDomain } from "@/lib/domains";
import { privateHost } from "@/lib/hostname";
import { meshMemberIds, reachesPrivately } from "@/server/mesh/members";
import { runServerIds } from "@/server/deploy/distribution";
import { resolveSecretRefs } from "@/server/secrets/resolve";
import { branchVars } from "@/server/databases/branches";
import { SECRETS_SCOPE } from "@/lib/secret-providers";

type Service = typeof schema.service.$inferSelect;
type Domain = typeof schema.domain.$inferSelect;

/** Variables every service exposes to others via ${{service.VAR}} references. */
export function providedVars(service: Service, domains: Domain[] = []): Record<string, string> {
  const vars: Record<string, string> = {
    SERVE_SERVICE_NAME: service.name,
    SERVE_PRIVATE_DOMAIN: privateHost(service),
  };
  const primary = pickPrimaryDomain(domains);
  if (primary) {
    vars.SERVE_PUBLIC_DOMAIN = primary.hostname;
    // Tunnel domains are HTTPS at Cloudflare even though the proxy serves them over HTTP.
    vars.SERVE_PUBLIC_URL = `${primary.https || primary.tunnelId ? "https" : "http"}://${primary.hostname}`;
  }
  // A stack whose services have domains of their own (an API next to the web app) gets each one too.
  if (service.type === "compose") {
    const byService = new Map<string, Domain[]>();
    for (const d of domains) if (d.composeService) byService.set(d.composeService, [...(byService.get(d.composeService) ?? []), d]);
    for (const [name, list] of byService) {
      const main = pickPrimaryDomain(list);
      if (!main) continue;
      const suffix = composeVarSuffix(name);
      vars[`SERVE_PUBLIC_DOMAIN_${suffix}`] = main.hostname;
      vars[`SERVE_PUBLIC_URL_${suffix}`] = `${main.https || main.tunnelId ? "https" : "http"}://${main.hostname}`;
    }
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
    const url = databaseUrl(cfg, creds, privateHost(service), engine.port);
    Object.assign(vars, {
      HOST: privateHost(service),
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

export type ResolvedEnv = {
  runtime: Record<string, string>;
  build: Record<string, string>;
  /** Secrets that must be redacted from logs. */
  secrets: string[];
  /** References that could not be resolved. */
  missing: string[];
  /** Secret manager references that could not be read: the deploy stops on these. */
  failedSecrets: string[];
  /** Runtime variables of single replicas, by replica number (from 1); they win over `runtime`. */
  replicas: Record<number, Record<string, string>>;
};

/** Resolve service variables, shared variables and ${{ref}} references. */
export async function resolveEnv(service: Service): Promise<ResolvedEnv> {
  const [scope] = await db
    .select({ projectId: schema.project.id, organizationId: schema.project.organizationId })
    .from(schema.environment)
    .innerJoin(schema.project, eq(schema.environment.projectId, schema.project.id))
    .where(eq(schema.environment.id, service.environmentId));
  const [own, shared, siblings, siblingDomains, mesh, branches] = await Promise.all([
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
    meshMemberIds(),
    // Branches of the environment's Postgres databases: ${{postgres.branches.<name>.DATABASE_URL}}.
    db
      .select({ branch: schema.databaseBranch })
      .from(schema.databaseBranch)
      .innerJoin(schema.service, eq(schema.databaseBranch.serviceId, schema.service.id))
      .where(eq(schema.service.environmentId, service.environmentId)),
  ]);

  const domainsBy = new Map<string, Domain[]>();
  for (const { domain } of siblingDomains) {
    domainsBy.set(domain.serviceId, [...(domainsBy.get(domain.serviceId) ?? []), domain]);
  }

  // Shared variables of every scope are used by reference only.
  const sharedMap: Record<string, string> = {};
  const projectMap: Record<string, string> = {};
  const orgMap: Record<string, string> = {};
  for (const v of shared) {
    const target = v.environmentId ? sharedMap : v.projectId ? projectMap : orgMap;
    target[v.key] = decryptOrNull(v.value) ?? "";
  }

  const lookup = new Map<string, Record<string, string>>();
  const nameCount = new Map<string, number>();
  for (const s of siblings) nameCount.set(referenceName(s.name), (nameCount.get(referenceName(s.name)) ?? 0) + 1);
  const ambiguous = new Set([...nameCount].filter(([, n]) => n > 1).map(([k]) => k));
  // Private hostnames only resolve where the service runs too, or across a shared private network,
  // from every server this service runs on (extra servers get the same variables).
  const runsOn = (x: Service) => runServerIds(x.serverId, x.type === "app" ? x.distribution : null);
  const mine = runsOn(service);
  const remoteOnly = new Map<string, Set<string>>();
  // Slugs are unique and always win over a name that happens to match one.
  const slugs = new Set(siblings.map((s) => s.slug.toLowerCase()));
  for (const s of siblings) {
    let provided = {
      ...providedVars(s, domainsBy.get(s.id) ?? []),
      ...branchVars(
        s,
        branches.filter((b) => b.branch.serviceId === s.id).map((b) => b.branch),
      ),
    };
    if (s.id !== service.id && !reachesPrivately(mesh, mine, { serverId: s.serverId, servers: runsOn(s) })) {
      // Branch variables are named branches.<name>.KEY: their last part says whether they are private.
      const hidden = new Set(Object.keys(provided).filter((k) => PRIVATE_VARS.test(k.split(".").pop() ?? k)));
      provided = Object.fromEntries(Object.entries(provided).filter(([k]) => !hidden.has(k)));
      for (const name of [s.slug, s.name, referenceName(s.name)]) remoteOnly.set(name.toLowerCase(), hidden);
    }
    lookup.set(s.slug.toLowerCase(), provided);
    // Two services with the same name: neither answers to it, only to its unique slug.
    if (ambiguous.has(referenceName(s.name))) continue;
    if (!slugs.has(s.name.toLowerCase())) lookup.set(s.name.toLowerCase(), provided);
    // Preferred form: names with spaces or symbols become dashed ("postgresql-sd").
    if (!lookup.has(referenceName(s.name)) && !slugs.has(referenceName(s.name))) lookup.set(referenceName(s.name), provided);
  }
  // Secret manager values, fetched now for the references this service's values use.
  const ownValues = own.map((v) => decrypt(v.value));
  const secretRefs = scope
    ? await resolveSecretRefs(scope.organizationId, scope.projectId, service.environmentId, [
        ...ownValues,
        ...Object.values(sharedMap),
        ...Object.values(projectMap),
        ...Object.values(orgMap),
        ...Object.values(service.replicaVars ?? {}).flatMap((vars) => Object.values(vars).map((v) => decryptOrNull(v) ?? "")),
      ])
    : { found: new Map<string, string>(), errors: [] as { ref: string; message: string }[] };
  lookup.set(SECRETS_SCOPE, Object.fromEntries(secretRefs.found));

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

  // Each value of a replica.pick list is filled in on its own and escaped again, so a filled-in
  // value with commas or brackets stays one value.
  const expand = (value: string, depth = 0): string => {
    let out = "";
    let last = 0;
    for (const m of value.matchAll(REPLICA_REF)) {
      out += expandRefs(value.slice(last, m.index), depth);
      out += m[2] !== undefined ? replicaPick(pickList(m[2]).map((item) => expandRefs(item, depth))) : m[0];
      last = m.index + m[0].length;
    }
    return out + expandRefs(value.slice(last), depth);
  };
  const expandRefs = (value: string, depth: number): string =>
    value.replace(REF, (_match, ref: string) => {
      // Filled in per container when replicas start (replicaEnv).
      if (/^replica\.(index|number|count)$/i.test(ref)) return _match;
      const dot = ref.indexOf(".");
      let result: string | undefined;
      if (dot === -1) {
        // Serve's own names win: SERVE_PUBLIC_URL=${{SERVE_PUBLIC_URL}} is the domain, not itself.
        result = ref.startsWith("SERVE_") && self[ref] !== undefined ? self[ref] : (ownRaw[ref]?.value ?? sharedMap[ref] ?? self[ref]);
      } else {
        const scope = lookup.get(ref.slice(0, dot).toLowerCase());
        result = scope?.[ref.slice(dot + 1)];
        if (result === undefined && remoteOnly.get(ref.slice(0, dot).toLowerCase())?.has(ref.slice(dot + 1))) {
          missing.add(`${ref} (runs on another server: put both servers in the same private network, or use its public domain or port)`);
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
  // Shared variables only reach a service through references like KEY=${{environment.KEY}}.
  if (service.type === "app" && service.runtime.port) runtime.PORT = String(service.runtime.port);
  for (const [k, v] of Object.entries(ownRaw)) {
    const value = expand(v.value);
    if (v.runtime) runtime[k] = value;
    if (v.build) build[k] = value;
  }

  // Builds happen once: they see the first replica.
  Object.assign(build, replicaEnv(build, 0, service.type === "app" ? replicaCount(service.runtime.replicas, service.distribution?.extraServerIds?.length ?? 0) : 1));
  delete build.SERVE_REPLICA_INDEX;
  delete build.SERVE_REPLICA_COUNT;

  const replicas: Record<number, Record<string, string>> = {};
  for (const [n, vars] of Object.entries(service.replicaVars ?? {})) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) out[k] = expand(decryptOrNull(v) ?? "");
    if (Object.keys(out).length) replicas[Number(n)] = out;
  }

  const secretKey = /SECRET|TOKEN|PASS|KEY|URL|DSN|AUTH|PRIVATE|CREDENTIAL/i;
  const values = Object.entries(runtime).concat(Object.entries(build), ...Object.values(replicas).map((r) => Object.entries(r)));
  // What each replica gets from a replica.pick list is redacted like a value of its own.
  for (const [k, v] of [...values]) for (const m of v.matchAll(REPLICA_REF)) if (m[2] !== undefined) for (const item of pickList(m[2])) values.push([k, item]);
  const secrets = values.filter(([k, v]) => v.length >= 6 && (secretKey.test(k) || v.length >= 20)).map(([, v]) => v);
  // Shared values of any scope that ended up in the environment are redacted too.
  for (const [k, v] of [...Object.entries(sharedMap), ...Object.entries(projectMap), ...Object.entries(orgMap)]) {
    if (v.length >= 6 && secretKey.test(k) && values.some(([, x]) => x.includes(v))) secrets.push(v);
  }

  // Values from a secret manager are always redacted.
  for (const v of secretRefs.found.values()) if (v.length >= 4) secrets.push(v);
  const failedRefs = new Set(secretRefs.errors.map((e) => e.ref));
  return {
    runtime,
    build,
    secrets: [...new Set(secrets)],
    // A secret that failed is reported once, with its reason, in failedSecrets.
    missing: [...missing].filter((m) => !failedRefs.has(m)),
    failedSecrets: secretRefs.errors.map((e) => `\${{${e.ref}}}: ${e.message}`),
    replicas,
  };
}
