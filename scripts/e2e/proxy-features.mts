// Custom files, built-in defaults, container overrides, per-service custom configs
// and the "None" kind on the fake remote, for each proxy.
// Usage: set -a; source .env; source .env.e2e; set +a
//        npx tsx --tsconfig tsconfig.json scripts/e2e/proxy-features.mts [caddy traefik nginx]
import { execSync } from "node:child_process";
import { eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { newId } from "@/server/id";
import { encrypt } from "@/server/crypto";
import { defaultRuntime } from "@/server/services/types";
import { newWebhookSecret, queueDeployment, uniqueServiceSlug } from "@/server/services/create";
import { switchProxy } from "@/server/proxy/switch";
import {
  applyServerProxyConfig,
  generatedSite,
  getProxyContainer,
  proxyDefinition,
  proxyStateOf,
  stopProxy,
  startProxy,
  syncServiceProxy,
  testProxyConfig,
} from "@/server/proxy/nginx";
import type { RunningKind, ServerProxyConfig } from "@/server/proxy/config";
import { forgetServer, getServer } from "@/server/servers/context";

const REMOTE = "e2eremote";
const PORT = 8090;
const kinds = (process.argv.slice(2).length ? process.argv.slice(2) : ["caddy", "traefik", "nginx"]) as RunningKind[];
const results: string[] = [];
const ok = (cond: boolean, label: string, detail = "") => results.push(`${cond ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
const sh = (cmd: string) => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch (e) {
    return String((e as { stdout?: Buffer }).stdout ?? "").trim();
  }
};
const get = (host: string, path = "/") =>
  sh(`curl -s -m 6 -o /tmp/claude-1000/pf-body -w "%{http_code}" -D /tmp/claude-1000/pf-head -H "Host: ${host}" http://127.0.0.1:${PORT}${path}`) || "000";
const body = () => sh("cat /tmp/claude-1000/pf-body");
const head = () => sh("cat /tmp/claude-1000/pf-head").toLowerCase();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll until a host answers `want` (the proxy may need a moment to pick up files). */
async function until(host: string, want = "200", ms = 6000) {
  const end = Date.now() + ms;
  let code = get(host);
  while (code !== want && Date.now() < end) {
    await wait(400);
    code = get(host);
  }
  return code;
}

await db.update(schema.server).set({ status: "ready", statusMessage: null, proxyStopped: false }).where(eq(schema.server.id, REMOTE));
forgetServer(REMOTE);
const ctx = await getServer(REMOTE);
const [probe] = await db.select().from(schema.service).where(eq(schema.service.id, "ig64w8k4towadiky"));
const created: string[] = [];
const suffix = Date.now().toString(36);
const H = { app: `pf-app-${suffix}.test`, stopped: `pf-stop-${suffix}.test`, custom: `pf-custom-${suffix}.test`, unknown: `pf-nope-${suffix}.test` };

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

/** Apply like the Proxy page does; returns the error message or null. */
async function apply(next: ServerProxyConfig) {
  try {
    await applyServerProxyConfig(ctx, next);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const customFile: Record<RunningKind, (host: string) => { name: string; content: string }> = {
  nginx: (host) => ({ name: "status.conf", content: `server {\n    listen 80;\n    server_name ${host};\n    location / { return 200 "custom-ok"; }\n}` }),
  caddy: (host) => ({ name: "status.caddy", content: `http://${host} {\n\trespond "custom-ok" 200\n}` }),
  traefik: (host) => ({
    name: "status.yaml",
    content: `http:\n  routers:\n    pf-status:\n      rule: Host(\`${host}\`)\n      entryPoints: [web]\n      service: pf-status\n      middlewares: [pf-status-path]\n  middlewares:\n    pf-status-path:\n      replacePath:\n        path: /__serve/health\n  services:\n    pf-status:\n      loadBalancer:\n        servers:\n          - url: http://${ctx.proxyContainer}-pages:80\n`,
  }),
};
const badFile: Record<RunningKind, { name: string; content: string }> = {
  nginx: { name: "bad.conf", content: "nonsense_directive on;" },
  caddy: { name: "bad.caddy", content: "http://bad.test {\n\tnonsense_directive\n}" },
  traefik: {
    name: "bad.yaml",
    content:
      "http:\n  routers:\n    pf-bad:\n      rule: Host(`bad.test`)\n      service: noop@internal\n      middlewares: [pf-x]\n  middlewares:\n    pf-x:\n      notAMiddleware: {}\n",
  },
};

try {
  const app = await make("pf app", {});
  const stopped = await make("pf stopped", { status: "stopped" });
  await db.insert(schema.domain).values([
    { id: newId(), serviceId: app, hostname: H.app, https: false, forceHttps: false },
    { id: newId(), serviceId: stopped, hostname: H.stopped, https: false, forceHttps: false },
  ]);
  const dep = await queueDeployment(app, "manual");
  for (let i = 0; i < 120; i++) {
    const [d] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, dep));
    if (["success", "failed"].includes(d.status)) break;
    await wait(2000);
  }

  for (const kind of kinds) {
    await switchProxy(REMOTE, kind);
    await syncServiceProxy(app);
    await syncServiceProxy(stopped);
    await wait(1500);
    const base = (await proxyStateOf(REMOTE)).config;
    const own = base[kind] ?? {};

    // Custom files: add, reject a broken one, rename, delete.
    let err = await apply({ ...base, [kind]: { ...own, files: [customFile[kind](H.custom)] } });
    await wait(1200);
    let code = get(H.custom);
    ok(!err && code === "200" && /custom-ok|ok/.test(body()), `${kind}: custom file serves`, err ?? `${code} ${body().slice(0, 30)}`);
    const withFile = (await proxyStateOf(REMOTE)).config;
    err = await apply({ ...withFile, [kind]: { ...withFile[kind], files: [...(withFile[kind]?.files ?? []), badFile[kind]] } });
    const after = (await proxyStateOf(REMOTE)).config;
    code = get(H.custom);
    ok(
      !!err && JSON.stringify(after) === JSON.stringify(withFile) && code === "200" && get(H.app) === "200",
      `${kind}: broken custom file rejected, rolled back`,
      (err ?? "accepted").split("\n").slice(0, 2).join(" | "),
    );
    const renamed = { ...customFile[kind](H.custom), name: customFile[kind](H.custom).name.replace("status", "renamed") };
    err = await apply({ ...after, [kind]: { ...after[kind], files: [renamed] } });
    const listing = sh(`docker exec serve-e2e-remote sh -c 'ls ${ctx.paths.proxySites} ${ctx.paths.proxyCustom} 2>/dev/null'`);
    ok(!err && listing.includes(`user-${renamed.name}`) && !listing.includes(`user-${customFile[kind](H.custom).name}`), `${kind}: rename replaces the file on disk`, err ?? "");
    err = await apply({ ...after, [kind]: { ...after[kind], files: [] } });
    await wait(1200);
    code = get(H.custom);
    ok(!err && code === "404", `${kind}: deleted custom file stops serving`, err ?? code);

    // Built-in defaults off, then on again.
    const cur = (await proxyStateOf(REMOTE)).config;
    err = await apply({ ...cur, [kind]: { ...cur[kind], defaults: { catchAll: false, unavailablePage: false, httpsRedirect: false } } });
    await wait(1200);
    const unknownOff = get(H.unknown);
    const unknownBody = body();
    const stoppedOff = get(H.stopped);
    const stoppedBody = body();
    ok(
      !err && !unknownBody.includes("Nothing is deployed") && !stoppedBody.includes("not running"),
      `${kind}: defaults off drop Serve's pages`,
      err ?? `${unknownOff} ${stoppedOff} ${unknownBody.slice(0, 60)} | ${stoppedBody.slice(0, 60)}`,
    );
    ok((await until(H.app)) === "200", `${kind}: app still answers with defaults off`);
    err = await apply({ ...cur, [kind]: { ...cur[kind], defaults: undefined } });
    await wait(1200);
    ok(!err && get(H.unknown) === "404" && body().includes("Nothing is deployed") && get(H.stopped) === "503", `${kind}: defaults on restore pages`, err ?? "");

    // Container overrides: env, extra port; a busy extra port is refused and the proxy keeps running.
    const c2 = (await proxyStateOf(REMOTE)).config;
    err = await apply({ ...c2, [kind]: { ...c2[kind], container: { env: [{ name: "PF_TEST", value: encrypt("hello") }], ports: ["18404:18404"], args: [], volumes: [] } } });
    let info = await getProxyContainer(ctx);
    ok(
      !err && !!info?.Config.Env?.includes("PF_TEST=hello") && !!(info?.HostConfig.PortBindings as Record<string, unknown>)?.["18404/tcp"] && get(H.app) === "200",
      `${kind}: container overrides applied`,
      err ?? "",
    );
    const def = (await proxyDefinition(ctx)) ?? "";
    ok(def.includes("PF_TEST=********") && !def.includes("hello") && def.includes("18404:18404"), `${kind}: effective definition masks secrets`);
    sh("docker exec serve-e2e-remote docker rm -f pf-busy");
    sh("docker exec serve-e2e-remote docker run -d --name pf-busy -p 18405:80 nginx:stable-alpine");
    const c3 = (await proxyStateOf(REMOTE)).config;
    err = await apply({ ...c3, [kind]: { ...c3[kind], container: { ...c3[kind]!.container, ports: ["18405:18405"] } } });
    info = await getProxyContainer(ctx);
    ok(
      /Port 18405 is already used/.test(err ?? "") && !!info?.State.Running && get(H.app) === "200",
      `${kind}: busy extra port refused, proxy kept`,
      (err ?? "accepted").split("\n")[0],
    );
    sh("docker exec serve-e2e-remote docker rm -f pf-busy");
    err = await apply({ ...c3, [kind]: { ...c3[kind], container: undefined } });
    info = await getProxyContainer(ctx);
    ok(!err && !info?.Config.Env?.some((e) => e.startsWith("PF_TEST")) && get(H.app) === "200", `${kind}: container reset to default`, err ?? "");

    // Per-service custom configuration.
    const generated = (await generatedSite(kind, app, ctx)) ?? "";
    const marker =
      kind === "nginx"
        ? generated.replace("location / {", 'location / {\n        add_header X-PF-Custom "yes" always;')
        : kind === "caddy"
          ? generated.replace("route {", 'route {\n\t\theader X-PF-Custom "yes"')
          : null;
    if (marker && marker !== generated) {
      await db
        .update(schema.service)
        .set({ proxyCustom: { [kind]: marker } })
        .where(eq(schema.service.id, app));
      let e2: string | null = null;
      await syncServiceProxy(app).catch((e) => (e2 = (e as Error).message));
      await wait(800);
      ok(!e2 && get(H.app) === "200" && head().includes("x-pf-custom: yes"), `${kind}: custom service config applied`, e2 ?? "");
    } else if (kind === "traefik") {
      const custom = generated.replace(/rule: Host\(`([^`]+)`\)/, "rule: Host(`$1`) || Host(`pf-alias-" + suffix + ".test`)");
      await db
        .update(schema.service)
        .set({ proxyCustom: { traefik: custom } })
        .where(eq(schema.service.id, app));
      let e2: string | null = null;
      await syncServiceProxy(app).catch((e) => (e2 = (e as Error).message));
      await wait(1200);
      ok(!e2 && get(`pf-alias-${suffix}.test`) === "200", `${kind}: custom service config applied`, e2 ?? "");
    }
    const broken =
      kind === "traefik"
        ? "http:\n  routers:\n    x:\n      rule: Host(`x.test`)\n      service: nope\n      middlewares: [missing]\n"
        : kind === "caddy"
          ? `http://${H.app} {\n\tnot_a_directive\n}`
          : "server { nonsense on; }";
    const [row] = await db.select({ c: schema.service.proxyCustom }).from(schema.service).where(eq(schema.service.id, app));
    await db
      .update(schema.service)
      .set({ proxyCustom: { [kind]: broken } })
      .where(eq(schema.service.id, app));
    let rejected = "";
    await syncServiceProxy(app).catch((e) => (rejected = (e as Error).message));
    await db.update(schema.service).set({ proxyCustom: row.c }).where(eq(schema.service.id, app));
    await syncServiceProxy(app).catch(() => {});
    const appCode = await until(H.app);
    ok(!!rejected && appCode === "200", `${kind}: broken service config rejected`, `${appCode} ${rejected.split("\n").slice(0, 2).join(" | ")}`);
    await db.update(schema.service).set({ proxyCustom: null }).where(eq(schema.service.id, app));
    await syncServiceProxy(app);
    await wait(800);
    ok(get(H.app) === "200" && !head().includes("x-pf-custom"), `${kind}: reset to managed`);

    // Neutral status while stopped.
    await stopProxy(ctx);
    const t = await testProxyConfig(ctx);
    ok(t.state === "unavailable" && !/OCI|No such container|runc/.test(t.output), `${kind}: test while stopped is neutral`, t.output);
    await startProxy(ctx);
    await wait(1500);
  }

  // No proxy.
  await switchProxy(REMOTE, "none");
  const gone = !(await getProxyContainer(ctx));
  ok(gone && get(H.app) === "000", "none: proxy removed, domains stop answering");
  await syncServiceProxy(app);
  ok((await testProxyConfig(ctx)).state === "unavailable", "none: sync and test are no-ops");
  await switchProxy(REMOTE, "nginx");
  await syncServiceProxy(app);
  await wait(1000);
  ok(get(H.app) === "200", "none → nginx: sites answer again");
} finally {
  if (created.length) {
    await db.delete(schema.domain).where(inArray(schema.domain.serviceId, created));
    for (const id of created) sh(`docker exec serve-e2e-remote sh -c 'docker rm -f $(docker ps -aq --filter label=serve.service=${id}) 2>/dev/null || true'`);
    await db.delete(schema.service).where(inArray(schema.service.id, created));
    for (const id of created) await syncServiceProxy(id).catch(() => {});
  }
  console.log(results.join("\n"));
  await sql.end();
  process.exit(0);
}
