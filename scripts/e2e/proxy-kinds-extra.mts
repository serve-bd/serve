// TLS with a Serve-managed certificate, per-proxy settings, stop/start and busy ports on the fake remote.
// Usage: set -a; source .env; source .env.e2e; set +a
//        npx tsx --tsconfig tsconfig.json scripts/e2e/proxy-kinds-extra.mts [caddy traefik nginx]
import { execSync } from "node:child_process";
import { eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { newId } from "@/server/id";
import { defaultRuntime } from "@/server/services/types";
import { newWebhookSecret, queueDeployment, uniqueServiceSlug } from "@/server/services/create";
import { switchProxy } from "@/server/proxy/switch";
import { applyServerProxyConfig, ensureServerProxy, getProxyContainer, proxyStateOf, startProxy, stopProxy, syncServiceProxy } from "@/server/proxy/nginx";
import { forgetServer, getServer } from "@/server/servers/context";
import { proxyPaths } from "@/server/paths";

const REMOTE = "e2eremote";
const kinds = (process.argv.slice(2).length ? process.argv.slice(2) : ["caddy", "traefik", "nginx"]) as ("nginx" | "caddy" | "traefik")[];
const results: string[] = [];
const ok = (cond: boolean, label: string, detail = "") => results.push(`${cond ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
const sh = (cmd: string) => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch (e) {
    return String((e as { stdout?: Buffer }).stdout ?? "");
  }
};

await db.update(schema.server).set({ status: "ready", statusMessage: null, proxyStopped: false }).where(eq(schema.server.id, REMOTE));
forgetServer(REMOTE);
const ctx = await getServer(REMOTE);
const [probe] = await db.select().from(schema.service).where(eq(schema.service.id, "ig64w8k4towadiky"));
const [proj] = await db.select().from(schema.project).where(eq(schema.project.id, probe.projectId));
const created: string[] = [];
const certId = newId();
const host = `pk-tls-${Date.now().toString(36)}.test`;

try {
  // Self-signed certificate stored on the remote like an uploaded one.
  sh(`openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=${host}" -keyout /tmp/claude-1000/pk.key -out /tmp/claude-1000/pk.crt 2>/dev/null`);
  await ctx.fs.writeFile(`${ctx.paths.certs}/${certId}/fullchain.pem`, sh("cat /tmp/claude-1000/pk.crt") + "\n");
  await ctx.fs.writeFile(`${ctx.paths.certs}/${certId}/privkey.pem`, sh("cat /tmp/claude-1000/pk.key") + "\n");
  await db.insert(schema.certificate).values({
    id: certId,
    organizationId: proj.organizationId,
    serverId: REMOTE,
    name: host,
    domains: [host],
    provider: "custom",
    status: "active",
    certPath: `${proxyPaths.certs}/${certId}/fullchain.pem`,
    keyPath: `${proxyPaths.certs}/${certId}/privkey.pem`,
  });
  const id = newId();
  await db.insert(schema.service).values({
    id,
    projectId: probe.projectId,
    environmentId: probe.environmentId,
    serverId: REMOTE,
    name: "pk tls",
    slug: await uniqueServiceSlug("pk tls"),
    type: "app",
    runtime: defaultRuntime(80),
    webhookSecret: newWebhookSecret(),
    source: { type: "image", image: "traefik/whoami:latest" },
  });
  created.push(id);
  await db.insert(schema.domain).values({ id: newId(), serviceId: id, hostname: host, https: true, forceHttps: true, certificateId: certId });
  const dep = await queueDeployment(id, "manual");
  for (let i = 0; i < 120; i++) {
    const [d] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, dep));
    if (["success", "failed"].includes(d.status)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  for (const kind of kinds) {
    await switchProxy(REMOTE, kind);
    await syncServiceProxy(id);
    await new Promise((r) => setTimeout(r, 2000));
    const redirect = sh(`curl -s -o /dev/null -w "%{http_code} %{redirect_url}" -H "Host: ${host}" http://127.0.0.1:8090/`);
    ok(/^30[18] https:\/\//.test(redirect), `${kind}: HTTP redirects to HTTPS`, redirect);
    const tls = sh(`curl -sk -m 8 -o /dev/null -w "%{http_code}" --resolve ${host}:8453:127.0.0.1 https://${host}:8453/`);
    const cn = sh(`echo | openssl s_client -connect 127.0.0.1:8453 -servername ${host} 2>/dev/null | openssl x509 -noout -subject`);
    ok(tls === "200" && cn.includes(host), `${kind}: HTTPS with Serve's certificate`, `${tls} ${cn}`);

    // Settings: an invalid raw value is rejected and the old settings stay; a valid change applies.
    const { config } = await proxyStateOf(REMOTE);
    const bad =
      kind === "nginx"
        ? { nginx: { ...config.nginx, files: [{ name: "bad.conf", content: "nonsense_directive on;" }] } }
        : kind === "caddy"
          ? { caddy: { ...config.caddy, rawGlobal: "nonsense_option on" } }
          : {
              traefik: {
                ...config.traefik,
                files: [
                  {
                    name: "bad.yaml",
                    content:
                      "http:\n  middlewares:\n    x:\n      notAMiddleware: {}\n  routers:\n    extra:\n      rule: Host(`x.test`)\n      service: noop@internal\n      middlewares: [x]",
                  },
                ],
              },
            };
    let rejected = false;
    try {
      await applyServerProxyConfig(ctx, { ...config, ...bad });
    } catch {
      rejected = true;
    }
    const after = await proxyStateOf(REMOTE);
    ok(rejected && JSON.stringify(after.config) === JSON.stringify(config), `${kind}: invalid settings rejected and restored`);
    const good =
      kind === "nginx"
        ? { nginx: { keepaliveTimeout: 30 } }
        : kind === "caddy"
          ? { caddy: { logLevel: "WARN" as const } }
          : { traefik: { logLevel: "WARN" as const, metrics: true } };
    let applied = true;
    try {
      await applyServerProxyConfig(ctx, { ...config, ...good });
    } catch (e) {
      applied = false;
      console.log((e as Error).message);
    }
    const code = sh(`curl -sk -o /dev/null -w "%{http_code}" --resolve ${host}:8453:127.0.0.1 https://${host}:8453/`);
    ok(applied && code === "200", `${kind}: valid settings applied`, code);
    await applyServerProxyConfig(ctx, config).catch(() => {});

    // Stop keeps the proxy down (also through ensureServerProxy); start brings it back.
    await stopProxy(ctx);
    await ensureServerProxy(ctx);
    const down = !(await getProxyContainer(ctx))?.State.Running;
    const offline = sh(`curl -s -m 3 -o /dev/null -w "%{http_code}" -H "Host: ${host}" http://127.0.0.1:8090/`);
    await startProxy(ctx);
    await new Promise((r) => setTimeout(r, 2000));
    const back = sh(`curl -sk -o /dev/null -w "%{http_code}" --resolve ${host}:8453:127.0.0.1 https://${host}:8453/`);
    ok(down && offline === "000" && back === "200", `${kind}: stop stays stopped, start restores`, `${down} ${offline} ${back}`);
  }

  // A busy port is refused and the proxy keeps running on the old ports.
  sh(`docker exec serve-e2e-remote docker rm -f pk-busy`);
  sh(`docker exec serve-e2e-remote docker run -d --name pk-busy -p 8181:80 nginx:stable-alpine`);
  await db.update(schema.server).set({ proxyHttpPort: 8181 }).where(eq(schema.server.id, REMOTE));
  forgetServer(REMOTE);
  let message = "";
  try {
    await ensureServerProxy(await getServer(REMOTE));
  } catch (e) {
    message = (e as Error).message;
  }
  await db.update(schema.server).set({ proxyHttpPort: 80 }).where(eq(schema.server.id, REMOTE));
  forgetServer(REMOTE);
  const still = sh(`curl -s -o /dev/null -w "%{http_code}" -H "Host: nope.test" http://127.0.0.1:8090/`);
  ok(/Port 8181 is already used/.test(message) && still === "404", "busy port refused, proxy kept", `${message} ${still}`);
  sh(`docker exec serve-e2e-remote docker rm -f pk-busy`);
} finally {
  if (created.length) {
    await db.delete(schema.domain).where(inArray(schema.domain.serviceId, created));
    for (const id of created) sh(`docker exec serve-e2e-remote sh -c 'docker rm -f $(docker ps -aq --filter label=serve.service=${id}) 2>/dev/null || true'`);
    await db.delete(schema.service).where(inArray(schema.service.id, created));
  }
  await db.delete(schema.certificate).where(eq(schema.certificate.id, certId));
  await ctx.fs.rm(`${ctx.paths.certs}/${certId}`).catch(() => {});
  console.log(results.join("\n"));
  await sql.end();
  process.exit(0);
}
