import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { paths } from "@/server/paths";
import type { SshTarget } from "./ssh";

/**
 * Environment for running the Docker CLI (builds, compose, certbot) against a
 * remote server over SSH. The CLI shells out to `ssh`, so a wrapper on PATH
 * points it at a generated config with the server's key and pinned host key.
 */

function dir() {
  return path.join(paths.ssh, "cli");
}

let wrapperReady: Promise<void> | null = null;
function ensureWrapper() {
  wrapperReady ??= (async () => {
    await fs.mkdir(path.join(dir(), "bin"), { recursive: true, mode: 0o700 });
    const wrapper = path.join(dir(), "bin", "ssh");
    await fs.writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/ssh -F "$SERVE_SSH_CONFIG" "$@"\n`, { mode: 0o755 });
  })().catch((error) => {
    wrapperReady = null;
    throw error;
  });
  return wrapperReady;
}

async function controlDir() {
  const d = path.join(os.tmpdir(), `serve-ssh-${process.getuid?.() ?? "u"}`);
  await fs.mkdir(d, { recursive: true, mode: 0o700 });
  await fs.chmod(d, 0o700);
  return d;
}

export function sshAlias(serverId: string) {
  return `serve-${serverId}`;
}

/** Writes the per-server SSH config and returns env vars for `docker` commands. */
export async function dockerCliEnv(t: SshTarget): Promise<Record<string, string>> {
  await ensureWrapper();
  const base = path.join(dir(), t.id);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const keyFile = path.join(base, "id");
  const knownHosts = path.join(base, "known_hosts");
  const config = path.join(base, "config");
  await fs.writeFile(keyFile, t.privateKey.endsWith("\n") ? t.privateKey : `${t.privateKey}\n`, { mode: 0o600 });
  const hostPattern = t.port === 22 ? t.host : `[${t.host}]:${t.port}`;
  await fs.writeFile(knownHosts, t.hostKey ? `${hostPattern} ${t.hostKey}\n` : "", { mode: 0o600 });
  await fs.writeFile(
    config,
    [
      `Host ${sshAlias(t.id)}`,
      `  HostName ${t.host}`,
      `  Port ${t.port}`,
      `  User ${t.username}`,
      `  IdentityFile ${keyFile}`,
      `  IdentitiesOnly yes`,
      `  UserKnownHostsFile ${knownHosts}`,
      `  StrictHostKeyChecking yes`,
      `  ControlMaster auto`,
      // Unix sockets have a ~100 byte path limit, so control sockets live in a short temp dir.
      `  ControlPath ${await controlDir()}/%C`,
      `  ControlPersist 10m`,
      `  ServerAliveInterval 15`,
      `  ConnectTimeout 20`,
      `  LogLevel ERROR`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return {
    DOCKER_HOST: `ssh://${sshAlias(t.id)}`,
    SERVE_SSH_CONFIG: config,
    PATH: `${path.join(dir(), "bin")}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
  };
}
