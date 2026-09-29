// Database settings end to end: custom config, init scripts, TLS, health check timing,
// storage mounts, password change, backup, import + restore (postgres and redis).
// Usage: set -a; source .env; source .env.e2e; set +a
//        npx tsx --tsconfig tsconfig.json scripts/e2e/database-options.mts [postgres redis mysql]
import fs from "node:fs";
import { execSync } from "node:child_process";
import { eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "@/server/db";
import { encrypt, decrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { defaultRuntime, type DatabaseConfig, type DbEngine } from "@/server/services/types";
import { newWebhookSecret, uniqueServiceSlug } from "@/server/services/create";
import { deployDatabase } from "@/server/deploy";
import { backupFile, importBackup, runBackup } from "@/server/backups";
import { changePasswordCommand } from "@/server/databases/password";
import { databaseCreds } from "@/server/databases/options";
import { engines } from "@/server/databases/engines";

const which = (process.argv.slice(2).length ? process.argv.slice(2) : ["postgres", "redis"]) as DbEngine[];
const results: string[] = [];
const ok = (cond: boolean, label: string, detail = "") => {
  results.push(`${cond ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
  console.log(results.at(-1));
};
const sh = (cmd: string) => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch (e) {
    return `${String((e as { stdout?: Buffer }).stdout ?? "")}${String((e as { stderr?: Buffer }).stderr ?? "")}`.trim();
  }
};
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const exec = (slug: string, cmd: string) => sh(`docker exec ${slug} sh -c ${q(cmd)}`);
const inspect = (slug: string) => JSON.parse(sh(`docker inspect ${slug}`))[0];

const [env] = await db.select().from(schema.environment).limit(1);
const created: string[] = [];

async function makeDb(engine: DbEngine, extra: Partial<DatabaseConfig>, runtime: Partial<ReturnType<typeof defaultRuntime>> = {}) {
  const e = engines[engine];
  const id = newId();
  const name = `dbopt-${engine}-${Date.now().toString(36)}`;
  await db.insert(schema.service).values({
    id,
    projectId: env.projectId,
    environmentId: env.id,
    serverId: "local",
    name,
    slug: await uniqueServiceSlug(name),
    type: "database",
    runtime: { ...defaultRuntime(e.port), restartPolicy: "unless-stopped", ...runtime },
    database: {
      engine,
      version: e.defaultVersion,
      username: e.defaultUser,
      password: encrypt("initial-password-123"),
      database: e.defaultDatabase,
      publicPort: null,
      backupSchedule: null,
      backupRetention: 7,
      s3DestinationId: null,
      ...extra,
    },
    webhookSecret: newWebhookSecret(),
  });
  created.push(id);
  return load(id);
}
const load = async (id: string) => (await db.select().from(schema.service).where(eq(schema.service.id, id)))[0];

async function changePassword(id: string, next: string) {
  const s = await load(id);
  const cfg = s.database!;
  const cmd = changePasswordCommand(cfg, databaseCreds(cfg, decrypt(cfg.password)), next);
  const out = cmd ? exec(s.slug, `${cmd}; echo EXIT=$?`) : "EXIT=0";
  await db
    .update(schema.service)
    .set({ database: { ...cfg, password: encrypt(next) } })
    .where(eq(schema.service.id, id));
  await deployDatabase(await load(id), null);
  return out;
}

async function backupNow(id: string) {
  const bid = newId();
  await db.insert(schema.backup).values({ id: bid, serviceId: id, trigger: "manual" });
  await runBackup(bid);
  return (await db.select().from(schema.backup).where(eq(schema.backup.id, bid)))[0];
}

async function importFile(id: string, localPath: string, name: string, backupFirst = true) {
  const s = await load(id);
  const filename = `${s.slug}-import-${name}`;
  fs.mkdirSync(backupFile(id, "x").replace(/\/x$/, ""), { recursive: true });
  fs.copyFileSync(localPath, backupFile(id, filename));
  const bid = newId();
  await db.insert(schema.backup).values({ id: bid, serviceId: id, trigger: "import", status: "running", filename });
  await importBackup(bid, { backupFirst });
  return (await db.select().from(schema.backup).where(eq(schema.backup.id, bid)))[0];
}

try {
  if (which.includes("postgres")) {
    const s = await makeDb(
      "postgres",
      {
        customConfig: "max_connections = 57\nwork_mem = 8MB",
        extraArgs: "-c log_statement=ddl",
        initdbArgs: "--data-checksums",
        initScripts: [{ name: "01-init.sql", content: "CREATE TABLE serve_init(id int); INSERT INTO serve_init VALUES (1);" }],
        tls: { enabled: true, mode: "require" },
        healthcheck: { interval: 2, retries: 20 },
      },
      {
        shmSize: 256,
        labels: [{ key: "com.example.team", value: "db" }],
        volumes: [
          { kind: "file", source: "hello.txt", mountPath: "/etc/serve-hello.txt", content: "hello from serve", readOnly: true },
          { kind: "volume", source: "extra", mountPath: "/extra" },
        ],
      },
    );
    await deployDatabase(s, null);
    const info = inspect(s.slug);
    ok(info.HostConfig.ShmSize === 256 * 1024 * 1024, "postgres: shm size applied", String(info.HostConfig.ShmSize));
    ok(info.Config.Healthcheck?.Interval === 2e9 && info.Config.Healthcheck?.Retries === 20, "postgres: health check timing applied");
    ok(info.Config.Labels["com.example.team"] === "db", "postgres: container label applied");
    ok(
      info.HostConfig.Binds.some((b: string) => b.endsWith(":/etc/serve-hello.txt:ro")) && info.HostConfig.Binds.some((b: string) => b.includes("-extra:/extra")),
      "postgres: file and extra volume mounted",
    );
    ok(exec(s.slug, "cat /etc/serve-hello.txt") === "hello from serve", "postgres: file mount content");
    // The container's own network address: loopback is "trust" in the postgres image, this uses the password.
    const ip = exec(s.slug, "hostname -i").split(/\s+/)[0];
    const psql = (sqlText: string, pw = "initial-password-123") => exec(s.slug, `PGPASSWORD=${pw} psql -h ${ip} -U postgres -d app -Atc ${q(sqlText)}`);
    ok(psql("SHOW max_connections") === "57", "postgres: custom config (SHOW max_connections)", psql("SHOW max_connections"));
    ok(psql("SHOW log_statement") === "ddl", "postgres: extra args (log_statement)");
    ok(psql("SHOW data_checksums") === "on", "postgres: initdb args (data_checksums)");
    ok(psql("SELECT count(*) FROM serve_init") === "1", "postgres: init script ran on fresh volume");
    ok(psql("SHOW ssl") === "on", "postgres: ssl on");
    const tls = exec(
      s.slug,
      `PGPASSWORD=initial-password-123 psql "host=${ip} user=postgres dbname=app sslmode=require" -Atc "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"`,
    );
    ok(tls === "t", "postgres: sslmode=require connection uses TLS", tls);
    ok(fs.existsSync(`${process.env.SERVE_DATA_DIR}/services/${s.id}/tls/ca.crt`), "postgres: CA stored in service dir");

    const out = await changePassword(s.id, "new-password-456");
    ok(out.includes("EXIT=0"), "postgres: password changed inside the database", out.slice(-80));
    ok(psql("SELECT 1", "new-password-456") === "1", "postgres: new password works after restart");
    ok(!psql("SELECT 1", "initial-password-123").startsWith("1"), "postgres: old password rejected");

    psql("CREATE TABLE before_backup(x int); INSERT INTO before_backup VALUES (42)", "new-password-456");
    const b = await backupNow(s.id);
    ok(b.status === "success" && !!b.size, "postgres: backup", `${b.filename} ${b.size}`);
    fs.writeFileSync("/tmp/claude-1000/dbopt-import.sql", "CREATE TABLE imported_plain(x int); INSERT INTO imported_plain VALUES (7);\n");
    const plain = await importFile(s.id, "/tmp/claude-1000/dbopt-import.sql", "plain.sql");
    ok(plain.restoreStatus === "success", "postgres: plain .sql import restored", plain.log?.split("\n").slice(-3).join(" | "));
    ok(psql("SELECT x FROM imported_plain", "new-password-456") === "7", "postgres: imported table present");
    const pre = await db.select().from(schema.backup).where(eq(schema.backup.serviceId, s.id));
    ok(
      pre.some((r) => r.trigger === "pre-import" && r.status === "success"),
      "postgres: safety backup taken before import",
    );
    sh(`gzip -kf /tmp/claude-1000/dbopt-import.sql && mv /tmp/claude-1000/dbopt-import.sql.gz /tmp/claude-1000/dbopt-import2.sql.gz`);
    psql("DROP TABLE imported_plain", "new-password-456");
    const gz = await importFile(s.id, "/tmp/claude-1000/dbopt-import2.sql.gz", "plain.sql.gz", false);
    ok(gz.restoreStatus === "success" && psql("SELECT x FROM imported_plain", "new-password-456") === "7", "postgres: .sql.gz import restored");
    psql("DROP TABLE before_backup", "new-password-456");
    const custom = await importFile(s.id, backupFile(s.id, b.filename!), "custom.dump", false);
    ok(custom.restoreStatus === "success" && psql("SELECT x FROM before_backup", "new-password-456") === "42", "postgres: pg_dump custom format import restored");
  }

  if (which.includes("redis")) {
    const s = await makeDb("redis", { customConfig: "maxmemory 64mb\nmaxmemory-policy allkeys-lru", tls: { enabled: true } });
    await deployDatabase(s, null);
    const cli = (pw: string, args: string) => exec(s.slug, `redis-cli --tls --insecure -a ${pw} --no-auth-warning ${args}`);
    ok(cli("initial-password-123", "CONFIG GET maxmemory").split("\n")[1] === "67108864", "redis: custom config (maxmemory)");
    ok(exec(s.slug, "redis-cli -a initial-password-123 --no-auth-warning ping").toUpperCase() !== "PONG", "redis: plain connection refused with TLS on");
    ok(cli("initial-password-123", "ping") === "PONG", "redis: TLS connection works");
    const out = await changePassword(s.id, "new-redis-pass-789");
    ok(out.includes("EXIT=0"), "redis: password changed live", out.slice(-60));
    ok(cli("new-redis-pass-789", "ping") === "PONG", "redis: new password works after restart");
    cli("new-redis-pass-789", "SET serve:key restored-value");
    const b = await backupNow(s.id);
    ok(b.status === "success", "redis: backup over TLS", `${b.size}`);
    cli("new-redis-pass-789", "DEL serve:key");
    const r = await importFile(s.id, backupFile(s.id, b.filename!), "dump.rdb", false);
    await new Promise((res) => setTimeout(res, 3000));
    ok(
      r.restoreStatus === "success" && cli("new-redis-pass-789", "GET serve:key") === "restored-value",
      "redis: .rdb import restored",
      `${r.restoreStatus} ${cli("new-redis-pass-789", "GET serve:key")} ${r.log?.split("\n").slice(-4).join(" | ")} ${sh(`docker logs --tail 8 ${s.slug} 2>&1`).split("\n").join(" | ")}`,
    );
  }

  if (which.includes("mysql")) {
    const s = await makeDb("mysql", { customConfig: "max_connections = 123", charset: "utf8mb4", collation: "utf8mb4_unicode_ci", tls: { enabled: true, mode: "require" } });
    await deployDatabase(s, null);
    const my = (pw: string, sqlText: string) => exec(s.slug, `MYSQL_PWD=${pw} mysql -uroot -N -e ${q(sqlText)}`);
    ok(my("initial-password-123", "SELECT @@max_connections") === "123", "mysql: custom config");
    ok(my("initial-password-123", "SELECT @@collation_server") === "utf8mb4_unicode_ci", "mysql: collation");
    ok(my("initial-password-123", "SELECT @@require_secure_transport") === "1", "mysql: TLS required");
    const out = await changePassword(s.id, "new-mysql-pass-321");
    ok(out.includes("EXIT=0") && my("new-mysql-pass-321", "SELECT 1") === "1", "mysql: password change");
  }
  if (which.includes("mongodb")) {
    const s = await makeDb("mongodb", {
      customConfig: "operationProfiling:\n  slowOpThresholdMs: 321",
      tls: { enabled: true, mode: "require" },
      initScripts: [{ name: "01-init.js", content: 'db.getSiblingDB("app").seeded.insertOne({ ok: 1 });' }],
    });
    await deployDatabase(s, null);
    const mongo = (pw: string, js: string) =>
      exec(s.slug, `mongosh --quiet --tls --tlsAllowInvalidCertificates -u root -p ${pw} --authenticationDatabase admin app --eval ${q(js)}`);
    ok(mongo("initial-password-123", "db.getProfilingStatus().slowms") === "321", "mongodb: custom config (slowms)");
    ok(mongo("initial-password-123", "db.seeded.countDocuments()") === "1", "mongodb: init script ran");
    ok(
      !exec(s.slug, `mongosh --quiet -u root -p initial-password-123 --authenticationDatabase admin --eval 1`).trim().endsWith("1"),
      "mongodb: plain connection refused with TLS required",
    );
    const out = await changePassword(s.id, "new-mongo-pass-654");
    ok(out.includes("EXIT=0") && mongo("new-mongo-pass-654", "1") === "1", "mongodb: password change");
    const b = await backupNow(s.id);
    mongo("new-mongo-pass-654", "db.seeded.drop()");
    const r = await importFile(s.id, backupFile(s.id, b.filename!), "dump.archive.gz", false);
    ok(r.restoreStatus === "success" && mongo("new-mongo-pass-654", "db.seeded.countDocuments()") === "1", "mongodb: archive import restored");
  }
} catch (e) {
  ok(false, "unexpected error", (e as Error).stack?.split("\n").slice(0, 4).join(" | ") ?? String(e));
} finally {
  if (!process.env.KEEP) {
    const rows = await db.select().from(schema.service).where(inArray(schema.service.id, created));
    for (const r of rows) {
      sh(`docker rm -f ${r.slug}`);
      sh(`docker volume rm serve-${r.slug}-data serve-${r.slug}-extra`);
      fs.rmSync(`${process.env.SERVE_DATA_DIR}/services/${r.id}`, { recursive: true, force: true });
      fs.rmSync(`${process.env.SERVE_DATA_DIR}/backups/${r.id}`, { recursive: true, force: true });
    }
    if (created.length) await db.delete(schema.service).where(inArray(schema.service.id, created));
  }
  console.log(`\n${results.filter((r) => r.startsWith("✓")).length}/${results.length} passed`);
  await sql.end();
}
