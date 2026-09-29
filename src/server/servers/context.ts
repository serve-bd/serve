import http from "node:http";
import { spawn } from "node:child_process";
import Docker from "dockerode";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { decrypt } from "@/server/crypto";
import { docker as localDocker } from "@/server/docker/client";
import { env } from "@/server/env";
import { pathsFor, type ServerPaths } from "@/server/paths";
import { dockerCliEnv } from "./cli";
import { localFs, remoteFs, type ServerFs } from "./fs";
import { closeConnection, dockerStream, sshExec, type SshExecResult, type SshTarget } from "./ssh";

export { LOCAL_SERVER_ID };

export type ServerRow = typeof schema.server.$inferSelect;

/**
 * Everything needed to operate on one server. Local and remote servers share
 * this shape, so deploy, proxy and backup code does not care where it runs.
 */
export type ServerCtx = {
  id: string;
  name: string;
  local: boolean;
  row: ServerRow;
  /** Docker Engine API client (socket locally, SSH remotely). */
  docker: Docker;
  /** The server's disk. */
  fs: ServerFs;
  paths: ServerPaths;
  /** Shared bridge network every managed container joins. */
  network: string;
  proxyContainer: string;
  proxyHttpPort: number;
  proxyHttpsPort: number;
  /** Run a shell command on the server (inside the Serve container for the local server). */
  exec(command: string, opts?: { onLine?: (line: string) => void; signal?: AbortSignal; timeoutMs?: number; stdin?: NodeJS.ReadableStream | string | (() => NodeJS.ReadableStream) }): Promise<SshExecResult>;
  /** Env vars that point the `docker` CLI at this server. Empty for the local server. */
  cliEnv(): Promise<Record<string, string>>;
  /** SSH details, null for the local server. */
  ssh: SshTarget | null;
};

function localExec(command: string, opts: Parameters<ServerCtx["exec"]>[1] = {}): Promise<SshExecResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let partial = "";
    const emit = (text: string) => {
      if (!opts.onLine) return;
      partial += text;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) opts.onLine(line);
    };
    child.stdout.on("data", (d: Buffer) => ((stdout += d), emit(d.toString())));
    child.stderr.on("data", (d: Buffer) => ((stderr += d), emit(d.toString())));
    const input = typeof opts.stdin === "function" ? opts.stdin() : opts.stdin;
    if (typeof input === "string") child.stdin.end(input);
    else if (input) input.pipe(child.stdin);
    else child.stdin.end();
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    opts.signal?.addEventListener("abort", () => child.kill("SIGTERM"));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (partial && opts.onLine) opts.onLine(partial);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
  });
}

/** Docker API over the shared SSH connection: one exec channel per HTTP connection. */
function remoteDocker(target: SshTarget) {
  // Keep-alive reuses one dial-stdio channel for many API calls; hijacked streams get their own.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4, timeout: 60_000 });
  (agent as unknown as { createConnection: unknown }).createConnection = (_opts: unknown, cb: (err: Error | null, socket?: unknown) => void) => {
    dockerStream(target).then(
      (socket) => cb(null, socket),
      (error) => cb(error as Error),
    );
    return undefined;
  };
  return new Docker({ protocol: "http", host: "docker", port: 80, agent } as Docker.DockerOptions);
}

export async function sshTargetFor(row: ServerRow): Promise<SshTarget> {
  if (!row.privateKeyId) throw new Error(`Server ${row.name} has no SSH key.`);
  const [key] = await db.select().from(schema.privateKey).where(eq(schema.privateKey.id, row.privateKeyId));
  if (!key) throw new Error(`The SSH key of ${row.name} was deleted.`);
  return { id: row.id, host: row.host, port: row.port, username: row.username, privateKey: decrypt(key.privateKey), hostKey: row.hostKey };
}

function buildLocal(row: ServerRow): ServerCtx {
  return {
    id: row.id,
    name: row.name,
    local: true,
    row,
    docker: localDocker,
    fs: localFs,
    paths: pathsFor(env.dataDir),
    network: env.network,
    proxyContainer: env.proxyContainer,
    proxyHttpPort: env.proxyHttpPort,
    proxyHttpsPort: env.proxyHttpsPort,
    exec: localExec,
    cliEnv: async () => ({}),
    ssh: null,
  };
}

async function buildRemote(row: ServerRow): Promise<ServerCtx> {
  const target = await sshTargetFor(row);
  return {
    id: row.id,
    name: row.name,
    local: false,
    row,
    docker: remoteDocker(target),
    fs: remoteFs(target),
    paths: pathsFor(row.dataDir),
    network: "serve",
    proxyContainer: "serve-proxy",
    proxyHttpPort: row.proxyHttpPort,
    proxyHttpsPort: row.proxyHttpsPort,
    exec: (command, opts) => sshExec(target, command, opts),
    cliEnv: () => dockerCliEnv(target),
    ssh: target,
  };
}

const store = globalThis as unknown as { __serveServers?: Map<string, { stamp: string; ctx: Promise<ServerCtx> }> };
const cache = (store.__serveServers ??= new Map());

function stamp(row: ServerRow) {
  return `${row.updatedAt.getTime()}|${row.hostKey ?? ""}|${row.privateKeyId ?? ""}`;
}

export async function getServerRow(id: string) {
  const [row] = await db.select().from(schema.server).where(eq(schema.server.id, id));
  if (!row) throw new Error("Server not found.");
  return row;
}

/** Context for a server id (defaults to the local server). Cached until the row changes. */
export async function getServer(id: string | null | undefined = LOCAL_SERVER_ID): Promise<ServerCtx> {
  const row = await getServerRow(id || LOCAL_SERVER_ID);
  const cached = cache.get(row.id);
  if (cached && cached.stamp === stamp(row)) return cached.ctx;
  const ctx = row.isLocal ? Promise.resolve(buildLocal(row)) : buildRemote(row);
  cache.set(row.id, { stamp: stamp(row), ctx });
  ctx.catch(() => cache.delete(row.id));
  return ctx;
}

/** Context for the server a service runs on. */
export function serverOf(service: { serverId: string }) {
  return getServer(service.serverId);
}

export async function listServers() {
  return db.select().from(schema.server).orderBy(schema.server.createdAt);
}

/** Drops cached clients and SSH connections (after edits or deletion). */
export function forgetServer(id: string) {
  cache.delete(id);
  closeConnection(id);
}
