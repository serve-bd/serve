import type Docker from "dockerode";
import { LABEL } from "@/server/docker/client";
import { v4Range } from "@/server/docker/subnets";
import { tunnelNetworkName } from "./names";

/**
 * A /26 in 10.222.0.0/16 that overlaps none of the given subnets. Outside the ranges Serve uses
 * elsewhere (Docker pools 10.200.0.0/12 on set-up servers, stacks 10.210-10.219, mesh 10.240-10.241).
 */
export function freeTunnelSubnet(used: string[]) {
  const taken = used.map(v4Range).filter((r): r is [number, number] => !!r);
  const start = (10 << 24) | (222 << 16);
  for (let block = 0; block < 1024; block++) {
    const first = (start + block * 64) >>> 0;
    const last = first + 63;
    if (taken.some(([a, b]) => first <= b && a <= last)) continue;
    return `10.222.${(block * 64) >> 8}.${(block * 64) & 255}/26`;
  }
  return null;
}

/**
 * Create the network only the proxy and cloudflared share. Docker picks its range; when its pools
 * are exhausted a free /26 is chosen here. Never throws: without it the proxy still works, it just
 * trusts no tunnel visitor IP (and connectors stay on the main network). Null when it is missing.
 */
export async function ensureTunnelNetwork(d: Docker, network: string, log?: (line: string) => void): Promise<"created" | "exists" | null> {
  const name = tunnelNetworkName(network);
  try {
    const found = await d.listNetworks({ filters: { name: [name] } });
    if (found.some((n) => n.Name === name)) return "exists";
    const options = { Name: name, Driver: "bridge", Attachable: true, Labels: { [LABEL.managed]: "true" } };
    try {
      await d.createNetwork(options);
    } catch (error) {
      const message = (error as Error).message;
      if (/already exists/i.test(message)) return "exists";
      if (!/address pools|overlap/i.test(message)) throw error;
      const used = (await d.listNetworks()).flatMap((n) => (n.IPAM?.Config ?? []).map((c) => c.Subnet ?? "")).filter(Boolean);
      const subnet = freeTunnelSubnet(used);
      if (!subnet) throw new Error("no free private range left");
      await d.createNetwork({ ...options, IPAM: { Driver: "default", Config: [{ Subnet: subnet }] } });
    }
    return "created";
  } catch (error) {
    const line = `Could not create the ${name} network (${(error as Error).message}); Cloudflare Tunnel visitors show the tunnel's address until it exists.`;
    log?.(line);
    console.warn(line);
    return null;
  }
}
