import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { getSetting, updateSettings } from "@/server/settings";
import type { ServerCtx } from "@/server/servers/context";
import { allTrusted, clientIpFrom, normalizeTrustedRanges, type VisitorIp } from "@/lib/trusted-proxies";
import { trustedSubnets } from "./model";

/**
 * Cloudflare's proxy ranges as published when this release was made. The worker refreshes them
 * daily from Cloudflare's API; this list is used until the first refresh succeeds.
 */
export const CLOUDFLARE_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

const CLOUDFLARE_IPS_URL = "https://api.cloudflare.com/client/v4/ips";

export async function cloudflareRanges() {
  const saved = await getSetting("cloudflareRanges");
  return saved?.ranges.length ? saved.ranges : CLOUDFLARE_RANGES;
}

export async function visitorIpOf(ctx: ServerCtx): Promise<VisitorIp> {
  const [tunnel, [row]] = await Promise.all([trustedSubnets(ctx), db.select({ trusted: schema.server.trustedProxies }).from(schema.server).where(eq(schema.server.id, ctx.id))]);
  const t = row?.trusted;
  if (!t) return { tunnel, ranges: [], header: null };
  return { tunnel, ranges: [...new Set([...t.ranges, ...(t.cloudflare ? await cloudflareRanges() : [])])], header: t.header };
}

const REFRESH_EVERY = 24 * 3600_000;

/**
 * Fetch Cloudflare's current ranges once a day and store them. True when they differ from the
 * ones in use. A failure keeps the last list (and is retried on the next call).
 */
export async function refreshCloudflareRanges() {
  const saved = await getSetting("cloudflareRanges");
  if (saved && Date.now() - Date.parse(saved.checkedAt) < REFRESH_EVERY) return false;
  const res = await fetch(CLOUDFLARE_IPS_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Cloudflare answered ${res.status}`);
  const body = (await res.json()) as { success?: boolean; result?: { ipv4_cidrs?: string[]; ipv6_cidrs?: string[] } };
  const v4 = body.result?.ipv4_cidrs ?? [];
  const v6 = body.result?.ipv6_cidrs ?? [];
  const parsed = normalizeTrustedRanges([...v4, ...v6]);
  if (!body.success || !v4.length || !v6.length || "error" in parsed) throw new Error("Cloudflare returned an unexpected list of IP ranges");
  const previous = await cloudflareRanges();
  await updateSettings({ cloudflareRanges: { ranges: parsed.ranges, checkedAt: new Date().toISOString() } });
  return [...previous].sort().join() !== [...parsed.ranges].sort().join();
}

let localTrusted: { at: number; ranges: Promise<string[]> } | null = null;

/** Trusted ranges of the dashboard's proxy, cached for a minute (read on every sign-in). */
function dashboardTrusted() {
  if (!localTrusted || Date.now() - localTrusted.at > 60_000) {
    const ranges = import("@/server/servers/context")
      .then(({ getServer }) => getServer(LOCAL_SERVER_ID))
      .then(visitorIpOf)
      .then(allTrusted)
      .catch(() => []);
    localTrusted = { at: Date.now(), ranges };
  }
  return localTrusted.ranges;
}

/** After a change of the local server's trusted proxies. */
export function forgetDashboardTrusted() {
  localTrusted = null;
}

/** The visitor's address as the dashboard's proxy resolved it, from the request headers it forwarded. */
export async function dashboardVisitorIp(headers: Pick<Headers, "get"> | undefined) {
  const forwarded = headers?.get("x-forwarded-for");
  if (!forwarded) return headers?.get("x-real-ip") || null;
  return clientIpFrom(forwarded, await dashboardTrusted());
}
