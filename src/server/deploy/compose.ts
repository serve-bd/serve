import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type Docker from "dockerode";
import { docker, LABEL } from "@/server/docker/client";
import { run } from "@/server/process";
import type { ServerCtx } from "@/server/servers/context";
import type { ComposePort } from "@/server/services/types";
import { sh } from "@/server/servers/ssh";
import { composeAlias } from "@/server/proxy/names";
import { replaceFile } from "./files";

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
 * Serve's labels, dashboard ports and subnet for a stack. The environment network is not declared
 * here: compose would give it the bare service names too (see joinEnvNetwork). Isolated stacks get
 * the `<slug>-<service>` alias on their own network, where the proxy joins.
 */
export function transformCompose(content: string, slug: string, serviceId: string, subnet?: string | null, extraPorts: ComposePort[] = [], isolated = false): string {
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
    if (isolated) {
      if (Array.isArray(svc.networks)) {
        const nets: Record<string, { aliases?: string[] } | null> = {};
        for (const n of svc.networks) nets[n] = null;
        svc.networks = nets;
      }
      const nets = (svc.networks as Record<string, { aliases?: string[] } | null>) ?? { default: null };
      if (!Object.keys(nets).length) nets.default = null;
      // Only the stack's own network, where the proxy joins too; the alias keeps proxy names unique.
      const own = nets.default ?? {};
      nets.default = { ...own, aliases: [...new Set([...(own.aliases ?? []), composeAlias(slug, name)])] };
      svc.networks = nets;
    }

    const labels = { [LABEL.managed]: "true", [LABEL.service]: serviceId, [LABEL.slug]: slug, [LABEL.kind]: "compose" };
    if (Array.isArray(svc.labels)) {
      svc.labels = [...svc.labels, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)];
    } else {
      svc.labels = { ...(svc.labels ?? {}), ...labels };
    }
  }
  doc.networks = { ...(doc.networks ?? {}) };
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

/** A compose env file whose values compose reads back exactly, never interpolating them. */
export function envFile(vars: Record<string, string>) {
  return (
    Object.entries(vars)
      .map(([k, v]) => `${k}=${envValue(v)}`)
      .join("\n") + "\n"
  );
}

/**
 * Single quotes keep a value literal in compose env files but cannot hold a quote. Double quotes
 * can, with \\, \", \$ and line breaks escaped so nothing is interpolated.
 */
function envValue(v: string) {
  if (!v.includes("'")) return `'${v}'`;
  return `"${v
    .replace(/[\\"$]/g, "\\$&")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}"`;
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
  /** The environment network the stack's services join (not for isolated stacks). */
  envNetwork?: string;
};

export async function writeComposeFiles(opts: ComposeRun & { content: string }) {
  await fs.mkdir(opts.dir, { recursive: true });
  // The project directory may be mounted into the stack's containers: never write through a link.
  await replaceFile(path.join(opts.dir, opts.file), opts.content);
  await replaceFile(path.join(opts.dir, ".env"), envFile(opts.vars), 0o600);
}

function composeArgs(opts: Pick<ComposeRun, "projectName" | "dir" | "file">) {
  return ["compose", "-p", opts.projectName, "--project-directory", opts.dir, "-f", path.join(opts.dir, opts.file)];
}

const UP_ARGS = ["up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "300"];

/**
 * `docker compose up` for a stack: containers are created first, joined to the environment
 * network, then started. Every path that (re)creates a stack's containers goes through here.
 */
export async function composeUp(opts: ComposeRun) {
  const compose = (args: string[]) =>
    opts.server && !opts.server.local
      ? remoteCompose(opts.server, opts, args, opts.log, opts.signal, opts.redact)
      : run("docker", [...composeArgs(opts), ...args], { isolatedEnv: true, cwd: opts.dir, onLine: opts.log, signal: opts.signal, redact: opts.redact });
  if (opts.envNetwork) {
    await compose(["up", "--no-start", "--build", "--remove-orphans"]);
    await joinEnvNetwork(opts.server?.docker ?? docker, opts.projectName, opts.envNetwork);
    await compose(UP_ARGS);
  } else {
    await compose([...UP_ARGS, "--build"]);
  }
}

/**
 * Connects a stack's containers to the environment network with only the `<slug>-<service>`
 * alias. Declared in the compose file, the network would also carry each bare service name, and
 * two stacks with a `db` would answer for each other. Docker keeps the connection across
 * restarts; compose recreating a container drops it, hence this after every create.
 */
export async function joinEnvNetwork(d: Docker, projectName: string, network: string) {
  const containers = await d.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${projectName}`, `${LABEL.kind}=compose`] } });
  for (const c of containers) {
    const service = c.Labels["com.docker.compose.service"];
    if (!service || c.Labels["com.docker.compose.oneoff"] === "True") continue;
    const info = await d.getContainer(c.Id).inspect();
    const mode = info.HostConfig.NetworkMode ?? "";
    if (mode === "host" || mode === "none" || mode.startsWith("container:") || mode.startsWith("service:")) continue;
    const alias = composeAlias(projectName, service);
    const current = info.NetworkSettings.Networks?.[network];
    if (current) {
      // Attached by an older version of Serve, through the compose file: with the bare names.
      const own = new Set([alias, info.Name.replace(/^\//, ""), c.Id.slice(0, 12)]);
      if (((current.Aliases ?? []) as string[]).every((a) => own.has(a))) continue;
      await d.getNetwork(network).disconnect({ Container: c.Id, Force: true });
    }
    await d.getNetwork(network).connect({ Container: c.Id, EndpointConfig: { Aliases: [alias] } });
  }
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

export async function composeCommand(opts: Pick<ComposeRun, "projectName" | "dir" | "file" | "server">, args: string[], log?: (line: string) => void) {
  if (opts.server && !opts.server.local) return remoteCompose(opts.server, opts, args, log);
  return run("docker", [...composeArgs(opts), ...args], { isolatedEnv: true, cwd: opts.dir, onLine: log });
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
  await run("docker", args, { env, isolatedEnv: true }).catch(() => {});
}
