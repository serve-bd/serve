import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { env } from "@/server/env";
import { LABEL } from "@/server/docker/client";
import { run } from "@/server/process";
import type { ServerCtx } from "@/server/servers/context";
import type { ComposePort } from "@/server/services/types";
import { sh } from "@/server/servers/ssh";
import { composeAlias } from "@/server/proxy/names";

type ComposeFile = {
  services?: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  [key: string]: unknown;
};

type ComposeService = {
  networks?: string[] | Record<string, { aliases?: string[] } | null>;
  labels?: string[] | Record<string, string>;
  network_mode?: string;
  [key: string]: unknown;
};

export function parseCompose(content: string): ComposeFile {
  const doc = YAML.parse(content) as ComposeFile | null;
  if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object") {
    throw new Error("The compose file has no services.");
  }
  return doc;
}

export function composeServiceNames(content: string): string[] {
  try {
    return Object.keys(parseCompose(content).services ?? {});
  } catch {
    return [];
  }
}

/** Ports each compose service exposes (best effort, used for domain suggestions). */
export function composeServicePorts(content: string): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  try {
    const doc = parseCompose(content);
    for (const [name, svc] of Object.entries(doc.services ?? {})) {
      const ports = new Set<number>();
      for (const p of [...((svc.expose as unknown[]) ?? []), ...((svc.ports as unknown[]) ?? [])]) {
        const str = typeof p === "object" && p ? String((p as { target?: number }).target ?? "") : String(p);
        const container = str.split(":").pop()?.split("/")[0];
        if (container && /^\d+$/.test(container)) ports.add(Number(container));
      }
      out[name] = [...ports];
    }
  } catch {
    // ignore
  }
  return out;
}

/**
 * Attach every service to the shared Serve network with a predictable alias,
 * so the proxy can route to `<slug>-<service>`.
 */
export function transformCompose(
  content: string,
  slug: string,
  serviceId: string,
  subnet?: string | null,
  network: string = env.network,
  extraPorts: ComposePort[] = [],
  isolated = false,
): string {
  const doc = parseCompose(content);
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    // Ports published from the dashboard (Domains & ports).
    const mine = extraPorts.filter((p) => p.service === name);
    if (mine.length) {
      const existing = Array.isArray(svc.ports) ? (svc.ports as unknown[]) : [];
      svc.ports = [
        ...existing,
        ...mine.map((p) => ({
          target: p.container,
          published: String(p.host),
          protocol: p.protocol,
          mode: "host",
          ...(p.bindAddress && p.bindAddress !== "0.0.0.0" ? { host_ip: p.bindAddress } : {}),
        })),
      ];
    }
    if (svc.network_mode) continue;
    const alias = composeAlias(slug, name);
    if (Array.isArray(svc.networks)) {
      const nets: Record<string, { aliases?: string[] } | null> = {};
      for (const n of svc.networks) nets[n] = null;
      svc.networks = nets;
    }
    const nets = (svc.networks as Record<string, { aliases?: string[] } | null>) ?? { default: null };
    if (!Object.keys(nets).length) nets.default = null;
    if (isolated) {
      // Only the stack's own network, where the proxy joins too; the alias keeps proxy names unique.
      const own = nets.default ?? {};
      nets.default = { ...own, aliases: [...new Set([...(own.aliases ?? []), alias])] };
    } else {
      nets[network] = { aliases: [alias] };
    }
    svc.networks = nets;

    const labels = { [LABEL.managed]: "true", [LABEL.service]: serviceId, [LABEL.slug]: slug, [LABEL.kind]: "compose" };
    if (Array.isArray(svc.labels)) {
      svc.labels = [...svc.labels, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)];
    } else {
      svc.labels = { ...(svc.labels ?? {}), ...labels };
    }
  }
  if (!isolated) doc.networks = { ...(doc.networks ?? {}), [network]: { external: true, name: network } };
  else doc.networks = { ...(doc.networks ?? {}) };
  const nets = doc.networks as Record<string, Record<string, unknown> | null>;
  // Use a Serve-assigned subnet so stacks never exhaust Docker's default address pools.
  if (subnet && !nets.default) nets.default = { ipam: { config: [{ subnet }] } };
  // Marks the stack network the proxy must join (also after the proxy is recreated).
  if (isolated) nets.default = { ...(nets.default ?? {}), labels: { ...((nets.default?.labels as Record<string, string>) ?? {}), [STACK_NETWORK_LABEL]: serviceId } };
  return YAML.stringify(doc);
}

/** Pick the lowest free 10.210-10.219.x.0/24 subnet not used by other stacks or networks. */
export async function allocateSubnet(taken: string[], server?: Pick<ServerCtx, "docker">): Promise<string> {
  const d = server?.docker ?? (await import("@/server/docker/client")).docker;
  const used = new Set(taken);
  try {
    for (const n of await d.listNetworks()) {
      for (const c of n.IPAM?.Config ?? []) if (c.Subnet) used.add(c.Subnet);
    }
  } catch {
    // ignore
  }
  for (let a = 210; a < 220; a++) {
    for (let b = 0; b < 256; b++) {
      const subnet = `10.${a}.${b}.0/24`;
      if (!used.has(subnet)) return subnet;
    }
  }
  throw new Error("No free private subnet left for this stack.");
}

function envFile(vars: Record<string, string>) {
  return (
    Object.entries(vars)
      // Single quotes keep values literal (no interpolation) in compose env files.
      .map(([k, v]) => `${k}=${v.includes("'") ? JSON.stringify(v) : `'${v}'`}`)
      .join("\n") + "\n"
  );
}

export type ComposeRun = {
  projectName: string;
  /** Directory the compose file lives in (relative paths resolve from here). */
  dir: string;
  file: string;
  vars: Record<string, string>;
  log: (line: string) => void;
  signal?: AbortSignal;
  redact?: string[];
  /**
   * Target server. For a remote server `dir` is the path ON that server; the
   * caller uploads the project there and compose runs through SSH.
   */
  server?: ServerCtx;
};

export async function writeComposeFiles(opts: ComposeRun & { content: string }) {
  await fs.mkdir(opts.dir, { recursive: true });
  await fs.writeFile(path.join(opts.dir, opts.file), opts.content);
  await fs.writeFile(path.join(opts.dir, ".env"), envFile(opts.vars), { mode: 0o600 });
}

function composeArgs(opts: Pick<ComposeRun, "projectName" | "dir" | "file">) {
  return ["compose", "-p", opts.projectName, "--project-directory", opts.dir, "-f", path.join(opts.dir, opts.file)];
}

const UP_ARGS = ["up", "-d", "--build", "--remove-orphans", "--wait", "--wait-timeout", "300"];

export async function composeUp(opts: ComposeRun) {
  if (opts.server && !opts.server.local) {
    await remoteCompose(opts.server, opts, UP_ARGS, opts.log, opts.signal, opts.redact);
    return;
  }
  await run("docker", [...composeArgs(opts), ...UP_ARGS], {
    cwd: opts.dir,
    onLine: opts.log,
    signal: opts.signal,
    redact: opts.redact,
  });
}

/** Runs `docker compose` on a remote server so relative paths resolve against its copy of the project. */
async function remoteCompose(
  server: ServerCtx,
  opts: Pick<ComposeRun, "projectName" | "dir" | "file">,
  args: string[],
  log?: (line: string) => void,
  signal?: AbortSignal,
  redact: string[] = [],
) {
  const secrets = redact.filter((s) => s && s.length >= 4);
  const clean = (line: string) => secrets.reduce((acc, s) => acc.split(s).join("********"), line);
  const cmd = `cd ${sh(opts.dir)} && docker ${[...composeArgs(opts), ...args].map(sh).join(" ")} 2>&1`;
  const res = await server.exec(cmd, {
    onLine: log ? (line) => void (line.trim() && log(clean(line))) : undefined,
    signal,
    timeoutMs: 30 * 60_000,
  });
  if (res.code !== 0) {
    const output = clean(`${res.stdout}\n${res.stderr}`);
    throw Object.assign(new Error(`docker compose ${args[0]} exited with code ${res.code}`), { output });
  }
  return clean(res.stdout);
}

export async function composeCommand(
  opts: Pick<ComposeRun, "projectName" | "dir" | "file" | "server">,
  args: string[],
  log?: (line: string) => void,
) {
  if (opts.server && !opts.server.local) return remoteCompose(opts.server, opts, args, log);
  return run("docker", [...composeArgs(opts), ...args], { cwd: opts.dir, onLine: log });
}

/** Label on an isolated stack's own network; the proxy joins every network carrying it. */
export const STACK_NETWORK_LABEL = "serve.stack-network";

/** The network compose creates for a stack when the file does not name its default network. */
export const stackNetworkName = (projectName: string) => `${projectName}_default`;

/** `docker compose down` using only the project name (works without files). */
export async function composeDownByProject(projectName: string, removeVolumes: boolean, server?: ServerCtx) {
  const args = ["compose", "-p", projectName, "down", "--remove-orphans"];
  if (removeVolumes) args.push("-v");
  const env = server ? await server.cliEnv().catch(() => null) : {};
  if (env === null) return;
  // The proxy joins isolated stacks' networks; a network with a member cannot be removed.
  const { disconnectProxy } = await import("@/server/docker/networks");
  await disconnectProxy(stackNetworkName(projectName), server).catch(() => {});
  await run("docker", args, { env }).catch(() => {});
}
