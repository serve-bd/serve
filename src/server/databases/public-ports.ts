import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getServer } from "@/server/servers/context";
import { replicaInstances } from "@/server/services/types";

type Service = typeof schema.service.$inferSelect;

/** Whose public port it is: a database itself, its pooler or its read replicas. */
export type PortHolder = "database" | "pooler" | "replicas";

/**
 * Host ports databases hold on one server: each database's public port, its pooler's, and its
 * replicas' (on every server a replica runs on). `except` leaves one holder out, for checking the
 * port it is about to take.
 */
export async function heldDatabasePorts(serverId: string, except?: { serviceId: string; holder: PortHolder }): Promise<Set<number>> {
  const rows = await db.select().from(schema.service).where(eq(schema.service.type, "database"));
  const held = new Set<number>();
  const skip = (s: Service, holder: PortHolder) => except?.serviceId === s.id && except.holder === holder;
  for (const s of rows) {
    const cfg = s.database;
    if (!cfg) continue;
    if (s.serverId === serverId && cfg.publicPort && !skip(s, "database")) held.add(cfg.publicPort);
    if (s.serverId === serverId && cfg.pooler?.enabled && cfg.pooler.public?.port && !skip(s, "pooler")) held.add(cfg.pooler.public.port);
    if (cfg.replica?.public?.port && !skip(s, "replicas") && replicaInstances(s).some((r) => r.serverId === serverId)) held.add(cfg.replica.public.port);
  }
  return held;
}

/** Ports something listens on, on the machine itself (a system PostgreSQL, for example). */
async function listening(serverId: string) {
  const ctx = await getServer(serverId);
  const res = await ctx.exec("ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null", { timeoutMs: 5000 }).catch(() => null);
  const ports = new Set<number>();
  for (const line of res?.code === 0 ? res.stdout.split("\n") : []) {
    const local = line.trim().split(/\s+/)[3] ?? "";
    ports.add(Number(local.slice(local.lastIndexOf(":") + 1)));
  }
  return ports;
}

/** Ports in use on a server, for one holder about to take a port: containers', databases' and the machine's own. */
export async function busyPortsFor(service: Service, serverId: string, holder: PortHolder) {
  const { busyHostPorts } = await import("@/server/services/ports");
  const busy = new Set<number>([...(await busyHostPorts({ ...service, serverId })), ...(await heldDatabasePorts(serverId, { serviceId: service.id, holder }))]);
  for (const p of await listening(serverId).catch(() => new Set<number>())) busy.add(p);
  return busy;
}

/** A port free on every one of these servers, from `start` up. */
export async function freePortOn(service: Service, serverIds: string[], holder: PortHolder, start: number) {
  const busy = new Set<number>();
  for (const id of new Set(serverIds)) for (const p of await busyPortsFor(service, id, holder)) busy.add(p);
  for (let port = start; port < 65536; port++) if (!busy.has(port)) return port;
  throw new Error("No free port on the server.");
}
