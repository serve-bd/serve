import { and, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { balances, runServerIds } from "@/server/deploy/distribution";
import { appCopies } from "@/server/services/balance";
import { serverTraffic } from "@/server/services/balance-rules";
import { balancingOf } from "@/lib/balancing";
import type { DeploymentTarget } from "@/server/services/types";

/** One of an app's other servers, as its copy card on the canvas shows it. */
export type CardCopy = {
  serverId: string;
  serverName: string;
  /**
   * Load balancing: "traffic", or why it gets none (network, address, deploy, down), or "standby"
   * (main server first). Otherwise how its deploy went: running, failed, pending.
   */
  state: "traffic" | "standby" | "network" | "address" | "deploy" | "down" | "running" | "failed" | "pending";
  /** Load balancing: its share of the visitors, in percent. */
  share: number | null;
};

/**
 * How an app reaches its other servers: the main server spreads visitors over them (balance),
 * Cloudflare sends each visitor to the nearest (closest), or they only run it (copies).
 */
export type CardSpread = {
  mode: "balance" | "closest" | "copies";
  tunnelStatus: string | null;
  /** Load balancing: the main server's own share of the visitors, in percent. */
  mainShare: number | null;
  copies: CardCopy[];
};

type Service = typeof schema.service.$inferSelect;

/** The spread of each app that runs on more than one server, by service id. */
export async function cardSpreads(services: Service[], serverName: (id: string) => string): Promise<Map<string, CardSpread>> {
  const apps = services.filter((s) => s.type === "app" && runServerIds(s.serverId, s.distribution).length > 1);
  const out = new Map<string, CardSpread>();
  if (!apps.length) return out;
  const ids = apps.map((s) => s.id);
  const deploymentIds = apps.map((s) => s.currentDeploymentId).filter((id): id is string => !!id);
  const [tunnels, deployments] = await Promise.all([
    // Closest server is on while its shared tunnel carries a domain.
    db
      .select({ serviceId: schema.cloudflareTunnel.serviceId, status: schema.cloudflareTunnel.status })
      .from(schema.cloudflareTunnel)
      .where(and(inArray(schema.cloudflareTunnel.serviceId, ids), sql`exists (select 1 from ${schema.domain} where ${schema.domain.tunnelId} = ${schema.cloudflareTunnel.id})`)),
    deploymentIds.length
      ? db.select({ id: schema.deployment.id, targets: schema.deployment.targets }).from(schema.deployment).where(inArray(schema.deployment.id, deploymentIds))
      : [],
  ]);
  for (const s of apps) {
    const extras = runServerIds(s.serverId, s.distribution).slice(1);
    const tunnel = tunnels.find((t) => t.serviceId === s.id);
    const targets: DeploymentTarget[] = deployments.find((d) => d.id === s.currentDeploymentId)?.targets ?? [];
    const deployState = (id: string): CardCopy["state"] => {
      const t = targets.find((x) => x.serverId === id)?.status;
      return t === "success" ? "running" : t === "failed" || t === "skipped" ? "failed" : "pending";
    };
    if (!tunnel && balances(s.serverId, s.distribution)) {
      const copies = await appCopies(s).catch(() => []);
      const replicas = Math.max(1, s.runtime.replicas || 1);
      const mainFirst = balancingOf(s.proxy) === "main-first";
      // Main server first: the others wait while the main server's replicas answer.
      const standby = mainFirst && s.balance?.main?.ok !== false;
      const traffic = extras.map((id) => serverTraffic(copies.filter((c) => c.serverId === id)));
      const weight = replicas * (standby || !mainFirst ? 1 : 0) + (standby ? 0 : traffic.reduce((sum, t) => sum + (t.problem ? 0 : t.up), 0));
      const copyCards = extras.map((id, i): CardCopy => {
        const t = traffic[i];
        const state: CardCopy["state"] = t.problem ?? (standby ? "standby" : "traffic");
        return { serverId: id, serverName: serverName(id), state, share: state === "traffic" ? (weight ? Math.round((t.up / weight) * 100) : 0) : null };
      });
      out.set(s.id, {
        mode: "balance",
        tunnelStatus: null,
        mainShare: Math.max(0, 100 - copyCards.reduce((sum, c) => sum + (c.share ?? 0), 0)),
        copies: copyCards,
      });
      continue;
    }
    out.set(s.id, {
      mode: tunnel ? "closest" : "copies",
      tunnelStatus: tunnel?.status ?? null,
      mainShare: null,
      copies: extras.map((id) => ({ serverId: id, serverName: serverName(id), state: deployState(id), share: null })),
    });
  }
  return out;
}
