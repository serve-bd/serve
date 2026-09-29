// Operations on a remote server: host info, health, disk usage, resources, snapshot, cleanup.
// Usage: set -a; source .env; source .env.e2e; set +a; npx tsx scripts/e2e/remote/ops-test.mts [serverId]
import { sql } from "@/server/db";
import { getServer } from "@/server/servers/context";
import { hostInfo, serverHealth, dockerDiskUsage } from "@/server/system";
import { serverSnapshot } from "@/server/metrics";
import { listHostContainers, hostSummary } from "@/server/servers/resources";
import { runCleanup } from "@/server/cleanup";
import { getSettings } from "@/server/settings";

const id = process.argv[2] ?? "e2eremote";
const ctx = await getServer(id);
const t = Date.now();
const info = await hostInfo(ctx);
console.log("hostInfo:", JSON.stringify({ name: info.name, os: info.os, arch: info.arch, cpus: info.cpus, docker: info.docker, compose: info.compose, buildx: info.buildx, upSince: info.upSince }), `${Date.now() - t}ms`);
const health = await serverHealth(ctx, await getSettings());
console.log("health:", JSON.stringify(health));
const local = await serverHealth(await getSettings());
console.log("local health (1-arg form):", local.docker, local.proxy);
console.log("disk usage:", JSON.stringify(await dockerDiskUsage(ctx)));
const snap = await serverSnapshot(ctx);
console.log("snapshot:", JSON.stringify({ cpu: snap.cpu.toFixed(1), cores: snap.cores, mem: snap.memory, disk: snap.disk, load: snap.load, uptime: snap.uptime }));
const rows = await listHostContainers(ctx);
console.log("containers:", rows.map((r) => `${r.name}(${r.kind}${r.role ? ":" + r.role : ""})`).join(", "));
console.log("summary:", JSON.stringify(await hostSummary(ctx)));
const result = await runCleanup("manual", id);
console.log("cleanup:", JSON.stringify(result));
await sql.end();
process.exit(0);
