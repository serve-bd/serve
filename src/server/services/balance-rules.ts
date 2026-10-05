import type { BalanceState } from "./types";

/* Pure rules of the load balancing across servers (see services/balance). */

/** Seconds the proxy waits for a copy on another server to accept a connection before it tries the next one. */
export const BALANCE_CONNECT_TIMEOUT = 2;

/** Why a copy gets no traffic, or null when it does. */
export type CopyProblem = "network" | "address" | "deploy" | "down";

/** One replica of an app on one of its extra servers. */
export type Copy = {
  serverId: string;
  /** Replica number on that server (1, 2, ...). */
  slot: number;
  /** "<link container>" on the own server; null while the replica has no private address yet. */
  host: string | null;
  /**
   * The app's current version runs there, or is on its way (a deploy in progress keeps serving the
   * old one until that server switches, like any rolling update). False when the last deploy failed
   * or skipped that server (it keeps an older version: no traffic, so versions never mix for long)
   * and for a server added since (no traffic until a deploy puts the app there).
   */
  deployed: boolean;
  /** Its server shares a private network with the app's own server. */
  linked: boolean;
  /** Last health check: true (answers), false (down), null (not checked yet). */
  healthy: boolean | null;
  error: string | null;
  since: string | null;
};

/** Key of a replica in BalanceState.copies. */
export const copyId = (serverId: string, slot: number) => `${serverId}:${slot}`;

export function copyProblem(c: Copy): CopyProblem | null {
  if (!c.linked) return "network";
  if (!c.host) return "address";
  if (!c.deployed) return "deploy";
  if (c.healthy === false) return "down";
  return null;
}

/**
 * The replicas on other servers the own server's proxy sends traffic to ("<link>" hosts). Those
 * that are down are left out, unless nothing else is left (no local container and every one down):
 * then all of them are tried, since a health check can be wrong and a try beats a certain error page.
 */
export function balancedTargets(local: number, copies: Copy[]): string[] {
  const usable = copies.filter((c) => c.linked && c.host && c.deployed);
  const up = usable.filter((c) => c.healthy !== false);
  const pick = up.length || local > 0 ? up : usable;
  return pick.map((c) => c.host!);
}

/** One server's share in the load balancing, from its replicas: the worst problem, unless some take traffic. */
export function serverTraffic(copies: Copy[]): { problem: CopyProblem | null; up: number; total: number; error: string | null; since: string | null } {
  const total = copies.length;
  const serving = copies.filter((c) => copyProblem(c) === null);
  const order: CopyProblem[] = ["network", "address", "deploy", "down"];
  const problem = serving.length ? null : (order.find((p) => copies.some((c) => copyProblem(c) === p)) ?? null);
  const down = copies.find((c) => c.healthy === false);
  return { problem, up: serving.length, total, error: down?.error ?? null, since: down?.since ?? null };
}

/** The next balance state after one health check of a copy, or null when nothing changed. */
export function nextBalance(state: BalanceState | null | undefined, id: string, ok: boolean, error: string | null, now: Date): BalanceState | null {
  const cur = state?.copies?.[id];
  if (cur && cur.ok === ok && (ok || cur.error === error)) return null;
  return { copies: { ...(state?.copies ?? {}), [id]: { ok, since: cur && cur.ok === ok ? cur.since : now.toISOString(), error: ok ? null : error } } };
}

export const CHECK_INTERVAL_MS = 5_000;
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
    .map((c) => `${copyId(c.serverId, c.slot)}=${c.host ?? "-"}/${c.linked ? 1 : 0}${c.deployed ? 1 : 0}/${c.healthy === false ? "down" : "up"}`)
    .sort()
    .join(",");
