import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { ServerInfo, ServerStatus } from "@/server/db/schema";
import { ensureNetwork } from "@/server/docker/client";
import { forgetServer, getServer, getServerRow, LOCAL_SERVER_ID, sshTargetFor } from "./context";
import { connect, HostKeyMismatchError, sh, sshExec, type SshTarget } from "./ssh";

type Log = (line: string) => void;

async function setStatus(id: string, status: ServerStatus, message: string | null, extra: Partial<typeof schema.server.$inferInsert> = {}) {
  await db.update(schema.server).set({ status, statusMessage: message, ...extra }).where(eq(schema.server.id, id));
}

/** Buffers log lines and appends them to server.setup_log about once a second. */
function setupLogger(serverId: string) {
  let pending: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = async () => {
    timer = null;
    if (!pending.length) return;
    const text = pending.join("\n") + "\n";
    pending = [];
    await db
      .update(schema.server)
      .set({ setupLog: sql`right(${schema.server.setupLog} || ${text}, 200000)` })
      .where(eq(schema.server.id, serverId));
  };
  const log: Log = (line) => {
    pending.push(line);
    timer ??= setTimeout(() => void flush(), 800);
  };
  return { log, flush: async () => (timer && clearTimeout(timer), flush()) };
}

async function run(t: SshTarget, command: string, log: Log, opts: { sudo?: boolean; timeoutMs?: number; quiet?: boolean } = {}) {
  const cmd = opts.sudo && t.username !== "root" ? `sudo -n sh -c ${sh(command)}` : command;
  const r = await sshExec(t, cmd, { onLine: opts.quiet ? undefined : (l) => log(`  ${l}`), timeoutMs: opts.timeoutMs ?? 120_000 });
  return r;
}

const DAEMON_JSON = `{
  "default-address-pools": [{ "base": "10.200.0.0/12", "size": 24 }],
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}`;

/**
 * Validates SSH access and prepares a remote server: Docker (optionally
 * installed), the data directory, the shared network and the proxy.
 */
export async function setupServer(serverId: string, opts: { installDocker?: boolean } = {}) {
  const row = await getServerRow(serverId);
  if (row.isLocal) return;
  const { log, flush } = setupLogger(serverId);
  await db.update(schema.server).set({ setupLog: "", status: "validating", statusMessage: "Connecting" }).where(eq(schema.server.id, serverId));
  forgetServer(serverId);

  try {
    let target = await sshTargetFor(row);
    log(`==> Connecting to ${target.username}@${target.host}:${target.port}`);
    let presented: string | null = null;
    await connect(target, { onHostKey: (k) => (presented = k) });
    if (!row.hostKey && presented) {
      await db.update(schema.server).set({ hostKey: presented }).where(eq(schema.server.id, serverId));
      target = { ...target, hostKey: presented };
      log(`Pinned host key ${String(presented).split(" ")[0]}`);
    }
    log("Connected");

    const whoami = (await run(target, "id -u", log, { quiet: true })).stdout.trim();
    if (whoami !== "0") {
      const sudo = await run(target, "sudo -n true", log, { quiet: true });
      if (sudo.code !== 0) log(`The user ${target.username} is not root and has no passwordless sudo. Docker must already be usable by this user.`);
    }

    log("==> Checking Docker");
    let docker = await run(target, "docker version --format '{{.Server.Version}}'", log, { quiet: true });
    if (docker.code !== 0) {
      if (!/command not found|not found/i.test(docker.stderr) && !opts.installDocker) {
        throw new Error(`Docker is installed but not usable: ${docker.stderr.trim().split("\n").pop()}`);
      }
      if (!opts.installDocker) throw new Error("Docker is not installed. Use Install Docker to set it up automatically.");
      log("==> Installing Docker (this takes a few minutes)");
      const install = await run(target, "curl -fsSL https://get.docker.com | sh", log, { sudo: true, timeoutMs: 20 * 60_000 });
      if (install.code !== 0) throw new Error("Installing Docker failed. See the log above.");
      await run(target, `mkdir -p /etc/docker && [ -f /etc/docker/daemon.json ] || printf '%s\\n' ${sh(DAEMON_JSON)} > /etc/docker/daemon.json`, log, { sudo: true });
      await run(target, "systemctl enable --now docker >/dev/null 2>&1 || service docker start", log, { sudo: true });
      docker = await run(target, "docker version --format '{{.Server.Version}}'", log, { quiet: true });
      if (docker.code !== 0) throw new Error(`Docker was installed but does not answer: ${docker.stderr.trim()}`);
    }
    log(`Docker ${docker.stdout.trim()}`);

    // Two servers on one Docker engine would fight over the same proxy container and ports
    // (e.g. adding 127.0.0.1 over SSH on the machine Serve runs on).
    const dockerId = (await run(target, "docker info --format '{{.ID}}'", log, { quiet: true })).stdout.trim();
    if (dockerId) {
      const local = await getServer(LOCAL_SERVER_ID).then((c) => c.docker.info() as Promise<{ ID?: string }>).catch(() => null);
      if (local?.ID && local.ID === dockerId) {
        throw new Error("This is the Docker engine Serve itself runs on. Use the built-in \"This server\" entry instead of adding it again.");
      }
      const twin = (await db.select({ id: schema.server.id, name: schema.server.name, info: schema.server.info }).from(schema.server)).find(
        (r) => r.id !== serverId && (r.info as ServerInfo & { dockerId?: string }).dockerId === dockerId,
      );
      if (twin) throw new Error(`This is the same Docker engine as the server ${twin.name}. Each server needs its own Docker engine.`);
    }
    const compose = await run(target, "docker compose version --short", log, { quiet: true });
    if (compose.code !== 0) log("Docker Compose v2 is missing. Compose services will not deploy on this server.");
    else log(`Compose ${compose.stdout.trim()}`);

    log("==> Preparing the data directory");
    const mk = await run(target, `mkdir -p ${sh(row.dataDir)} && chmod 700 ${sh(row.dataDir)}${whoami !== "0" ? ` && chown ${sh(target.username)} ${sh(row.dataDir)}` : ""}`, log, { sudo: true });
    if (mk.code !== 0) throw new Error(`Could not create ${row.dataDir}.`);

    log("==> Reading system information");
    const facts = await run(
      target,
      `. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"; uname -r; uname -m; nproc; awk '/MemTotal/ {print $2*1024}' /proc/meminfo`,
      log,
      { quiet: true },
    );
    const [os, kernel, arch, cpus, memory] = facts.stdout.trim().split("\n");
    const info: ServerInfo = { os, kernel, arch, cpus: Number(cpus) || undefined, memory: Number(memory) || undefined, docker: docker.stdout.trim(), compose: compose.code === 0 ? compose.stdout.trim() : null, dockerId } as ServerInfo;
    await db.update(schema.server).set({ info }).where(eq(schema.server.id, serverId));
    log(`${os} · ${arch} · ${cpus} CPU`);

    log("==> Starting the network and proxy");
    const ctx = await getServer(serverId);
    await ensureNetwork(ctx.docker, ctx.network);
    const { ensureServerProxy } = await import("@/server/proxy/nginx");
    await ensureServerProxy(ctx, log);
    log("Proxy running");

    await setStatus(serverId, "ready", null, { lastSeenAt: new Date() });
    log("==> Server is ready");
  } catch (error) {
    const message = (error as Error).message;
    log(`==> ${message}`);
    await setStatus(serverId, error instanceof HostKeyMismatchError ? "error" : "unreachable", message);
    throw error;
  } finally {
    await flush();
  }
}

/** Lightweight reachability probe used by the worker's health loop. */
export async function probeServer(serverId: string) {
  const row = await getServerRow(serverId);
  if (row.isLocal) return true;
  try {
    const ctx = await getServer(serverId);
    await ctx.docker.ping();
    await db.update(schema.server).set({ lastSeenAt: new Date(), ...(row.status === "unreachable" ? { status: "ready" as const, statusMessage: null } : {}) }).where(eq(schema.server.id, serverId));
    return true;
  } catch (error) {
    if (row.status === "ready") await setStatus(serverId, "unreachable", (error as Error).message);
    return false;
  }
}
