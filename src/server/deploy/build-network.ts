import crypto from "node:crypto";
import type Docker from "dockerode";
import { run } from "@/server/process";
import { sh } from "@/server/servers/ssh";
import type { ServerCtx } from "@/server/servers/context";

/*
 * Builds that reach the environment's services. A BuildKit container joined to the environment
 * network runs the build, so RUN steps can use the database like the running app does (Next.js
 * prerendering, migrations at build time). BuildKit does not use Docker's DNS in RUN steps, so the
 * services' names are passed as host entries. Only that network is reachable: other environments,
 * other organizations and Serve itself stay out of reach.
 */

export const BUILDKIT_IMAGE = "moby/buildkit:v0.29.0";
const PREFIX = "serve-build-";

export type BuildNetwork = { name: string; hosts: Record<string, string> };

/** Runs the docker CLI with these arguments and returns its output; throws when it fails. */
export type DockerCli = (args: string[]) => Promise<string>;

/**
 * The docker CLI of a server, run on that server: builders are known to the CLI that created them,
 * and a build container's image export then stays on the machine instead of crossing SSH twice.
 */
export function serverCli(server: Pick<ServerCtx, "local" | "exec">): DockerCli {
  if (server.local) return (args) => run("docker", args);
  return async (args) => {
    const res = await server.exec(`docker ${args.map(sh).join(" ")}`);
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || `docker exited with code ${res.code}`);
    return res.stdout;
  };
}

/**
 * One builder per environment network on each machine (the CLI that runs it is on that machine).
 * The suffix is fixed: 0.1.2 to 0.1.4 derived it from the Docker host, which left extra builders.
 */
const SUFFIX = crypto.createHash("sha256").update("local").digest("hex").slice(0, 6);
export function builderName(network: string) {
  return `${PREFIX}${network.replace(/^serve-env-/, "")}-${SUFFIX}`;
}

/** Removes other builders of the same environment network (older names), with their cache. */
async function removeOtherBuilders(name: string, network: string, docker: DockerCli) {
  const prefix = `buildx_buildkit_${PREFIX}${network.replace(/^serve-env-/, "")}-`;
  const names = (await docker(["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{.Names}}"]).catch(() => ""))
    .split("\n")
    .map((n) => n.trim())
    .filter((n) => n.startsWith(prefix) && n !== `buildx_buildkit_${name}0`);
  for (const container of names) {
    await docker(["buildx", "rm", "-f", container.replace(/^buildx_buildkit_/, "").replace(/0$/, "")]).catch(async () => {
      await docker(["rm", "-f", "-v", container]).catch(() => "");
      await docker(["volume", "rm", `${container}_state`]).catch(() => "");
    });
  }
}

const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;

/** Every name a container answers to on the network, with its IPv4 address. */
export async function networkHosts(d: Docker, network: string): Promise<Record<string, string>> {
  const hosts: Record<string, string> = {};
  const containers = await d.listContainers({ filters: { network: [network] } });
  for (const c of containers) {
    const info = await d
      .getContainer(c.Id)
      .inspect()
      .catch(() => null);
    const net = info?.NetworkSettings?.Networks?.[network];
    if (!net?.IPAddress || info?.Name?.startsWith(`/buildx_buildkit_${PREFIX}`)) continue;
    const names = [...(net.Aliases ?? []), ...((net as { DNSNames?: string[] }).DNSNames ?? []), info?.Name?.replace(/^\//, "") ?? ""];
    for (const name of names) if (HOSTNAME.test(name) && !(name in hosts)) hosts[name] = net.IPAddress;
  }
  return hosts;
}

/** Creates the builder when this worker does not know it yet. False when buildx cannot run one. */
export async function ensureBuilder(name: string, network: string, docker: DockerCli, log: (line: string) => void) {
  await removeOtherBuilders(name, network, docker);
  try {
    await docker(["buildx", "inspect", "--bootstrap", name]);
    return true;
  } catch {
    // Not created yet, or created by a worker that has since restarted.
  }
  try {
    await docker(["buildx", "create", "--name", name, "--driver", "docker-container", "--driver-opt", `network=${network}`, "--driver-opt", `image=${BUILDKIT_IMAGE}`]);
    await docker(["buildx", "inspect", "--bootstrap", name]);
    return true;
  } catch (error) {
    log(`Could not start a build container on the environment network (${(error as Error).message.trim().split("\n").pop()}); building without access to its services.`);
    return false;
  }
}

/**
 * Builds using each builder right now. A builder is stopped once its last build ends: its cache
 * stays on disk, and the next build starts it again in a second or two.
 */
const inUse = new Map<string, number>();

export async function useBuilder<T>(name: string, docker: DockerCli, build: () => Promise<T>): Promise<T> {
  inUse.set(name, (inUse.get(name) ?? 0) + 1);
  try {
    return await build();
  } finally {
    const left = (inUse.get(name) ?? 1) - 1;
    if (left > 0) inUse.set(name, left);
    else {
      inUse.delete(name);
      await docker(["stop", `buildx_buildkit_${name}0`]).catch(() => "");
    }
  }
}

/** Build flags that run the build in the environment's builder and name its services. */
export function builderFlags(name: string, hosts: Record<string, string>) {
  return ["--builder", name, "--load", ...Object.entries(hosts).flatMap(([host, ip]) => ["--add-host", `${host}:${ip}`])];
}

/**
 * Cleanup: prunes the build cache of every environment builder on a server and removes builders
 * whose environment network is gone. Returns the output of each prune, for the space reclaimed.
 */
export async function pruneBuilders(d: Docker, docker: DockerCli, untilHours: number): Promise<string[]> {
  const output: string[] = [];
  const containers = await d.listContainers({ all: true, filters: { name: [`buildx_buildkit_${PREFIX}`] } });
  const networks = new Set((await d.listNetworks()).map((n) => n.Name));
  for (const c of containers) {
    const container = c.Names[0]?.replace(/^\//, "") ?? "";
    const name = container.replace(/^buildx_buildkit_/, "").replace(/0$/, "");
    if (!name.startsWith(PREFIX)) continue;
    const network = Object.keys(c.NetworkSettings?.Networks ?? {}).find((n) => n.startsWith("serve-env-"));
    if (!network || !networks.has(network)) {
      await docker(["buildx", "rm", name]).catch(async () => {
        // The CLI no longer knows it (a restarted worker): remove its container and state by hand.
        await d
          .getContainer(c.Id)
          .remove({ force: true, v: true })
          .catch(() => {});
        await d
          .getVolume(`${container}_state`)
          .remove()
          .catch(() => {});
      });
      continue;
    }
    if (!(await ensureBuilder(name, network, docker, () => {}))) continue;
    output.push(await docker(["buildx", "prune", "--builder", name, "-f", "--filter", `until=${untilHours}h`]).catch(() => ""));
    // Started for the prune: stop it again unless a build is using it.
    if (!inUse.has(name)) await docker(["stop", `buildx_buildkit_${name}0`]).catch(() => "");
  }
  return output;
}
