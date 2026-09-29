import { docker, LABEL } from "@/server/docker/client";
import { env } from "@/server/env";

const ENV_LABEL = "serve.environment";

/** Private network shared only by the services of one project environment. */
export function envNetworkName(environmentId: string) {
  return `serve-env-${environmentId}`;
}

/** Pick a free /24 in 10.211-10.219 when Docker's default pools are exhausted. */
async function freeSubnet(): Promise<string> {
  const used = new Set<string>();
  for (const n of await docker.listNetworks()) for (const c of n.IPAM?.Config ?? []) if (c.Subnet) used.add(c.Subnet);
  for (let a = 211; a < 220; a++) for (let b = 0; b < 256; b++) if (!used.has(`10.${a}.${b}.0/24`)) return `10.${a}.${b}.0/24`;
  throw new Error("No free private subnet left for a new environment network.");
}

const pending = new Map<string, Promise<string>>();

/** Create the environment network if needed and make sure the proxy is attached to it. */
export function ensureEnvNetwork(environmentId: string): Promise<string> {
  const name = envNetworkName(environmentId);
  const existing = pending.get(name);
  if (existing) return existing;
  const task = (async () => {
    const found = await docker.listNetworks({ filters: { name: [name] } });
    if (!found.some((n) => n.Name === name)) {
      const options = { Name: name, Driver: "bridge", Attachable: true, Labels: { [LABEL.managed]: "true", [ENV_LABEL]: environmentId } };
      try {
        await docker.createNetwork(options);
      } catch (error) {
        const message = (error as Error).message;
        if (/already exists/i.test(message)) {
          // created concurrently
        } else if (/address pools/i.test(message)) {
          await docker.createNetwork({ ...options, IPAM: { Driver: "default", Config: [{ Subnet: await freeSubnet() }] } });
        } else throw error;
      }
    }
    await connectProxy(name);
    return name;
  })().finally(() => pending.delete(name));
  pending.set(name, task);
  return task;
}

export async function connectProxy(network: string) {
  try {
    const info = await docker.getContainer(env.proxyContainer).inspect();
    if (!info.NetworkSettings.Networks?.[network]) await docker.getNetwork(network).connect({ Container: env.proxyContainer });
  } catch (error) {
    // Proxy not created yet: it attaches to every environment network when it starts.
    if (!/No such container|404/i.test((error as Error).message)) throw error;
  }
}

/** Attach the proxy to every environment network (used when the proxy is created). */
export async function connectProxyToAll() {
  const networks = await docker.listNetworks({ filters: { label: [ENV_LABEL] } });
  for (const n of networks) await connectProxy(n.Name).catch(() => {});
}

/** Remove an environment network once nothing but the proxy uses it. */
export async function removeEnvNetworkIfUnused(environmentId: string) {
  const name = envNetworkName(environmentId);
  try {
    const info = await docker.getNetwork(name).inspect();
    const members = Object.values(info.Containers ?? {}) as { Name: string }[];
    if (members.some((c) => c.Name !== env.proxyContainer)) return;
    if (members.length) await docker.getNetwork(name).disconnect({ Container: env.proxyContainer, Force: true }).catch(() => {});
    await docker.getNetwork(name).remove();
  } catch {
    // already gone
  }
}
