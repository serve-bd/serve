// Third server: a service on it reaches postgres and the API of the latest mesh-deploy project,
// which run on two other servers.
//   set -a; source .env; source .env.e2e; set +a; npx tsx scripts/e2e/mesh-third.mts <serverC> <containerC>
import { execFileSync } from "node:child_process";
import { and, desc, eq, like } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { newWebhookSecret, queueDeployment, uniqueServiceSlug } from "@/server/services/create";
import { defaultRuntime } from "@/server/services/types";

const [serverC, hostC] = process.argv.slice(2);
const sh = (cmd: string) => execFileSync("docker", ["exec", hostC, "sh", "-c", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const [project] = await db.select().from(schema.project).where(like(schema.project.name, "mesh-%")).orderBy(desc(schema.project.createdAt)).limit(1);
const [env] = await db
  .select()
  .from(schema.environment)
  .where(and(eq(schema.environment.projectId, project.id), eq(schema.environment.name, "production")));
const id = newId();
await db.insert(schema.service).values({
  id,
  projectId: project.id,
  environmentId: env.id,
  serverId: serverC,
  name: process.env.NAME ?? "third",
  slug: await uniqueServiceSlug(process.env.NAME ?? "third"),
  type: "app",
  source: { type: "image", image: "postgres:17-alpine" },
  runtime: { ...defaultRuntime(5432), command: "while true; do nc -l -p 5432 >/dev/null 2>&1; done" },
  webhookSecret: newWebhookSecret(),
});
for (const [key, value] of Object.entries({ DATABASE_URL: "${{postgres.DATABASE_URL}}", API: "http://${{api.SERVE_PRIVATE_DOMAIN}}" }))
  await db.insert(schema.envVar).values({ id: newId(), serviceId: id, key, value: encrypt(value) });
const dep = await queueDeployment(id, "manual");
let status = "queued";
for (let i = 0; i < 120 && ["queued", "building", "deploying"].includes(status); i++) {
  await new Promise((r) => setTimeout(r, 1500));
  status = (await db.select({ s: schema.deployment.status }).from(schema.deployment).where(eq(schema.deployment.id, dep)))[0].s;
}
console.log("third on C:", status);
const name = sh(`docker ps --filter label=serve.service=${id} --format '{{.Names}}' | head -1`);
const q = sh(`docker exec ${name} sh -c 'psql "$DATABASE_URL" -tAc "select 1+1"' || true`);
console.log(q === "2" ? "PASS" : "FAIL", "C queries postgres on A:", q);
const a = sh(`docker exec ${name} sh -c 'wget -qO- -T 3 "$API" | grep Hostname' || true`);
console.log(a ? "PASS" : "FAIL", "C reaches the API on B:", a);
await sql.end();
process.exit(q === "2" && a ? 0 : 1);
