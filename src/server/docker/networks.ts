import type Docker from "dockerode";
import { docker, LABEL } from "@/server/docker/client";
import { env } from "@/server/env";

const ENV_LABEL = "serve.environment";

/** The Docker host a network lives on. Any ServerCtx fits; defaults to the local server. */
export type NetworkTarget = { docker: Docker; proxyContainer: string; id?: string };

const localTarget = (): NetworkTarget => ({ docker, proxyContainer: env.proxyContainer, id: "local" });

/** Private network shared only by the services of one project environment. */
export function envNetworkName(environmentId: string) {
  return `serve-env-${environmentId}`;
}

/** Pick a free /24 in 10.211-10.219 when Docker's default pools are exhausted. */
async function freeSubnet(d: Docker): Promise<string> {
  const used = new Set<string>();
  for (const n of await d.listNetworks()) for (const c of n.IPAM?.Config ?? []) if (c.Subnet) used.add(c.Subnet);
  for (let a = 211; a < 220; a++) for (let b = 0; b < 256; b++) if (!used.has(`10.${a}.${b}.0/24`)) return `10.${a}.${b}.0/24`;
  throw new Error("No free private subnet left for a new environment network.");
}

const pending = new Map<string, Promise<string>>();

/** Create the environment network if needed and make sure the proxy is attached to it. */
export function ensureEnvNetwork(environmentId: string, target: NetworkTarget = localTarget()): Promise<string> {
  const name = envNetworkName(environmentId);
  const key = `${target.id ?? "local"}:${name}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const task = (async () => {
    const d = target.docker;
    const found = await d.listNetworks({ filters: { name: [name] } });
    if (!found.some((n) => n.Name === name)) {
      const options = { Name: name, Driver: "bridge", Attachable: true, Labels: { [LABEL.managed]: "true", [ENV_LABEL]: environmentId } };
      try {
        await d.createNetwork(options);
      } catch (error) {
        const message = (error as Error).message;
        if (/already exists/i.test(message)) {
          // created concurrently
        } else if (/address pools/i.test(message)) {
          await d.createNetwork({ ...options, IPAM: { Driver: "default", Config: [{ Subnet: await freeSubnet(d) }] } });
        } else throw error;
      }
    }
    await connectProxy(name, target);
    return name;
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

export async function connectProxy(network: string, target: NetworkTarget = localTarget()) {
  const d = target.docker;
  try {
    const info = await d.getContainer(target.proxyContainer).inspect();
    if (!info.NetworkSettings.Networks?.[network]) await d.getNetwork(network).connect({ Container: target.proxyContainer });
  } catch (error) {
    // Proxy not created yet: it attaches to every environment network when it starts.
    if (!/No such container|404/i.test((error as Error).message)) throw error;
  }
}

export async function disconnectProxy(network: string, target: NetworkTarget = localTarget()) {
  const d = target.docker;
  const info = await d
    .getContainer(target.proxyContainer)
    .inspect()
    .catch(() => null);
  if (info?.NetworkSettings.Networks?.[network]) await d.getNetwork(network).disconnect({ Container: target.proxyContainer, Force: true });
}

/** Attach the proxy to every environment network and isolated stack network (used when the proxy is created). */
export async function connectProxyToAll(target: NetworkTarget = localTarget()) {
  const [envs, stacks] = await Promise.all([
    target.docker.listNetworks({ filters: { label: [ENV_LABEL] } }),
    target.docker.listNetworks({ filters: { label: ["serve.stack-network"] } }),
  ]);
  for (const n of [...envs, ...stacks]) await connectProxy(n.Name, target).catch(() => {});
}

/** Remove an environment network once nothing but the proxy uses it. */
export async function removeEnvNetworkIfUnused(environmentId: string, target: NetworkTarget = localTarget()) {
  const name = envNetworkName(environmentId);
  const d = target.docker;
  try {
    const info = await d.getNetwork(name).inspect();
    const members = Object.values(info.Containers ?? {}) as { Name: string }[];
    // The proxy, the private network's name forwarders and the environment's build container only
    // serve the environment's services.
    // Shared containers that joined to reach databases (tunnel connectors, the database router) are
    // only detached; the others belong to this environment and go with its network.
    const shared = (name: string) => name === target.proxyContainer || name.startsWith("serve-tunnel-") || name === "serve-db-router";
    const helper = (c: { Name: string }) => shared(c.Name) || c.Name.startsWith("serve-link-") || c.Name.startsWith("buildx_buildkit_serve-build-");
    if (members.some((c) => !helper(c))) return;
    // Stopped containers are not members, but could not start again without the network.
    const attached = await d.listContainers({ all: true, filters: { network: [name] } });
    if (attached.some((c) => !helper({ Name: c.Names[0]?.replace(/^\//, "") ?? "" }))) return;
    for (const c of members) {
      if (shared(c.Name))
        await d
          .getNetwork(name)
          .disconnect({ Container: c.Name, Force: true })
          .catch(() => {});
      else {
        await d
          .getContainer(c.Name)
          .remove({ force: true })
          .catch(() => {});
        // A build container keeps its cache in a volume of its own.
        if (c.Name.startsWith("buildx_buildkit_"))
          await d
            .getVolume(`${c.Name}_state`)
            .remove()
            .catch(() => {});
      }
    }
    // A stopped build container is not a member but still holds the network.
    for (const c of attached) {
      const cname = c.Names[0]?.replace(/^\//, "") ?? "";
      if (!cname.startsWith("buildx_buildkit_serve-build-") || members.some((m) => m.Name === cname)) continue;
      await d
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => {});
      await d
        .getVolume(`${cname}_state`)
        .remove()
        .catch(() => {});
    }
    await d.getNetwork(name).remove();
  } catch {
    // already gone
  }
}
