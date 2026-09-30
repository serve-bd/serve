// Cross-server private network test: a database and a 2-replica API on server A, an app and a
// compose stack on server B, all in one environment. Checks that B reaches A by private names,
// that another environment cannot, and that the API stays reachable while it redeploys.
//   set -a; source .env.e2e; set +a; npx tsx scripts/e2e/mesh-deploy.mts <serverA> <serverB> <containerA> <containerB>
import { execFile, execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { newWebhookSecret, queueDeployment, uniqueServiceSlug } from "@/server/services/create";
import { defaultRuntime } from "@/server/services/types";

const [serverA, serverB, hostA, hostB] = process.argv.slice(2);
if (!hostB) throw new Error("usage: mesh-deploy.mts <serverA> <serverB> <containerA> <containerB>");

const sh = (host: string, cmd: string) => execFileSync("docker", ["exec", host, "sh", "-c", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const trySh = (host: string, cmd: string) => {
  try {
    return { ok: true, out: sh(host, cmd) };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: string }).stderr ?? e).trim() };
  }
};

const [root] = await db.select().from(schema.organization).limit(1);
const tag = Date.now().toString(36).slice(-4);
const projectId = newId();
await db.insert(schema.project).values({ id: projectId, organizationId: root.id, name: `mesh-${tag}` });
const envId = newId();
const otherEnvId = newId();
await db.insert(schema.environment).values([
  { id: envId, projectId, name: "production" },
  { id: otherEnvId, projectId, name: "staging" },
]);

async function service(
  values: Partial<typeof schema.service.$inferInsert> & { name: string; type: "app" | "database" | "compose"; serverId: string },
  env: Record<string, string> = {},
) {
  const id = newId();
  await db.insert(schema.service).values({
    id,
    projectId,
    environmentId: envId,
    slug: await uniqueServiceSlug(values.name),
    runtime: defaultRuntime(),
    webhookSecret: newWebhookSecret(),
    ...values,
  });
  for (const [key, value] of Object.entries(env)) await db.insert(schema.envVar).values({ id: newId(), serviceId: id, key, value: encrypt(value) });
  return id;
}

async function deploy(serviceId: string, label: string) {
  const dep = await queueDeployment(serviceId, "manual");
  for (let i = 0; i < 200; i++) {
    const [row] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, dep));
    if (row && !["queued", "building", "deploying"].includes(row.status)) {
      console.log(`${label}: ${row.status}${row.error ? ` (${row.error.split("\n")[0]})` : ""}`);
      if (row.status !== "success") {
        console.log(row.logs.split("\n").slice(-25).join("\n"));
        process.exit(1);
      }
      return row;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: timed out`);
}

const pg = await service({
  name: "postgres",
  type: "database",
  serverId: serverA,
  runtime: { ...defaultRuntime(5432), restartPolicy: "unless-stopped" },
  database: {
    engine: "postgres",
    version: "17",
    username: "app",
    password: encrypt("s3cret-pass-123"),
    database: "app",
    publicPort: null,
    backupSchedule: null,
    backupRetention: 7,
    s3DestinationId: null,
  },
});
const api = await service({
  name: "api",
  type: "app",
  serverId: serverA,
  source: { type: "image", image: "traefik/whoami:latest" },
  runtime: { ...defaultRuntime(80), replicas: 2, drainSeconds: 2 },
});
const client = await service(
  {
    name: "client",
    type: "app",
    serverId: serverB,
    source: { type: "image", image: "postgres:17-alpine" },
    // Listens on its port so the deploy health check passes; the test only runs commands in it.
    runtime: { ...defaultRuntime(5432), command: "while true; do nc -l -p 5432 >/dev/null 2>&1; done" },
  },
  { DATABASE_URL: "${{postgres.DATABASE_URL}}", API: "http://${{api.SERVE_PRIVATE_DOMAIN}}" },
);
const stack = await service(
  {
    name: "stack",
    type: "compose",
    serverId: serverB,
    compose: {
      mode: "inline",
      path: "docker-compose.yml",
      content: "services:\n  tool:\n    image: postgres:17-alpine\n    command: sleep infinity\n    environment:\n      DATABASE_URL: ${DATABASE_URL}\n",
    },
  },
  { DATABASE_URL: "${{postgres.DATABASE_URL}}" },
);

await deploy(pg, "postgres on A");
await deploy(api, "api (2 replicas) on A");
const clientDep = await deploy(client, "client on B");
await deploy(stack, "compose stack on B");
console.log(
  "client log lines about the private network:",
  clientDep.logs
    .split("\n")
    .filter((l) => /private network/i.test(l))
    .join(" | "),
);

const [pgRow] = await db.select().from(schema.service).where(eq(schema.service.id, pg));
const clientName = sh(hostB, `docker ps --filter label=serve.service=${client} --format '{{.Names}}' | head -1`);
const toolName = sh(hostB, `docker ps --filter label=serve.service=${stack} --format '{{.Names}}' | head -1`);
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const url = sh(hostB, `docker exec ${clientName} printenv DATABASE_URL`);
check("DATABASE_URL uses the private name", url.includes(`@${pgRow.slug}:5432/`), url.replace(/:[^:@/]+@/, ":***@"));
const q = trySh(hostB, `docker exec ${clientName} psql "$(docker exec ${clientName} printenv DATABASE_URL)" -tAc "select 40+2"`);
check("app on B queries postgres on A", q.ok && q.out === "42", q.out);
const q2 = trySh(hostB, `docker exec ${toolName} sh -c 'psql "$DATABASE_URL" -tAc "select 7*6"'`);
check("compose service on B queries postgres on A", q2.ok && q2.out === "42", q2.out);

const seen = new Set<string>();
for (let i = 0; i < 12; i++) {
  const r = trySh(hostB, `docker exec ${clientName} sh -c 'wget -qO- -T 3 "$API" | grep Hostname'`);
  if (r.ok) seen.add(r.out);
}
check("both api replicas answer through the private network", seen.size === 2, [...seen].join(", "));

// Another environment on B must not reach A's services even by address.
const pgIp = (await db.select().from(schema.meshAddress).where(eq(schema.meshAddress.serviceId, pg)))[0]?.ip;
const allowed = trySh(hostB, `docker exec ${clientName} sh -c 'timeout 5 pg_isready -h ${pgIp} -p 5432'`);
check("the same environment reaches the database by its private address too", allowed.ok && /accepting/.test(allowed.out), allowed.out);
sh(hostB, "docker network inspect serve-mesh-probe >/dev/null 2>&1 || docker network create serve-mesh-probe >/dev/null");
const probe = trySh(hostB, `docker run --rm --network serve-mesh-probe postgres:17-alpine sh -c 'timeout 5 pg_isready -h ${pgIp} -p 5432' `);
check("a container outside the environment cannot reach it", !probe.ok || !/accepting/.test(probe.out), probe.out);
sh(hostB, "docker network rm serve-mesh-probe >/dev/null 2>&1 || true");

// Zero downtime: keep calling the API while it redeploys.
const loop = `i=0; f=0; end=$(( $(date +%s) + 40 )); while [ $(date +%s) -lt $end ]; do i=$((i+1)); wget -qO- -T 2 "$API" >/dev/null 2>&1 || f=$((f+1)); sleep 0.2; done; echo "$i $f"`;
const calls = new Promise<string>((resolve) => {
  execFile("docker", ["exec", hostB, "docker", "exec", clientName, "sh", "-c", loop], { encoding: "utf8" }, (_e, out) => resolve(String(out).trim()));
});
await new Promise((r) => setTimeout(r, 3000));
await deploy(api, "api redeploy");
const [total, failed] = (await calls).split(" ").map(Number);
check("api stays reachable while it redeploys", failed === 0, `${failed} of ${total} calls failed`);

// Restarting the database container: the agent follows the new container address.
sh(hostA, `docker restart ${pgRow.slug} >/dev/null`);
let back = false;
for (let i = 0; i < 30 && !back; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  back = trySh(hostB, `docker exec ${clientName} sh -c 'psql "$DATABASE_URL" -tAc "select 1"'`).out === "1";
}
check("postgres is reachable again after its container restarts", back);

// Names come from Docker DNS (a link container), not from /etc/hosts.
const hostsFile = sh(hostB, `docker exec ${clientName} cat /etc/hosts`);
check("no private names written to /etc/hosts", !hostsFile.includes(pgRow.slug));
const resolved = trySh(hostB, `docker exec ${clientName} getent hosts ${pgRow.slug}`);
const linkIp = trySh(hostB, `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' serve-link-${pgIp?.replaceAll(".", "-")}`);
check("the database name resolves to its link container", resolved.ok && linkIp.ok && resolved.out.startsWith(`${linkIp.out} `), `${resolved.out} / link ${linkIp.out}`);

// Move the API from A to B (what Move to another server does): same address, now local to the client.
const [apiRow] = await db.select().from(schema.service).where(eq(schema.service.id, api));
const apiIp = (await db.select().from(schema.meshAddress).where(eq(schema.meshAddress.serviceId, api)))[0]?.ip;
sh(hostA, `docker ps -aq --filter label=serve.service=${api} | xargs -r docker rm -f >/dev/null`);
await db.update(schema.service).set({ serverId: serverB }).where(eq(schema.service.id, api));
await deploy(api, "api moved to B");
const apiIpAfter = (await db.select().from(schema.meshAddress).where(eq(schema.meshAddress.serviceId, api)))[0]?.ip;
check("a moved service keeps its private address", !!apiIp && apiIp === apiIpAfter, `${apiIp} → ${apiIpAfter}`);
let local = { ok: false, out: "" };
for (let i = 0; i < 10 && !local.ok; i++) {
  local = trySh(hostB, `docker exec ${clientName} sh -c 'wget -qO- -T 3 "$API" | grep Hostname'`);
  if (!local.ok) await new Promise((r) => setTimeout(r, 1500));
}
check("the client reaches the moved API on its own server by the same name", local.ok, local.out);
check("the old link to the API on B is gone", !trySh(hostB, `docker inspect serve-link-${apiIp?.replaceAll(".", "-")}`).ok);
// And postgres on A now reaches the API on B through a new link.
let fromA = { ok: false, out: "" };
for (let i = 0; i < 15 && !fromA.ok; i++) {
  fromA = trySh(hostA, `docker exec ${pgRow.slug} bash -c 'exec 3<>/dev/tcp/${apiRow.slug}/80 && printf "GET / HTTP/1.0\r\n\r\n" >&3 && grep -m1 Hostname <&3'`);
  if (!fromA.ok) await new Promise((r) => setTimeout(r, 2000));
}
check("a service on A reaches the API that moved to B by its name", fromA.ok, fromA.out);

// Leaving and joining again: links go away, and the same names work again after joining.
const mesh = (await db.select({ mesh: schema.server.mesh }).from(schema.server).where(eq(schema.server.id, serverB)))[0].mesh!;
await db
  .update(schema.server)
  .set({ mesh: { ...mesh, enabled: false, state: "starting" } })
  .where(eq(schema.server.id, serverB));
const { syncMesh } = await import("@/server/mesh");
await syncMesh();
const gone = trySh(hostB, "ip link show serve-mesh").ok === false && sh(hostB, "docker ps -aq --filter label=serve.kind=mesh-link | wc -l") === "0";
check("leaving removes the interface and the links", gone);
const [afterLeave] = await db.select({ mesh: schema.server.mesh }).from(schema.server).where(eq(schema.server.id, serverB));
check("the server reports it left", afterLeave.mesh?.state === "off", afterLeave.mesh?.state);
check("leaving frees the server's slot", (await db.select({ i: schema.server.meshIndex }).from(schema.server).where(eq(schema.server.id, serverB)))[0].i === null);
// Joining again takes a free slot, as saveMesh does.
const used = new Set((await db.select({ i: schema.server.meshIndex }).from(schema.server)).map((r) => r.i));
let slot = 1;
while (used.has(slot)) slot++;
await db
  .update(schema.server)
  .set({ meshIndex: slot, mesh: { ...mesh, enabled: true, state: "starting", configHash: null } })
  .where(eq(schema.server.id, serverB));
await syncMesh();
let again = false;
for (let i = 0; i < 30 && !again; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  again = trySh(hostB, `docker exec ${clientName} sh -c 'psql "$DATABASE_URL" -tAc "select 1"'`).out === "1";
}
check("after joining again the client reaches postgres without a redeploy", again);

const [{ n }] = await sql`select count(*)::int as n from mesh_address where environment_id = ${envId} or service_id in (${pg}, ${api}, ${client}, ${stack})`;
console.log(`addresses in use for this project: ${n}`);
console.log(`project: /projects/${projectId}`);
const failedChecks = results.filter(([, ok]) => !ok);
console.log(failedChecks.length ? `${failedChecks.length} check(s) failed` : "all checks passed");
await sql.end();
process.exit(failedChecks.length ? 1 : 0);
