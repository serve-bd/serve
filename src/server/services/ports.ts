import { engines } from "@/server/databases/engines";
import type { schema } from "@/server/db";
import type { BindAddress } from "./types";
import { serverPublicIp } from "@/server/servers/access";

type Service = typeof schema.service.$inferSelect;

export type PublishedPort = {
  host: number;
  container: number;
  protocol: "tcp" | "udp";
  bindAddress: BindAddress;
  /** Address to reach it: "localhost" when bound to 127.0.0.1, else the server's public IP (or host name). */
  address: string;
  /** Ready-to-show "address:port". */
  label: string;
  /** http:// link for TCP ports, null for UDP. */
  url: string | null;
};

/** Host ports a service publishes on its server, with the address to reach each one. */
export async function publishedPorts(service: Service, server?: { publicIp: string | null; host: string; isLocal: boolean }): Promise<PublishedPort[]> {
  const mappings =
    service.type === "database" && service.database?.publicPort
      ? [{ host: service.database.publicPort, container: engines[service.database.engine].port, protocol: "tcp" as const, bindAddress: service.database.publicBind }]
      : service.type === "app"
        ? service.runtime.ports
        : service.type === "compose"
          ? (service.compose?.ports ?? [])
          : [];
  if (!mappings.length) return [];
  const publicAddress = server?.publicIp ?? (await serverPublicIp(service.serverId)) ?? (server && !server.isLocal ? server.host : "localhost");
  return mappings.map((p) => {
    const bindAddress: BindAddress = p.bindAddress ?? "0.0.0.0";
    const address = bindAddress === "127.0.0.1" ? "localhost" : publicAddress;
    const label = `${address}:${p.host}`;
    return { host: p.host, container: p.container, protocol: p.protocol, bindAddress, address, label, url: p.protocol === "tcp" ? `http://${label}` : null };
  });
}

export type ListeningPort = { port: number; protocol: "tcp" | "udp" };

/**
 * Ports the service's running containers listen on (their image's EXPOSE and any published ones),
 * per compose service; apps use the key "". Empty when nothing runs yet.
 */
export async function listeningPorts(service: Service): Promise<Record<string, ListeningPort[]>> {
  const { serverOf } = await import("@/server/servers/context");
  const server = await serverOf(service).catch(() => null);
  const containers = server ? await server.docker.listContainers({ filters: { label: [`serve.service=${service.id}`] } }).catch(() => []) : [];
  const out: Record<string, ListeningPort[]> = {};
  for (const c of containers) {
    const key = service.type === "compose" ? (c.Labels["com.docker.compose.service"] ?? "") : "";
    const list = (out[key] ??= []);
    for (const p of c.Ports) {
      const protocol = p.Type === "udp" ? "udp" : "tcp";
      if (p.PrivatePort && !list.some((x) => x.port === p.PrivatePort && x.protocol === protocol)) list.push({ port: p.PrivatePort, protocol });
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.port - b.port);
  return out;
}

/** Host ports already published on the service's server by other containers (and the proxy). */
export async function busyHostPorts(service: Service): Promise<number[]> {
  const { serverOf } = await import("@/server/servers/context");
  const server = await serverOf(service);
  const busy = new Set<number>([server.proxyHttpPort, server.proxyHttpsPort]);
  // The dashboard itself, when it runs directly on this machine (development). Docker cannot see it.
  if (server.local) for (const p of [3000, Number(process.env.PORT)]) if (p) busy.add(p);
  const containers = await server.docker.listContainers().catch(() => []);
  for (const c of containers) {
    if (c.Labels["serve.service"] === service.id) continue;
    for (const p of c.Ports) if (p.PublicPort) busy.add(p.PublicPort);
  }
  return [...busy].sort((a, b) => a - b);
}
