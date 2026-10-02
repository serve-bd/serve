import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { ServerAgent } from "@/server/db/schema";
import { LABEL } from "@/server/docker/client";
import { env } from "@/server/env";
import { getSettings } from "@/server/settings";
import { getServer, getServerRow, type ServerCtx } from "@/server/servers/context";
import { sh } from "@/server/servers/ssh";
import { hashToken } from "@/server/tunnel";
import { type AgentBatch, batchSchema, ingestBatch } from "./ingest";

/*
 * The metrics agent (agent/main.go) runs on every remote server with metrics on. It samples the
 * machine and its containers and pushes the samples to the dashboard, so the dashboard does not
 * ask every server over SSH every 30 seconds. A server that cannot reach the dashboard keeps its
 * samples, and the worker collects them over SSH instead (drainAgent).
 *
 * The binary ships inside the Serve image. It is copied to the server and wrapped in a tiny
 * image there (FROM scratch), so no registry is involved and the agent always matches the
 * dashboard's version.
 */

export const AGENT_CONTAINER = "serve-agent";
const IMAGE_REPO = "serve-agent";

/** An agent that sent nothing for this long is collected over SSH instead. */
export const AGENT_FRESH_MS = 90_000;

type Log = (line: string) => void;

/** Go's name for the server's CPU architecture. */
export function goArch(machine: string | undefined | null) {
  const m = (machine ?? "").trim().toLowerCase();
  if (m === "x86_64" || m === "amd64") return "amd64";
  if (m === "aarch64" || m === "arm64") return "arm64";
  return null;
}

function binaryDirs() {
  return [process.env.SERVE_AGENT_DIR, path.join(process.cwd(), "dist", "agent")].filter((d): d is string => !!d);
}

const hashes = new Map<string, string>();

/** The agent binary for an architecture and the image tag it gets, or null when it was not built. */
export async function agentBinary(arch: string): Promise<{ file: string; image: string } | null> {
  for (const dir of binaryDirs()) {
    const file = path.join(dir, `serve-agent-linux-${arch}`);
    const data = await fs.readFile(file).catch(() => null);
    if (!data) continue;
    let hash = hashes.get(file);
    if (!hash) {
      hash = createHash("sha256").update(data).digest("hex").slice(0, 12);
      hashes.set(file, hash);
    }
    return { file, image: `${IMAGE_REPO}:${hash}` };
  }
  return null;
}

/** Addresses the agent tries, in order: the dashboard domain, then the address the dashboard runs at. */
export async function dashboardUrls() {
  const settings = await getSettings();
  const urls = [settings.dashboardDomain ? `https://${settings.dashboardDomain}` : null, env.appUrl.replace(/\/$/, "")];
  return [...new Set(urls.filter((u): u is string => !!u))];
}

async function setAgent(serverId: string, agent: ServerAgent | null) {
  await db.update(schema.server).set({ agent }).where(eq(schema.server.id, serverId));
}

/** Wraps the binary in an image on the server: one compressed upload over SSH, then `docker build -`. */
async function buildImage(ctx: ServerCtx, binary: { file: string; image: string }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "serve-agent-"));
  try {
    await fs.copyFile(binary.file, path.join(dir, "serve-agent"));
    await fs.chmod(path.join(dir, "serve-agent"), 0o755);
    // HTTPS to the dashboard domain needs the CA list; scratch images have none.
    const ca = await fs.readFile("/etc/ssl/certs/ca-certificates.crt").catch(() => null);
    if (ca) await fs.writeFile(path.join(dir, "ca-certificates.crt"), ca);
    await fs.writeFile(
      path.join(dir, "Dockerfile"),
      [
        "FROM scratch",
        "COPY serve-agent /serve-agent",
        ...(ca ? ["COPY ca-certificates.crt /etc/ssl/certs/ca-certificates.crt"] : []),
        `LABEL ${LABEL.managed}=true ${LABEL.kind}=agent`,
        'ENTRYPOINT ["/serve-agent"]',
        "",
      ].join("\n"),
    );
    const res = await ctx.exec(`docker build -q -t ${sh(binary.image)} -`, {
      stdin: () => spawn("tar", ["-czf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "ignore"] }).stdout,
      timeoutMs: 180_000,
    });
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split("\n").pop() || `docker build exited with code ${res.code}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function removeOldImages(ctx: ServerCtx, keep: string | null) {
  const images = await ctx.docker.listImages({ filters: { reference: [IMAGE_REPO] } }).catch(() => []);
  for (const img of images)
    for (const tag of img.RepoTags ?? [])
      if (tag !== keep)
        await ctx.docker
          .getImage(tag)
          .remove()
          .catch(() => {});
}

/**
 * Starts the agent on a remote server, or replaces it when its binary or the dashboard's
 * addresses changed. Returns false when there is no agent build for the server (it is then
 * sampled over SSH as before).
 */
export async function ensureMetricsAgent(ctx: ServerCtx, log: Log = () => {}): Promise<boolean> {
  if (ctx.local) return false;
  const row = await getServerRow(ctx.id);
  if (!row.metricsEnabled) return false;
  let arch = goArch(row.info.arch);
  if (!arch) arch = goArch((await ctx.exec("uname -m", { timeoutMs: 15_000 })).stdout);
  if (!arch) {
    await setAgent(ctx.id, null);
    log(`The metrics agent does not run on ${row.info.arch ?? "this CPU"}; metrics are read over SSH.`);
    return false;
  }
  const binary = await agentBinary(arch);
  if (!binary) return false;
  const urls = (await dashboardUrls()).join(",");

  const container = ctx.docker.getContainer(AGENT_CONTAINER);
  const info = await container.inspect().catch(() => null);
  const envOf = (name: string) => info?.Config.Env?.find((e) => e.startsWith(`${name}=`))?.slice(name.length + 1);
  // Two installs at once can leave the saved token of one and the container of the other: compare them too.
  const runningToken = envOf("SERVE_AGENT_TOKEN")?.slice(ctx.id.length + 1);
  const tokenSaved = !!runningToken && !!row.agent?.tokenHash && hashToken(runningToken) === row.agent.tokenHash;
  if (info?.State.Running && info.Config.Image === binary.image && row.agent?.image === binary.image && envOf("SERVE_URLS") === urls && tokenSaved) {
    if (row.agent.urls !== urls) await setAgent(ctx.id, { ...row.agent, urls });
    return true;
  }

  try {
    const present = await ctx.docker
      .getImage(binary.image)
      .inspect()
      .then(() => true)
      .catch(() => false);
    if (!present) {
      log("Installing the metrics agent");
      await buildImage(ctx, binary);
    }
    const token = randomBytes(24).toString("base64url");
    // Saved before the agent starts, so its first push is accepted. Its run id changes anyway.
    await setAgent(ctx.id, {
      ...(row.agent ?? {}),
      image: binary.image,
      urls,
      tokenHash: hashToken(token),
      installedAt: new Date().toISOString(),
      boot: null,
      seq: 0,
      error: null,
    });
    if (info) await container.remove({ force: true }).catch(() => {});
    const created = await ctx.docker.createContainer({
      name: AGENT_CONTAINER,
      Image: binary.image,
      Env: [`SERVE_URLS=${urls}`, `SERVE_AGENT_TOKEN=${ctx.id}.${token}`, "SERVE_HOST_DATA=/host-data"],
      Labels: { [LABEL.managed]: "true", [LABEL.kind]: "agent" },
      HostConfig: {
        RestartPolicy: { Name: "always" },
        Init: true,
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,size=1m" },
        Binds: ["/var/run/docker.sock:/var/run/docker.sock:ro", `${row.dataDir}:/host-data:ro`],
        // A day of held-back samples of a busy server fits; a cap, not a reservation.
        Memory: 256 * 1024 * 1024,
        LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "2" } },
      },
    });
    await created.start();
    await removeOldImages(ctx, binary.image);
    log("Metrics agent running");
    return true;
  } catch (error) {
    const message = (error as Error).message;
    await setAgent(ctx.id, { ...(row.agent ?? { image: "", tokenHash: "", installedAt: new Date().toISOString() }), error: message });
    log(`Warning: the metrics agent could not start (${message}); metrics are read over SSH.`);
    return false;
  }
}

/** Removes the agent from a server (metrics turned off, or the server is being removed). */
export async function removeMetricsAgent(ctx: ServerCtx) {
  await ctx.docker
    .getContainer(AGENT_CONTAINER)
    .remove({ force: true })
    .catch(() => {});
  await removeOldImages(ctx, null);
  await setAgent(ctx.id, null);
}

/**
 * Collects the samples an agent could not push, over SSH. The last stored sample is acknowledged
 * in the same call, so the agent drops what the dashboard already has.
 */
export async function drainAgent(ctx: ServerCtx) {
  const row = await getServerRow(ctx.id);
  const agent = row.agent;
  const args = ["drain", "--max", "240", ...(agent?.boot ? ["--boot", agent.boot, "--ack", String(agent.seq ?? 0)] : [])];
  const res = await ctx.exec(`docker exec ${AGENT_CONTAINER} /serve-agent ${args.map(sh).join(" ")}`, { timeoutMs: 20_000 });
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || `docker exec exited with code ${res.code}`);
  const batch: AgentBatch = batchSchema.parse(JSON.parse(res.stdout));
  if (!batch.samples.length) return 0;
  const result = await ingestBatch(ctx.id, batch, "ssh");
  return "gone" in result ? 0 : result.stored;
}

const syncing = new Set<string>();
const lastTry = new Map<string, number>();

/**
 * Worker job: each ready remote server runs the agent of this dashboard's version while its
 * metrics are on, and none while they are off. An agent that stopped reporting is checked
 * again; one that failed to install is tried again every 10 minutes.
 */
export async function syncMetricsAgents(now = Date.now()) {
  const rows = await db
    .select({ id: schema.server.id, status: schema.server.status, enabled: schema.server.metricsEnabled, agent: schema.server.agent, info: schema.server.info })
    .from(schema.server)
    .where(eq(schema.server.isLocal, false));
  const urls = (await dashboardUrls()).join(",");
  await Promise.all(
    rows
      .filter((r) => r.status === "ready" && !syncing.has(r.id) && (r.enabled || r.agent))
      .map(async (r) => {
        if (r.enabled) {
          const arch = goArch(r.info.arch);
          const binary = arch ? await agentBinary(arch) : null;
          if (arch && !binary) return;
          const seen = r.agent?.seenAt ? now - new Date(r.agent.seenAt).getTime() : Number.POSITIVE_INFINITY;
          if (r.agent && !r.agent.error && r.agent.image === binary?.image && r.agent.urls === urls && seen < 3 * 60_000) return;
        }
        // Removing the agent of an unreachable server is tried again as rarely as installing it.
        if (now - (lastTry.get(r.id) ?? 0) < (r.enabled && r.agent?.error ? 10 : 3) * 60_000) return;
        syncing.add(r.id);
        lastTry.set(r.id, now);
        try {
          const ctx = await getServer(r.id);
          await Promise.race([
            r.enabled ? ensureMetricsAgent(ctx) : removeMetricsAgent(ctx),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 240_000)),
          ]);
        } catch {
          // Unreachable right now: tried again on a later run.
        } finally {
          syncing.delete(r.id);
        }
      }),
  );
}
