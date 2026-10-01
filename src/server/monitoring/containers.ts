import type { AgentContainer, ServerAgent } from "@/server/db/schema";
import { LABEL } from "@/server/docker/client";

/**
 * The service containers of each server, for the status and crash checks. A remote server's agent
 * reports them every few seconds (and at once when one starts, stops or restarts); otherwise one
 * Docker call per server lists them, instead of one per service.
 */

/** What the checks need of a container; `info` comes with agent reports (an SSH list needs an inspect). */
export type ContainerView = {
  Id: string;
  State: string;
  Labels: Record<string, string>;
  info?: { name: string; restartCount: number; startedAt: number; createdAt: number; running: boolean; oomKilled: boolean; exitCode: number };
};

/** An agent report older than this is not trusted for container states. */
export const AGENT_CONTAINERS_FRESH_MS = 60_000;
/** A server that does not list its containers in time is skipped for this round. */
const LIST_TIMEOUT_MS = 20_000;

export function fromAgent(c: AgentContainer): ContainerView {
  return {
    Id: c.id,
    State: c.state,
    Labels: { [LABEL.service]: c.service, ...(c.deployment ? { [LABEL.deployment]: c.deployment } : {}) },
    info: {
      name: c.name,
      restartCount: c.restartCount,
      startedAt: (c.startedAt && Date.parse(c.startedAt)) || 0,
      createdAt: c.created * 1000,
      running: c.state === "running",
      oomKilled: !!c.oomKilled,
      exitCode: c.exitCode,
    },
  };
}

/** The agent's container report when it is recent enough to act on. */
export function freshAgentContainers(agent: ServerAgent | null | undefined, now = Date.now()) {
  if (!agent?.containers || !agent.containersAt || agent.error) return null;
  return now - new Date(agent.containersAt).getTime() < AGENT_CONTAINERS_FRESH_MS ? agent.containers.map(fromAgent) : null;
}

export function withTimeout<T>(promise: Promise<T>, ms = LIST_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} seconds`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Lists the service containers of servers on demand, once per run: `get(id)` returns the same
 * promise for the same server. Rejects for a server that cannot be reached in time.
 */
export async function containerLister(now = Date.now()) {
  // Loaded here: the helpers above stay usable without a database (tests).
  const [{ db, schema }, { getServer }] = await Promise.all([import("@/server/db"), import("@/server/servers/context")]);
  const rows = await db.select({ id: schema.server.id, agent: schema.server.agent }).from(schema.server);
  const agents = new Map(rows.map((r) => [r.id, r.agent]));
  const cache = new Map<string, Promise<ContainerView[]>>();
  return (serverId: string) => {
    let hit = cache.get(serverId);
    if (!hit) {
      const reported = freshAgentContainers(agents.get(serverId), now);
      hit = reported
        ? Promise.resolve(reported)
        : withTimeout(
            getServer(serverId).then(async (ctx) => (await ctx.docker.listContainers({ all: true, filters: { label: [LABEL.service] } })) as ContainerView[]),
            LIST_TIMEOUT_MS,
          );
      // Not unhandled when no one waits for it after a failure.
      hit.catch(() => {});
      cache.set(serverId, hit);
    }
    return hit;
  };
}
