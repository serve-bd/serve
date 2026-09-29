// Exercises the multi-server core against the fake remote server.
// Usage: set -a; source .env.e2e; set +a; npx tsx scripts/e2e/remote/core-test.mts
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { generateKeyPair } from "@/server/servers/keys";
import { getServer, forgetServer } from "@/server/servers/context";
import { setupServer } from "@/server/servers/setup";
import { run } from "@/server/process";

const id = "e2eremote";
// Reuse a running fake server and its key; other tests may be using it. RESET=1 starts from scratch.
const running = execFileSync("docker", ["ps", "-q", "--filter", "name=^serve-e2e-remote$"]).toString().trim();
const [existingKey] = await db.select().from(schema.privateKey).where(eq(schema.privateKey.id, id));
if (process.env.RESET || !running || !existingKey) {
  const key = generateKeyPair("serve-e2e");
  execFileSync("scripts/e2e/remote/run.sh", [key.publicKey], { stdio: "inherit" });
  const keyRow = { publicKey: key.publicKey, privateKey: encrypt(key.privateKey), fingerprint: key.fingerprint };
  await db
    .insert(schema.privateKey)
    .values({ id, name: "e2e", ...keyRow })
    .onConflictDoUpdate({ target: schema.privateKey.id, set: keyRow });
  // Inside the fake server the proxy listens on 80/443; the host maps them to 8090/8453.
  const serverRow = { name: "e2e-remote", host: "127.0.0.1", port: 2222, privateKeyId: id, hostKey: null, proxyHttpPort: 80, proxyHttpsPort: 443 };
  await db
    .insert(schema.server)
    .values({ id, ...serverRow })
    .onConflictDoUpdate({ target: schema.server.id, set: serverRow });
}
forgetServer(id);

const t0 = Date.now();
try {
  await setupServer(id);
} catch (e) {
  console.log("setup ended with:", (e as Error).message);
}
const [row] = await db.select().from(schema.server).where(eq(schema.server.id, id));
console.log("status:", row.status, "| hostKey pinned:", !!row.hostKey, "| info:", JSON.stringify(row.info), `| ${Date.now() - t0}ms`);
console.log(row.setupLog);

const ctx = await getServer(id);
let t = Date.now();
const containers = await ctx.docker.listContainers({ all: true });
console.log(`docker api: ${containers.length} containers (${Date.now() - t}ms)`);
t = Date.now();
for (let i = 0; i < 5; i++) await ctx.docker.ping();
console.log(`5 pings: ${Date.now() - t}ms`);

await ctx.fs.writeFile("/data/serve/test/hello.txt", "hi there");
console.log("fs read:", await ctx.fs.readFile("/data/serve/test/hello.txt"), "| exists:", await ctx.fs.exists("/data/serve/test/hello.txt"));
console.log("fs changed:", await ctx.fs.writeIfChanged("/data/serve/test/hello.txt", "hi there"));
await ctx.fs.uploadDir("scripts/e2e/remote", "/data/serve/test/upload");
console.log("upload:", (await ctx.fs.readdir("/data/serve/test/upload")).sort().join(","));
const tail = await ctx.fs.readFrom("/data/serve/test/hello.txt", 3, 100);
console.log("readFrom:", tail.toString());
await ctx.fs.rm("/data/serve/test");

const env = await ctx.cliEnv();
t = Date.now();
const out = await run("docker", ["version", "--format", "{{.Server.Version}}"], { env });
console.log(`docker cli over ssh: ${out.trim()} (${Date.now() - t}ms)`);

// Container exec + logs over the SSH agent (hijacked streams).
await ctx.docker.pull("alpine:3.22").then((s) => new Promise((r) => ctx.docker.modem.followProgress(s, r)));
const c = await ctx.docker.createContainer({ Image: "alpine:3.22", Cmd: ["sh", "-c", "echo started; sleep 60"], name: "serve-core-test" });
await c.start();
const exec = await c.exec({ Cmd: ["sh", "-c", "echo from-exec $((2+3))"], AttachStdout: true, AttachStderr: true });
const stream = await exec.start({ hijack: true, stdin: false });
let text = "";
await new Promise<void>((resolve) => {
  stream.on("data", (d: Buffer) => (text += d.toString()));
  stream.on("end", resolve);
});
console.log("exec output:", JSON.stringify(text.replace(/[\x00-\x08]/g, "").trim()));
const logs = await c.logs({ stdout: true, stderr: true });
console.log(
  "logs:",
  JSON.stringify(
    logs
      .toString()
      .replace(/[\x00-\x08]/g, "")
      .trim(),
  ),
);
await c.remove({ force: true });

await sql.end();
process.exit(0);
