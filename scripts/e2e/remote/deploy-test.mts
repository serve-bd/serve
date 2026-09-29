// Deploy pipeline on a remote server (the fake remote from run.sh) and locally.
// Needs the e2e worker running. Usage:
//   set -a; source .env; source .env.e2e; set +a
//   npx tsx --tsconfig tsconfig.json scripts/e2e/remote/deploy-test.mts [image|git|db|compose|control|move|ports|local]...
import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { encrypt, randomPassword } from "@/server/crypto";
import { newId } from "@/server/id";
import { enqueue } from "@/server/queue";
import { defaultBuild, defaultRuntime } from "@/server/services/types";
import { newWebhookSecret, queueDeployment, uniqueServiceSlug } from "@/server/services/create";
import { teardownServices } from "@/server/services/teardown";
import { getTemplate } from "@/server/services/templates";
import { resolveEnv } from "@/server/services/variables";
import { publishedPorts } from "@/server/services/ports";

const REMOTE = process.env.REMOTE_SERVER ?? "e2eremote";
const [probe] = await db.select().from(schema.service).where(eq(schema.service.id, "ig64w8k4towadiky"));
const projectId = probe.projectId;
const environmentId = probe.environmentId;
const created: string[] = [];
const results: string[] = [];

function remoteDocker(args: string) {
  return execSync(`docker exec serve-e2e-remote docker ${args}`).toString().trim();
}

async function make(values: Partial<typeof schema.service.$inferInsert> & { name: string; type: "app" | "database" | "compose" }) {
  const id = newId();
  await db.insert(schema.service).values({
    id,
    projectId,
    environmentId,
    slug: await uniqueServiceSlug(values.name),
    runtime: defaultRuntime(null),
    webhookSecret: newWebhookSecret(),
    ...values,
  });
  created.push(id);
  return id;
}

async function deploy(serviceId: string, label: string, timeoutMs = 600_000) {
  const depId = await queueDeployment(serviceId, "manual");
  const end = Date.now() + timeoutMs;
  for (;;) {
    const [d] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, depId));
    if (["success", "failed", "cancelled", "superseded"].includes(d.status)) {
      const ok = d.status === "success";
      results.push(`${ok ? "✓" : "✗"} ${label}: ${d.status}`);
      if (!ok) console.log(`--- ${label} log tail ---\n${d.logs.split("\n").slice(-25).join("\n")}\n${d.error ?? ""}`);
      return ok;
    }
    if (Date.now() > end) {
      results.push(`✗ ${label}: timed out (${d.status})`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function waitJobIdle(serviceId: string, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const jobs = await sql`select count(*)::int as n from job where status in ('pending','running') and concurrency_key = ${`service:${serviceId}`}`;
    if (jobs[0].n === 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function status(serviceId: string) {
  const [s] = await db.select({ status: schema.service.status }).from(schema.service).where(eq(schema.service.id, serviceId));
  return s?.status;
}

const steps = process.argv.slice(2).length ? process.argv.slice(2) : ["image", "git", "db", "compose", "control", "move", "ports", "local"];
let whoami: string | null = null;

try {
  if (steps.includes("image") || steps.includes("control") || steps.includes("move")) {
    whoami = await make({ name: "rt whoami", type: "app", serverId: REMOTE, source: { type: "image", image: "traefik/whoami", registryUsername: null, registryPassword: null }, runtime: defaultRuntime(80) });
    if (await deploy(whoami, "image on remote")) {
      const ps = remoteDocker(`ps --filter label=serve.service=${whoami} --format '{{.Names}} {{.Status}}'`);
      results.push(`${ps ? "✓" : "✗"} remote container: ${ps || "none"}`);
      const local = execSync(`docker ps -q --filter label=serve.service=${whoami}`).toString().trim();
      results.push(`${local ? "✗" : "✓"} nothing on local docker`);
    }
  }

  if (steps.includes("git")) {
    const id = await make({
      name: "rt node",
      type: "app",
      serverId: REMOTE,
      source: { type: "git", repository: "https://github.com/heroku/node-js-getting-started.git", branch: "main", credentialId: null },
      build: defaultBuild(),
    });
    if (await deploy(id, "git auto build on remote", 900_000)) {
      const img = remoteDocker(`images --filter reference='serve/*' --format '{{.Repository}}:{{.Tag}}'`);
      results.push(`${img.includes("rt-node") ? "✓" : "✗"} built image lives on remote`);
    }
  }

  if (steps.includes("db")) {
    const id = await make({
      name: "rt pg",
      type: "database",
      serverId: REMOTE,
      runtime: { ...defaultRuntime(5432), restartPolicy: "unless-stopped" },
      database: { engine: "postgres", version: "17", username: "app", password: encrypt(randomPassword()), database: "app", publicPort: null, backupSchedule: null, backupRetention: 7, s3DestinationId: null },
    });
    if (await deploy(id, "postgres on remote", 300_000)) {
      const [svc] = await db.select().from(schema.service).where(eq(schema.service.id, id));
      const out = remoteDocker(`exec ${svc.slug} psql -U app -d app -tAc 'select 40+2'`);
      results.push(`${out === "42" ? "✓" : "✗"} psql on remote db: ${out}`);
      const vol = remoteDocker(`volume ls --format '{{.Name}}'`);
      results.push(`${vol.includes(`serve-${svc.slug}-data`) ? "✓" : "✗"} data volume on remote`);
      // A local service referencing the remote db's private URL gets a warning.
      const ref = await make({ name: "rt ref", type: "app", source: { type: "image", image: "traefik/whoami", registryUsername: null, registryPassword: null } });
      await db.insert(schema.envVar).values({ id: newId(), serviceId: ref, key: "DB", value: encrypt(`\${{${svc.slug}.DATABASE_URL}}`), buildTime: false, runtime: true });
      const [refRow] = await db.select().from(schema.service).where(eq(schema.service.id, ref));
      const env = await resolveEnv(refRow);
      results.push(`${env.missing.some((m) => m.includes("another server")) ? "✓" : "✗"} cross-server reference flagged: ${env.missing.join("; ")}`);
    }
  }

  if (steps.includes("compose")) {
    const t = getTemplate("uptime-kuma")!;
    const id = await make({ name: "rt kuma", type: "compose", serverId: REMOTE, icon: t.id, compose: { mode: "inline", content: t.compose, path: "docker-compose.yml", template: t.id } });
    if (await deploy(id, "compose template on remote", 600_000)) {
      const ps = remoteDocker(`ps --filter label=serve.service=${id} --format '{{.Names}} {{.Status}}'`);
      results.push(`${ps.includes("Up") ? "✓" : "✗"} compose containers on remote: ${ps.replace(/\n/g, ", ")}`);
    }
  }

  if (whoami && steps.includes("control")) {
    for (const cmd of ["stop", "start", "restart"] as const) {
      await enqueue(`service.${cmd}`, { serviceId: whoami }, { concurrencyKey: `service:${whoami}` });
      await waitJobIdle(whoami);
      const running = remoteDocker(`ps -q --filter label=serve.service=${whoami}`);
      const expect = cmd === "stop" ? !running : !!running;
      results.push(`${expect ? "✓" : "✗"} ${cmd} on remote (status ${await status(whoami)})`);
    }
  }

  if (whoami && steps.includes("move")) {
    // Same jobs moveService() queues: remove on the old server, switch, deploy.
    const move = async (to: string, from: string) => {
      const [s] = await db.select().from(schema.service).where(eq(schema.service.id, whoami!));
      await enqueue("service.delete", { serviceId: s.id, slug: s.slug, type: s.type, removeVolumes: false, environmentId: s.environmentId, serverId: from, keepFiles: true }, { concurrencyKey: `service:${s.id}` });
      await db.update(schema.service).set({ serverId: to }).where(eq(schema.service.id, s.id));
      return deploy(s.id, `move ${from} → ${to}`);
    };
    if (await move("local", REMOTE)) {
      const remoteLeft = remoteDocker(`ps -aq --filter label=serve.service=${whoami}`);
      const localNow = execSync(`docker ps -q --filter label=serve.service=${whoami}`).toString().trim();
      results.push(`${!remoteLeft && localNow ? "✓" : "✗"} moved to local (remote left: ${remoteLeft ? "yes" : "no"})`);
    }
    if (await move(REMOTE, "local")) {
      const localLeft = execSync(`docker ps -aq --filter label=serve.service=${whoami}`).toString().trim();
      const remoteNow = remoteDocker(`ps -q --filter label=serve.service=${whoami}`);
      results.push(`${!localLeft && remoteNow ? "✓" : "✗"} moved back to remote`);
    }
  }

  if (steps.includes("ports")) {
    const id = await make({
      name: "rt ports",
      type: "app",
      source: { type: "image", image: "traefik/whoami", registryUsername: null, registryPassword: null },
      runtime: { ...defaultRuntime(80), ports: [{ host: 18080, container: 80, protocol: "tcp", bindAddress: "127.0.0.1" }] },
    });
    if (await deploy(id, "local app with 127.0.0.1:18080")) {
      const cid = execSync(`docker ps -q --filter label=serve.service=${id}`).toString().trim();
      const port = execSync(`docker port ${cid} 80/tcp`).toString().trim();
      results.push(`${port === "127.0.0.1:18080" ? "✓" : "✗"} docker port: ${port}`);
      const body = execSync("curl -s --max-time 5 localhost:18080 | head -1").toString().trim();
      results.push(`${body.startsWith("Hostname") ? "✓" : "✗"} curl localhost:18080: ${body}`);
      const [svc] = await db.select().from(schema.service).where(eq(schema.service.id, id));
      results.push(`✓ publishedPorts: ${(await publishedPorts(svc)).map((p) => p.label).join(", ")}`);
    }
  }

  if (steps.includes("local")) {
    const id = await make({ name: "rt local", type: "app", source: { type: "image", image: "traefik/whoami", registryUsername: null, registryPassword: null }, runtime: defaultRuntime(80) });
    await deploy(id, "local image deploy (regression)");
  }
} finally {
  if (!process.env.KEEP) {
    const rows = await db.select().from(schema.service);
    await teardownServices(rows.filter((r) => created.includes(r.id)), true);
    for (const id of created) await waitJobIdle(id, 120_000);
    const leftRemote = created.map((id) => remoteDocker(`ps -aq --filter label=serve.service=${id}`)).join("");
    results.push(`${leftRemote ? "✗" : "✓"} cleanup removed remote containers`);
  }
  console.log("\n" + results.join("\n"));
  await sql.end();
  process.exit(0);
}
