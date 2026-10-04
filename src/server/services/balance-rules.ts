import type { BalanceState } from "./types";

/* Pure rules of the load balancing across servers (see services/balance). */

/** Seconds the proxy waits for a copy on another server to accept a connection before it tries the next one. */
export const BALANCE_CONNECT_TIMEOUT = 3;

/** Why a copy gets no traffic, or null when it does. */
export type CopyProblem = "network" | "address" | "deploy" | "down";

export type Copy = {
  serverId: string;
  /** "<link container>" on the own server; null while the copy has no private address yet. */
  host: string | null;
  /** Replicas the copy runs: its share of the traffic next to the own server's containers. */
  weight: number;
  /**
   * The app's current version runs there, or is on its way (a deploy in progress keeps serving the
   * old one until that server switches, like any rolling update). False when the last deploy failed
   * or skipped that server (it keeps an older version: no traffic, so versions never mix for long)
   * and for a server added since (no traffic until a deploy puts the app there).
   */
  deployed: boolean;
  /** Shares a private network with the app's own server. */
  linked: boolean;
  /** Last health check: true (answers), false (down), null (not checked yet). */
  healthy: boolean | null;
  error: string | null;
  since: string | null;
};

export function copyProblem(c: Copy): CopyProblem | null {
  if (!c.linked) return "network";
  if (!c.host) return "address";
  if (!c.deployed) return "deploy";
  if (c.healthy === false) return "down";
  return null;
}

/**
 * The copies the own server's proxy sends traffic to. Copies that are down are left out, unless
 * nothing else is left (no local container and every copy down): then all of them are tried, since
 * a health check can be wrong and a try beats a certain error page.
 */
export function balancedTargets(local: number, copies: Copy[]): { host: string; weight: number }[] {
  const usable = copies.filter((c) => c.linked && c.host && c.deployed);
  const up = usable.filter((c) => c.healthy !== false);
  const pick = up.length || local > 0 ? up : usable;
  return pick.map((c) => ({ host: c.host!, weight: c.weight }));
}

/** The next balance state after one health check of a copy, or null when nothing changed. */
export function nextBalance(state: BalanceState | null | undefined, serverId: string, ok: boolean, error: string | null, now: Date): BalanceState | null {
  const cur = state?.copies?.[serverId];
  if (cur && cur.ok === ok && (ok || cur.error === error)) return null;
  return { copies: { ...(state?.copies ?? {}), [serverId]: { ok, since: cur && cur.ok === ok ? cur.since : now.toISOString(), error: ok ? null : error } } };
}

export const CHECK_INTERVAL_MS = 10_000;
const DOWN_AFTER = 2;
const UP_AFTER = 2;

export type Streak = { fails: number; oks: number };

/** The copy's health after one more check: whether it is up, from its last known state and the checks in a row. */
export function decide(known: boolean | null, streak: Streak): boolean | null {
  if (known === false) return streak.oks >= UP_AFTER;
  if (streak.fails >= DOWN_AFTER) return false;
  return known === null && streak.oks === 0 ? null : true;
}

export function step(streak: Streak | undefined, ok: boolean): Streak {
  return ok ? { fails: 0, oks: (streak?.oks ?? 0) + 1 } : { fails: (streak?.fails ?? 0) + 1, oks: 0 };
}

/** What the proxy would be given: changes when a copy comes, goes, is deployed or changes health. */
export const targetsSignature = (copies: Copy[]) =>
  copies
    .map((c) => `${c.serverId}=${c.host ?? "-"}/${c.weight}/${c.linked ? 1 : 0}${c.deployed ? 1 : 0}/${c.healthy === false ? "down" : "up"}`)
    .sort()
    .join(",");
