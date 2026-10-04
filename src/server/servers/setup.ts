import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { ServerInfo, ServerStatus } from "@/server/db/schema";
import { ensureNetwork } from "@/server/docker/client";
import { withTimeout } from "@/server/monitoring/containers";
import { forgetServer, getServer, getServerRow, LOCAL_SERVER_ID, sshTargetFor } from "./context";
import { closeConnection, connect, HostKeyMismatchError, sh, sshExec, type SshTarget } from "./ssh";

type Log = (line: string) => void;

async function setStatus(id: string, status: ServerStatus, message: string | null, extra: Partial<typeof schema.server.$inferInsert> = {}) {
  await db
    .update(schema.server)
    .set({ status, statusMessage: message, ...extra })
    .where(eq(schema.server.id, id));
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
    let canSudo = whoami === "0";
    if (whoami !== "0") {
      const sudo = await run(target, "sudo -n true", log, { quiet: true });
      canSudo = sudo.code === 0;
      if (!canSudo) log(`The user ${target.username} is not root and has no passwordless sudo. Docker must already be usable by this user.`);
    }
    const dockerVersion = () => run(target, "docker version --format '{{.Server.Version}}'", log, { quiet: true });
    /**
     * A non-root user needs the docker group to talk to the Docker socket (a fresh install only
     * lets root in). Group changes apply to new logins, so the SSH connections are reopened.
     */
    const grantDockerAccess = async () => {
      if (whoami === "0" || !canSudo) return false;
      log(`Adding ${target.username} to the docker group so it can use Docker`);
      const added = await run(target, `getent group docker >/dev/null || groupadd docker; usermod -aG docker ${sh(target.username)}`, log, { sudo: true });
      if (added.code !== 0) return false;
      closeConnection(target.id);
      return true;
    };
    const permissionDenied = (stderr: string) => /permission denied/i.test(stderr);

    log("==> Checking Docker");
    let docker = await dockerVersion();
    if (docker.code !== 0 && permissionDenied(docker.stderr) && (await grantDockerAccess())) docker = await dockerVersion();
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
      // A just-started engine needs a moment before it answers; the docker group needs a new login.
      let granted = false;
      for (let i = 0; i < 15; i++) {
        docker = await dockerVersion();
        if (docker.code === 0) break;
        if (!granted && permissionDenied(docker.stderr)) {
          granted = true;
          if (await grantDockerAccess()) continue;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (docker.code !== 0) throw new Error(`Docker was installed but does not answer: ${docker.stderr.trim() || `exit code ${docker.code}`}`);
    }
    log(`Docker ${docker.stdout.trim()}`);

    // Two servers on one Docker engine would fight over the same proxy container and ports
    // (e.g. adding 127.0.0.1 over SSH on the machine Serve runs on).
    const dockerId = (await run(target, "docker info --format '{{.ID}}'", log, { quiet: true })).stdout.trim();
    if (dockerId) {
      const local = await getServer(LOCAL_SERVER_ID)
        .then((c) => c.docker.info() as Promise<{ ID?: string }>)
        .catch(() => null);
      if (local?.ID && local.ID === dockerId) {
        throw new Error('This is the Docker engine the dashboard itself runs on. Use the built-in "This server" entry instead of adding it again.');
      }
      // Checked and claimed under one lock, so two servers set up at the same moment cannot both pass.
      const twin = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('serve:server-docker-id'))`);
        const rows = await tx
          .select({ id: schema.server.id, name: schema.server.name, info: schema.server.info, ownerOrganizationId: schema.server.ownerOrganizationId })
          .from(schema.server);
        const found = rows.find((r) => r.id !== serverId && (r.info as ServerInfo & { dockerId?: string }).dockerId === dockerId);
        if (!found)
          await tx
            .update(schema.server)
            .set({ info: sql`coalesce(${schema.server.info}, '{}'::jsonb) || jsonb_build_object('dockerId', ${dockerId}::text)` })
            .where(eq(schema.server.id, serverId));
        return found;
      });
      if (twin) {
        // Another organization's server is not named: that would tell who else uses the machine.
        const same = twin.ownerOrganizationId === row.ownerOrganizationId;
        throw new Error(
          same
            ? `This is the same Docker engine as the server ${twin.name}. Each server needs its own Docker engine.`
            : "This machine's Docker engine is already added to this dashboard, by another organization or the instance. Each machine can be added once; ask a Root admin to share it instead.",
        );
      }
    }
    // A machine that runs its own Serve (its worker container) belongs to that install: the names
    // this server would use (serve-proxy, the serve network, serve-mesh) are already its own, and
    // setting up here would take them over.
    const own = await run(target, "docker ps -a --filter name=^serve-worker$ --format '{{.Names}} {{.Status}}'", log, { quiet: true });
    if (own.code === 0 && own.stdout.trim()) {
      throw new Error(
        "This machine runs its own Serve installation (the serve-worker container), so it cannot also be a server of this dashboard. Use it from its own dashboard, or uninstall that Serve first (cd /data/serve && docker compose down).",
      );
    }
    const compose = await run(target, "docker compose version --short", log, { quiet: true });
    if (compose.code !== 0) log("Docker Compose v2 is missing. Compose services will not deploy on this server.");
    else log(`Compose ${compose.stdout.trim()}`);

    log("==> Preparing the data directory");
    const mk = await run(target, `mkdir -p ${sh(row.dataDir)} && chmod 700 ${sh(row.dataDir)}${whoami !== "0" ? ` && chown ${sh(target.username)} ${sh(row.dataDir)}` : ""}`, log, {
      sudo: true,
    });
    if (mk.code !== 0) throw new Error(`Could not create ${row.dataDir}.`);

    log("==> Reading system information");
    const facts = await run(target, `. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"; uname -r; uname -m; nproc; awk '/MemTotal/ {print $2*1024}' /proc/meminfo`, log, {
      quiet: true,
    });
    const [os, kernel, arch, cpus, memory] = facts.stdout.trim().split("\n");
    const info: ServerInfo = {
      os,
      kernel,
      arch,
      cpus: Number(cpus) || undefined,
      memory: Number(memory) || undefined,
      docker: docker.stdout.trim(),
      compose: compose.code === 0 ? compose.stdout.trim() : null,
      dockerId,
    } as ServerInfo;
    await db.update(schema.server).set({ info }).where(eq(schema.server.id, serverId));
    log(`${os} · ${arch} · ${cpus} CPU`);

    log("==> Starting the network and proxy");
    const ctx = await getServer(serverId);
    await ensureNetwork(ctx.docker, ctx.network);
    const { ensureServerProxy, ProxyConfigError } = await import("@/server/proxy/nginx");
    // A proxy that cannot start (a port taken by another program) does not stop the server from
    // running apps: it only keeps their domains from answering. The server is ready, with a warning.
    let proxyProblem: string | null = null;
    try {
      await ensureServerProxy(ctx, log);
      log("Proxy running");
    } catch (error) {
      if (!(error instanceof ProxyConfigError)) throw error;
      proxyProblem = `The proxy is not running: ${error.message} Apps run, but their domains answer only once the proxy has free ports (Proxy settings of this server).`;
      log(`Warning: ${proxyProblem}`);
    }

    if (row.metricsEnabled) {
      const { ensureMetricsAgent } = await import("@/server/metrics-agent");
      // Without the agent, metrics are read over SSH: never a reason to fail the setup.
      await ensureMetricsAgent(ctx, log).catch((error: Error) => log(`Warning: the metrics agent could not start (${error.message}).`));
    }

    await setStatus(serverId, "ready", proxyProblem, { lastSeenAt: new Date() });
    log("==> Server is ready");
  } catch (error) {
    let message = (error as Error).message;
    // Through Tailscale, a connection that never got an answer usually means the dashboard's machine is not in the tailnet.
    if (row.tailscale?.address) {
      const { looksLikeNetwork, tailnetReachHint } = await import("@/server/tailscale");
      const hint = looksLikeNetwork(message) ? await tailnetReachHint(row).catch(() => null) : null;
      // A server that left the tailnet gets only the reason: "check the firewall" would mislead.
      if (hint) message = row.tailscale.error ? hint : `${message} ${hint}`;
    }
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
    // A stalled connection counts as unreachable instead of holding up the next probes.
    await withTimeout(ctx.docker.ping(), 20_000);
    await db
      .update(schema.server)
      .set({ lastSeenAt: new Date(), ...(row.status === "unreachable" ? { status: "ready" as const, statusMessage: null } : {}) })
      .where(eq(schema.server.id, serverId));
    return true;
  } catch (error) {
    if (row.status === "ready") {
      let message = (error as Error).message;
      if (row.tailscale?.address) {
        const { looksLikeNetwork, tailnetReachHint } = await import("@/server/tailscale");
        const hint = looksLikeNetwork(message) ? await tailnetReachHint(row).catch(() => null) : null;
        // A server that left the tailnet gets only the reason: "check the firewall" would mislead.
        if (hint) message = row.tailscale.error ? hint : `${message} ${hint}`;
      }
      await setStatus(serverId, "unreachable", message);
    }
    return false;
  }
}
