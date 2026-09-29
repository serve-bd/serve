// Applies per-service HTTP options to the e2e whoami service and checks nginx behaviour with curl.
// Usage: set -a; source .env; source .env.e2e; set +a; npx tsx --tsconfig tsconfig.json scripts/e2e/proxy-options.mts
import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { buildProxyConfig, proxyInputSchema, type ProxyInput } from "@/server/services/proxy-config";
import { syncServiceProxy } from "@/server/proxy/nginx";

const SERVICE = process.env.SERVICE ?? "ig64w8k4towadiky";
const PORT = process.env.PROXY_PORT ?? "8081";
const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, SERVICE));
const host = domain.hostname;
const results: string[] = [];

async function apply(input: ProxyInput) {
  const [svc] = await db.select().from(schema.service).where(eq(schema.service.id, SERVICE));
  const config = buildProxyConfig(proxyInputSchema.parse(input), svc.proxy ?? null);
  await db.update(schema.service).set({ proxy: config }).where(eq(schema.service.id, SERVICE));
  await syncServiceProxy(SERVICE);
  // nginx reloads gracefully: old workers answer for a moment after the reload.
  await new Promise((r) => setTimeout(r, 800));
}
function curl(args: string) {
  return execSync(`curl -s -o /dev/null -D - -w "%{http_code}" -H "Host: ${host}" ${args} http://127.0.0.1:${PORT}/ || true`).toString();
}
const status = (out: string) => out.trim().split("\n").pop()!;
const check = (label: string, ok: boolean, detail = "") => results.push(`${ok ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);

await apply({ basicAuth: { enabled: true, username: "admin", password: "secret123" } });
check("basic auth without credentials → 401", status(curl("")) === "401");
check("basic auth with credentials → 200", status(curl("-u admin:secret123")) === "200");
check(
  "ACME path stays open",
  status(execSync(`curl -s -o /dev/null -w "%{http_code}" -H "Host: ${host}" http://127.0.0.1:${PORT}/.well-known/acme-challenge/x || true`).toString()) === "404",
);

await apply({ deny: ["0.0.0.0/0", "::/0"] });
check("IP deny → 403", status(curl("")) === "403");

await apply({ headers: [{ name: "X-Serve-Test", value: "hello world" }], securityHeaders: true });
const h = curl("");
check("custom header", /x-serve-test: hello world/i.test(h));
check("security headers", /x-content-type-options: nosniff/i.test(h) && /x-frame-options: SAMEORIGIN/i.test(h) && /referrer-policy/i.test(h));

await apply({ maxBodySize: "1k" });
execSync("head -c 4096 /dev/zero > /tmp/claude-1000/body.bin");
check("body over limit → 413", status(curl(`-X POST --data-binary @/tmp/claude-1000/body.bin`)) === "413");

await apply({ corsOrigins: ["https://app.example.com"] });
const pre = curl(`-X OPTIONS -H "Origin: https://app.example.com" -H "Access-Control-Request-Method: POST"`);
check("CORS preflight → 204 with allow-origin", status(pre) === "204" && /access-control-allow-origin: https:\/\/app\.example\.com/i.test(pre));
const other = curl(`-H "Origin: https://evil.example"`);
check("CORS other origin gets no allow-origin", !/access-control-allow-origin/i.test(other));

await apply({ corsOrigins: ["*"], basicAuth: { enabled: true, username: "admin", password: "secret123" } });
check("auth + CORS: preflight passes without credentials", status(curl(`-X OPTIONS -H "Origin: https://x.dev"`)) === "204");
check("auth + CORS: GET still needs credentials", status(curl("")) === "401");

await apply({ gzip: true });
const gz = execSync(
  `curl -s -o /dev/null -D - -H "Host: ${host}" -H "Accept-Encoding: gzip" "http://127.0.0.1:${PORT}/?pad=$(head -c 3000 /dev/zero | tr '\\0' a)" || true`,
).toString();
check("gzip on (whoami echoes the long URL)", /content-encoding: gzip/i.test(gz), gz.match(/content-length: \d+/i)?.[0] ?? "");
await apply({ gzip: false });
const nogz = execSync(
  `curl -s -o /dev/null -D - -H "Host: ${host}" -H "Accept-Encoding: gzip" "http://127.0.0.1:${PORT}/?pad=$(head -c 3000 /dev/zero | tr '\\0' a)" || true`,
).toString();
check("gzip off", !/content-encoding: gzip/i.test(nogz));

await apply({ cacheStatic: true, websockets: false, buffering: false, connectTimeout: 5, readTimeout: 600 });
check("static caching, no websockets, no buffering, timeouts → 200", status(curl("")) === "200");
const st = execSync(`curl -s -o /dev/null -D - -H "Host: ${host}" http://127.0.0.1:${PORT}/app.css || true`).toString();
check("static file gets Cache-Control", /cache-control: public, max-age=604800/i.test(st));

// Invalid custom directive: nginx -t fails, the old site stays.
const before = status(curl(""));
try {
  await apply({ customDirectives: "this_is_not_a_directive on;" });
  check("invalid directive rejected", false);
} catch (e) {
  check("invalid directive rejected", /unknown directive/i.test((e as Error).message), (e as Error).message.split("\n")[0].slice(0, 90));
}
check("site restored after rejected directive", status(curl("")) === before);

// Back to defaults.
await db.update(schema.service).set({ proxy: null }).where(eq(schema.service.id, SERVICE));
await syncServiceProxy(SERVICE);
check("defaults restored → 200", status(curl("")) === "200");

console.log(results.join("\n"));
await sql.end();
process.exit(results.some((r) => r.startsWith("✗")) ? 1 : 0);
