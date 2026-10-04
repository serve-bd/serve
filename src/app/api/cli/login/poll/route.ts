import { readJsonLimited } from "@/server/http-body";
import { pollCliLogin } from "@/server/cli-login";
import { sha256 } from "@/server/crypto";
import { takeRequest } from "@/server/api/rate-limit";
import { dashboardVisitorIp } from "@/server/proxy/trusted-proxies";
import { CLI_LOGIN_INTERVAL, CLI_POLLS_PER_MINUTE, pollTooSoon, sweepPolls } from "@/lib/cli-login";

export const dynamic = "force-dynamic";

const STATUS = { pending: 202, approved: 200, denied: 403, expired: 410 } as const;
const GONE = { status: "expired", error: "Unknown, used or expired sign-in. Run serve login again." };

/** When each known device code last polled, in this process. */
const lastPoll = new Map<string, number>();
let lastSweep = 0;

const slowDown = () =>
  Response.json(
    { status: "slow_down", error: `Poll at most every ${CLI_LOGIN_INTERVAL} seconds.`, interval: CLI_LOGIN_INTERVAL },
    { status: 429, headers: { "retry-after": String(CLI_LOGIN_INTERVAL) } },
  );

/** The CLI asks every few seconds whether its sign-in was approved; the token comes once. */
export async function POST(request: Request) {
  // Each poll costs a database lookup: one address may only poll so often.
  const ip = await dashboardVisitorIp(request.headers);
  if (!takeRequest(`cli-poll:${ip ?? "unknown"}`, CLI_POLLS_PER_MINUTE).allowed) return slowDown();
  const body = (await readJsonLimited(request, 4096, {})) as { deviceCode?: unknown } | null;
  const deviceCode = typeof body?.deviceCode === "string" && body.deviceCode.length <= 200 ? body.deviceCode : "";
  if (!deviceCode) return Response.json(GONE, { status: 410 });
  const key = sha256(deviceCode);
  const now = Date.now();
  if (pollTooSoon(lastPoll.get(key), now)) return slowDown();
  // Codes live 10 minutes: older entries are dropped once a minute.
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    sweepPolls(lastPoll, now);
  }
  const result = await pollCliLogin(deviceCode);
  if (!result || result.status === "expired") return Response.json(GONE, { status: 410 });
  // Only codes that wait are remembered, so made-up ones cannot fill the map.
  if (result.status === "pending") lastPoll.set(key, now);
  else lastPoll.delete(key);
  return Response.json(result, { status: STATUS[result.status], headers: { "cache-control": "no-store" } });
}
