import { readJsonLimited } from "@/server/http-body";
import { pollCliLogin } from "@/server/cli-login";
import { sha256 } from "@/server/crypto";
import { CLI_LOGIN_INTERVAL, pollTooSoon } from "@/lib/cli-login";

export const dynamic = "force-dynamic";

const STATUS = { pending: 202, approved: 200, denied: 403, expired: 410 } as const;
const GONE = { status: "expired", error: "Unknown, used or expired sign-in. Run serve login again." };

/** When each device code last polled, in this process. */
const lastPoll = new Map<string, number>();

/** The CLI asks every few seconds whether its sign-in was approved; the token comes once. */
export async function POST(request: Request) {
  const body = (await readJsonLimited(request, 4096, {})) as { deviceCode?: unknown } | null;
  const deviceCode = typeof body?.deviceCode === "string" && body.deviceCode.length <= 200 ? body.deviceCode : "";
  if (!deviceCode) return Response.json(GONE, { status: 410 });
  const key = sha256(deviceCode);
  const now = Date.now();
  if (pollTooSoon(lastPoll.get(key), now)) {
    return Response.json(
      { status: "slow_down", error: `Poll at most every ${CLI_LOGIN_INTERVAL} seconds.`, interval: CLI_LOGIN_INTERVAL },
      { status: 429, headers: { "retry-after": String(CLI_LOGIN_INTERVAL) } },
    );
  }
  lastPoll.set(key, now);
  // Codes live 10 minutes: older entries are dropped now and then.
  if (lastPoll.size > 5000) for (const [k, t] of lastPoll) if (now - t > 15 * 60_000) lastPoll.delete(k);
  const result = await pollCliLogin(deviceCode);
  if (!result || result.status === "expired") return Response.json(GONE, { status: 410 });
  return Response.json(result, { status: STATUS[result.status], headers: { "cache-control": "no-store" } });
}
