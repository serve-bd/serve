import { CLI_LOGIN_INTERVAL, CLI_LOGIN_TTL } from "@/lib/cli-login";
import { readJsonLimited } from "@/server/http-body";
import { startCliLogin } from "@/server/cli-login";
import { takeRequest } from "@/server/api/rate-limit";
import { dashboardVisitorIp } from "@/server/proxy/trusted-proxies";

export const dynamic = "force-dynamic";

/** Sign-ins one address may start per minute. */
const STARTS_PER_MINUTE = 10;

/**
 * `serve login` starts here (no token yet). Answers the secret device code the CLI polls with,
 * and the short code and page where someone signed in approves it.
 */
export async function POST(request: Request) {
  const ip = await dashboardVisitorIp(request.headers);
  const rate = takeRequest(`cli-login:${ip ?? "unknown"}`, STARTS_PER_MINUTE);
  if (!rate.allowed) return Response.json({ error: "Too many sign-ins from this address. Try again in a minute." }, { status: 429, headers: rate.headers });
  const body = (await readJsonLimited(request, 4096, {})) as { client?: unknown; version?: unknown } | null;
  const { deviceCode, userCode } = await startCliLogin({ client: body?.client, version: body?.version, ip });
  const { publicBaseUrl } = await import("@/server/git/github-app");
  const base = (await publicBaseUrl().catch(() => "")) || new URL(request.url).origin;
  return Response.json(
    { deviceCode, userCode, verifyUrl: `${base}/cli/login?code=${userCode}`, interval: CLI_LOGIN_INTERVAL, expiresIn: CLI_LOGIN_TTL },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}
