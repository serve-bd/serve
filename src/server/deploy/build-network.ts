import crypto from "node:crypto";
import type Docker from "dockerode";
import { run } from "@/server/process";

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

/** One builder per environment network and Docker host: the CLI keeps builders by name. */
export function builderName(network: string, dockerEnv: Record<string, string> = {}) {
  const host = crypto
    .createHash("sha256")
    .update(dockerEnv.DOCKER_HOST ?? "local")
    .digest("hex")
    .slice(0, 6);
  return `${PREFIX}${network.replace(/^serve-env-/, "")}-${host}`;
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
export async function ensureBuilder(name: string, network: string, env: Record<string, string>, log: (line: string) => void) {
  try {
    await run("docker", ["buildx", "inspect", "--bootstrap", name], { env });
    return true;
  } catch {
    // Not created yet, or created by a worker that has since restarted.
  }
  try {
    await run("docker", ["buildx", "create", "--name", name, "--driver", "docker-container", "--driver-opt", `network=${network}`, "--driver-opt", `image=${BUILDKIT_IMAGE}`], {
      env,
    });
    await run("docker", ["buildx", "inspect", "--bootstrap", name], { env });
    return true;
  } catch (error) {
    log(`Could not start a build container on the environment network (${(error as Error).message.trim().split("\n").pop()}); building without access to its services.`);
    return false;
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
export async function pruneBuilders(d: Docker, env: Record<string, string>, untilHours: number): Promise<string[]> {
  const output: string[] = [];
  const containers = await d.listContainers({ all: true, filters: { name: [`buildx_buildkit_${PREFIX}`] } });
  const networks = new Set((await d.listNetworks()).map((n) => n.Name));
  for (const c of containers) {
    const container = c.Names[0]?.replace(/^\//, "") ?? "";
    const name = container.replace(/^buildx_buildkit_/, "").replace(/0$/, "");
    if (!name.startsWith(PREFIX)) continue;
    const network = Object.keys(c.NetworkSettings?.Networks ?? {}).find((n) => n.startsWith("serve-env-"));
    if (!network || !networks.has(network)) {
      await run("docker", ["buildx", "rm", name], { env }).catch(async () => {
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
    if (!(await ensureBuilder(name, network, env, () => {}))) continue;
    output.push(await run("docker", ["buildx", "prune", "--builder", name, "-f", "--filter", `until=${untilHours}h`], { env }).catch(() => ""));
  }
  return output;
}
