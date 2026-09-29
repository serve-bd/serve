// Switches the fake remote server between nginx, Caddy and Traefik and checks
// routing, error pages, per-service options, redirects and analytics.
// Usage: set -a; source .env; source .env.e2e; set +a
//        npx tsx --tsconfig tsconfig.json scripts/e2e/proxy-kinds.mts [caddy traefik nginx]
import { execSync } from "node:child_process";
import { eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { newId } from "@/server/id";
import { defaultRuntime } from "@/server/services/types";
import { newWebhookSecret, queueDeployment, uniqueServiceSlug } from "@/server/services/create";
import { buildProxyConfig, proxyInputSchema } from "@/server/services/proxy-config";
import { switchProxy } from "@/server/proxy/switch";
import { syncServiceProxy } from "@/server/proxy/nginx";
import { ingestAccessLog } from "@/server/analytics";
import { forgetServer, getServer } from "@/server/servers/context";

const REMOTE = "e2eremote";
const PORT = Number(process.env.REMOTE_HTTP_PORT ?? 8090);
const kinds = (process.argv.slice(2).length ? process.argv.slice(2) : ["caddy", "traefik", "nginx"]) as ("nginx" | "caddy" | "traefik")[];
const results: string[] = [];
const ok = (cond: boolean, label: string, detail = "") => results.push(`${cond ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);

function curl(host: string, args = "") {
  try {
    return execSync(`curl -s -m 8 -o /tmp/claude-1000/pk-body -w "%{http_code}" -D /tmp/claude-1000/pk-head -H "Host: ${host}" ${args} http://127.0.0.1:${PORT}/`).toString();
  } catch {
    return "000";
  }
}
const head = () => execSync("cat /tmp/claude-1000/pk-head").toString().toLowerCase();
const body = () => execSync("cat /tmp/claude-1000/pk-body").toString();

// Remote reachable?
await db.update(schema.server).set({ status: "ready", statusMessage: null }).where(eq(schema.server.id, REMOTE));
forgetServer(REMOTE);
const ctx = await getServer(REMOTE);
await ctx.docker.ping();

const [probe] = await db.select().from(schema.service).where(eq(schema.service.id, "ig64w8k4towadiky"));
const created: string[] = [];
async function make(name: string, values: Partial<typeof schema.service.$inferInsert>) {
  const id = newId();
  await db.insert(schema.service).values({
    id,
    projectId: probe.projectId,
    environmentId: probe.environmentId,
    serverId: REMOTE,
    name,
    slug: await uniqueServiceSlug(name),
    type: "app",
    runtime: defaultRuntime(80),
    webhookSecret: newWebhookSecret(),
    source: { type: "image", image: "traefik/whoami:latest" },
    ...values,
  });
  created.push(id);
  return id;
}
async function deploy(id: string) {
  const dep = await queueDeployment(id, "manual");
  for (let i = 0; i < 180; i++) {
    const [d] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, dep));
    if (["success", "failed"].includes(d.status)) return d.status;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "timeout";
}

try {
  const app = await make("pk app", {});
  const stopped = await make("pk stopped", { status: "stopped" });
  const suffix = Date.now().toString(36);
  const H = { app: `pk-app-${suffix}.test`, www: `www.pk-app-${suffix}.test`, stopped: `pk-stop-${suffix}.test`, redirect: `pk-go-${suffix}.test` };
  await db.insert(schema.domain).values([
    { id: newId(), serviceId: app, hostname: H.app, https: false, forceHttps: false },
    { id: newId(), serviceId: app, hostname: H.www, https: false, forceHttps: false },
    { id: newId(), serviceId: app, hostname: H.redirect, https: false, forceHttps: false, redirectTo: "https://example.com" },
    { id: newId(), serviceId: stopped, hostname: H.stopped, https: false, forceHttps: false },
  ]);
  ok((await deploy(app)) === "success", "whoami deployed on the remote");

  for (const kind of kinds) {
    try {
      await switchProxy(REMOTE, kind);
      ok(true, `${kind}: switched`);
    } catch (e) {
      ok(false, `${kind}: switched`, (e as Error).message);
      const [row] = await db.select({ sw: schema.server.proxySwitch }).from(schema.server).where(eq(schema.server.id, REMOTE));
      console.log(row?.sw?.log);
      continue;
    }
    await new Promise((r) => setTimeout(r, 1500));
    let code = curl(H.app);
    ok(code === "200" && body().includes("Hostname"), `${kind}: app answers`, code);
    code = curl(`nope-${suffix}.test`);
    ok(code === "404" && body().includes("Nothing is deployed"), `${kind}: unknown host 404 page`, code);
    code = curl(H.stopped);
    ok(code === "503" && body().includes("not running"), `${kind}: stopped service 503 page`, code);
    code = curl(H.redirect);
    ok((code === "308" || (kind === "traefik" && code === "301")) && head().includes("location: https://example.com/"), `${kind}: redirect domain`, code);

    // Per-service options.
    const cfg = buildProxyConfig(
      proxyInputSchema.parse({
        basicAuth: { enabled: true, username: "admin", password: "secret-pass" },
        headers: [{ name: "X-Serve-Test", value: "yes" }],
        securityHeaders: true,
        corsOrigins: ["https://app.example.com"],
        wwwRedirect: "to-apex",
      }),
      null,
    );
    await db.update(schema.service).set({ proxy: cfg }).where(eq(schema.service.id, app));
    await syncServiceProxy(app);
    await new Promise((r) => setTimeout(r, 1500));
    code = curl(H.app);
    ok(code === "401", `${kind}: basic auth required`, code);
    code = curl(H.app, "-u admin:secret-pass");
    ok(code === "200" && head().includes("x-serve-test: yes") && head().includes("x-content-type-options: nosniff"), `${kind}: auth ok + headers`, code);
    code = curl(H.app, `-X OPTIONS -H "Origin: https://app.example.com" -H "Access-Control-Request-Method: POST"`);
    ok(["200", "204"].includes(code) && head().includes("access-control-allow-origin: https://app.example.com"), `${kind}: CORS preflight`, code);
    code = curl(H.www);
    ok((code === "308" || (kind === "traefik" && code === "301")) && head().includes(`location: http://${H.app}/`), `${kind}: www → apex`, code);
    code = curl(H.app, `-u admin:secret-pass -H "Accept-Encoding: gzip" --compressed`);
    ok(code === "200", `${kind}: gzip request`, code);

    const deny = buildProxyConfig(proxyInputSchema.parse({ deny: ["0.0.0.0/0"] }), null);
    await db.update(schema.service).set({ proxy: deny }).where(eq(schema.service.id, app));
    await syncServiceProxy(app);
    await new Promise((r) => setTimeout(r, 1500));
    code = curl(H.app);
    ok(code === "403" || (kind === "traefik" && code === "404"), `${kind}: deny list blocks`, code);

    // Invalid raw config is rejected and the site keeps working.
    const bad = buildProxyConfig(
      proxyInputSchema.parse(
        kind === "nginx"
          ? { customDirectives: "nonsense_directive on;" }
          : kind === "caddy"
            ? { caddyDirectives: "nonsense_directive on" }
            : { traefikMiddlewares: "broken:\n  notAMiddleware: {}" },
      ),
      null,
    );
    await db.update(schema.service).set({ proxy: bad }).where(eq(schema.service.id, app));
    let rejected = false;
    try {
      await syncServiceProxy(app);
    } catch {
      rejected = true;
    }
    await db.update(schema.service).set({ proxy: null }).where(eq(schema.service.id, app));
    await syncServiceProxy(app);
    await new Promise((r) => setTimeout(r, 1500));
    code = curl(H.app);
    ok(rejected && code === "200", `${kind}: invalid raw config rejected, site restored`, `${rejected} ${code}`);

    await ingestAccessLog(); // first read only records where the log ends
    for (let i = 0; i < 5; i++) curl(H.app);
    await new Promise((r) => setTimeout(r, kind === "nginx" ? 6500 : 1500));
    await ingestAccessLog();
    const rows = await sql`select sum(requests)::int as n from request_metric where hostname = ${H.app}`;
    ok((rows[0]?.n ?? 0) > 0, `${kind}: analytics ingested`, String(rows[0]?.n ?? 0));
  }
} finally {
  if (created.length) {
    await db.delete(schema.domain).where(inArray(schema.domain.serviceId, created));
    for (const id of created) execSync(`docker exec serve-e2e-remote sh -c 'docker rm -f $(docker ps -aq --filter label=serve.service=${id}) 2>/dev/null || true'`);
    await db.delete(schema.service).where(inArray(schema.service.id, created));
  }
  console.log(results.join("\n"));
  await sql.end();
  process.exit(0);
}
