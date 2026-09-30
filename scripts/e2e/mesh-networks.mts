// Several private networks, live on four servers. A and B share "front"; B and C share "back";
// D is joined but in no network. B talks to everyone, A and C never talk, D talks to nobody.
// Then C joins "front" (reaches A), leaves it again (loses A), and "back" is deleted.
//   set -a; source .env; source .env.e2e; set +a
//   npx tsx scripts/e2e/mesh-networks.mts <serverA> <serverB> <serverC> <serverD> <hostA> <hostB> <hostC> <hostD>
import { execFileSync } from "node:child_process";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { syncMesh } from "@/server/mesh";
import { resolveEnv } from "@/server/services/variables";
import { newWebhookSecret, queueDeployment, uniqueServiceSlug } from "@/server/services/create";
import { defaultRuntime } from "@/server/services/types";

const args = process.argv.slice(2);
if (args.length !== 8) throw new Error("usage: mesh-networks.mts <A> <B> <C> <D> <hostA> <hostB> <hostC> <hostD>");
const [A, B, C, D] = args.slice(0, 4);
const host: Record<string, string> = { [A]: args[4], [B]: args[5], [C]: args[6], [D]: args[7] };
const names: Record<string, string> = { [A]: "A", [B]: "B", [C]: "C", [D]: "D" };

const sh = (h: string, cmd: string) => execFileSync("docker", ["exec", h, "sh", "-c", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const trySh = (h: string, cmd: string) => {
  try {
    return { ok: true, out: sh(h, cmd) };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: string }).stderr ?? e).trim() };
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------- networks
const servers = await db
  .select()
  .from(schema.server)
  .where(inArray(schema.server.id, [A, B, C, D]));
for (const s of servers) if (!s.mesh?.enabled) throw new Error(`${s.name} has not joined the private network`);
const keyOf = new Map(servers.map((s) => [s.mesh!.publicKey, s.id]));
const tag = Date.now().toString(36).slice(-4);
const front = newId();
const back = newId();
await db.delete(schema.privateNetworkMember).where(inArray(schema.privateNetworkMember.serverId, [A, B, C, D]));
await db.insert(schema.privateNetwork).values([
  { id: front, name: `front-${tag}` },
  { id: back, name: `back-${tag}` },
]);
await db.insert(schema.privateNetworkMember).values([
  { networkId: front, serverId: A },
  { networkId: front, serverId: B },
  { networkId: back, serverId: B },
  { networkId: back, serverId: C },
]);

/** WireGuard peers on a server, as server letters. */
function peersOn(id: string) {
  const out = trySh(host[id], "docker exec serve-mesh wg show serve-mesh peers");
  if (!out.ok) return `error: ${out.out}`;
  return out.out
    .split("\n")
    .filter(Boolean)
    .map((k) => names[keyOf.get(k) ?? ""] ?? "?")
    .sort()
    .join(",");
}

async function settle(expect: Record<string, string>, label: string) {
  await syncMesh();
  let seen: Record<string, string> = {};
  for (let i = 0; i < 20; i++) {
    seen = Object.fromEntries([A, B, C, D].map((id) => [names[id], peersOn(id)]));
    if (Object.entries(expect).every(([k, v]) => seen[k] === v)) break;
    await sleep(1000);
  }
  check(
    `${label}: WireGuard peers`,
    Object.entries(expect).every(([k, v]) => seen[k] === v),
    Object.entries(seen)
      .map(([k, v]) => `${k}→[${v}]`)
      .join(" "),
  );
}

await settle({ A: "B", B: "A,C", C: "B", D: "" }, "front {A,B} + back {B,C}");

// ---------------------------------------------------------------- services
const [root] = await db.select().from(schema.organization).limit(1);
const projectId = newId();
const envId = newId();
await db.insert(schema.project).values({ id: projectId, organizationId: root.id, name: `networks-${tag}` });
await db.insert(schema.environment).values({ id: envId, projectId, name: "production" });

async function service(values: Partial<typeof schema.service.$inferInsert> & { name: string; type: "app" | "database"; serverId: string }, env: Record<string, string> = {}) {
  const id = newId();
  await db
    .insert(schema.service)
    .values({ id, projectId, environmentId: envId, slug: await uniqueServiceSlug(values.name), runtime: defaultRuntime(), webhookSecret: newWebhookSecret(), ...values });
  for (const [key, value] of Object.entries(env)) await db.insert(schema.envVar).values({ id: newId(), serviceId: id, key, value: encrypt(value) });
  return id;
}

async function deploy(serviceId: string, label: string) {
  const dep = await queueDeployment(serviceId, "manual");
  for (let i = 0; i < 240; i++) {
    const [row] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, dep));
    if (row && !["queued", "building", "deploying"].includes(row.status)) {
      console.log(`${label}: ${row.status}`);
      if (row.status !== "success") {
        console.log(row.logs.split("\n").slice(-25).join("\n"));
        process.exit(1);
      }
      return row;
    }
    await sleep(1500);
  }
  throw new Error(`${label}: timed out`);
}

const tool = (serverId: string) => ({
  source: { type: "image" as const, image: "postgres:17-alpine" },
  runtime: { ...defaultRuntime(5432), command: "while true; do nc -l -p 5432 >/dev/null 2>&1; done" },
  serverId,
});
const pg = await service({
  name: "postgres",
  type: "database",
  serverId: A,
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
const onB = await service({ name: "client-b", type: "app", ...tool(B) }, { DATABASE_URL: "${{postgres.DATABASE_URL}}" });
const onC = await service({ name: "client-c", type: "app", ...tool(C) });
const onD = await service({ name: "client-d", type: "app", ...tool(D) });

await deploy(pg, "postgres on A");
await deploy(onB, "client on B");
await deploy(onC, "client on C");
await deploy(onD, "client on D");
await syncMesh();

const [pgRow] = await db.select().from(schema.service).where(eq(schema.service.id, pg));
const pgIp = (await db.select().from(schema.meshAddress).where(eq(schema.meshAddress.serviceId, pg)))[0]?.ip;
const container = (id: string, serviceId: string) => sh(host[id], `docker ps --filter label=serve.service=${serviceId} --format '{{.Names}}' | head -1`);
const cB = container(B, onB);
const cC = container(C, onC);
const cD = container(D, onD);
const pgUrl = (h: string) => `postgresql://app:s3cret-pass-123@${h}:5432/app`;
const query = (id: string, c: string, target: string) => trySh(host[id], `docker exec ${c} sh -c 'timeout 8 psql "${pgUrl(target)}" -tAc "select 40+2"'`);

async function reach(id: string, c: string, target: string, want: boolean) {
  let r = query(id, c, target);
  for (let i = 0; i < 10 && (r.ok && r.out === "42") !== want; i++) {
    await sleep(1500);
    r = query(id, c, target);
  }
  return r;
}

let r = await reach(B, cB, pgRow.slug, true);
check("B (shares front with A) queries postgres on A by name", r.ok && r.out === "42", r.out);
r = await reach(C, cC, pgRow.slug, false);
check("C (no network with A) cannot resolve postgres's name", !r.ok, r.out.split("\n").pop());
r = await reach(C, cC, pgIp, false);
check("C cannot reach postgres's private address either", !r.ok || r.out !== "42", r.out.split("\n").pop());
r = await reach(D, cD, pgIp, false);
check("D (in no network) cannot reach it", !r.ok || r.out !== "42", r.out.split("\n").pop());

const envC = await resolveEnv((await db.select().from(schema.service).where(eq(schema.service.id, onC)))[0]).catch((e) => ({ error: (e as Error).message }));
check("variables on C do not get postgres's private URL", !JSON.stringify(envC).includes(`@${pgRow.slug}:5432`));

// ---------------------------------------------------------------- C joins front
await db.insert(schema.privateNetworkMember).values({ networkId: front, serverId: C });
await settle({ A: "B,C", B: "A,C", C: "A,B" }, "C added to front");
r = await reach(C, cC, pgRow.slug, true);
check("C now queries postgres on A by name", r.ok && r.out === "42", r.out);

// ---------------------------------------------------------------- C leaves front
await db.delete(schema.privateNetworkMember).where(and(eq(schema.privateNetworkMember.networkId, front), eq(schema.privateNetworkMember.serverId, C)));
await settle({ A: "B", B: "A,C", C: "B" }, "C taken out of front");
r = await reach(C, cC, pgRow.slug, false);
check("C lost postgres again", !r.ok || r.out !== "42", r.out.split("\n").pop());
r = await reach(B, cB, pgRow.slug, true);
check("B still queries postgres", r.ok && r.out === "42", r.out);

// ---------------------------------------------------------------- delete back
await db.delete(schema.privateNetwork).where(eq(schema.privateNetwork.id, back));
await settle({ A: "B", B: "A", C: "", D: "" }, "back deleted");

// ---------------------------------------------------------------- clean up
for (const [id, s] of [
  [A, pg],
  [B, onB],
  [C, onC],
  [D, onD],
] as const)
  trySh(host[id], `docker ps -aq --filter label=serve.service=${s} | xargs -r docker rm -f >/dev/null`);
trySh(host[A], `docker volume ls -q | grep ${pgRow.slug} | xargs -r docker volume rm >/dev/null`);
await db.delete(schema.project).where(eq(schema.project.id, projectId));
await db.delete(schema.privateNetwork).where(eq(schema.privateNetwork.id, front));
// Back to one network for all four, as before the test.
const [def] = await db.select().from(schema.privateNetwork).where(eq(schema.privateNetwork.name, "Default"));
if (def)
  await db
    .insert(schema.privateNetworkMember)
    .values([A, B, C, D].map((serverId) => ({ networkId: def.id, serverId })))
    .onConflictDoNothing();
await syncMesh();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
