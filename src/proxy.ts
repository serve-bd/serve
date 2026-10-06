import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { crossSiteRequest } from "@/lib/same-origin";
import { requestHost, statusSlugForHost } from "@/server/status-pages/hosts";

const PUBLIC = [
  "/login",
  "/setup",
  "/invite",
  "/forgot-password",
  "/reset-password",
  "/api/auth",
  "/api/webhooks",
  "/api/deploy-hooks",
  "/api/health",
  "/api/v1",
  "/api/branding",
  "/api/servers/join",
  "/api/agent",
  "/api/cli/login",
  "/api/gate",
  "/gate",
  "/status",
];

/** Routes that go by a token or a signature, never the session cookie (better-auth checks its own origins). */
const NOT_SESSION = ["/api/v1", "/api/webhooks", "/api/deploy-hooks", "/api/servers/join", "/api/agent", "/api/auth", "/api/github", "/api/cli/login", "/api/gate"];

/**
 * A status page's own domain shows that page and nothing else: every path goes under
 * /status/<slug>, so the dashboard (and its sign-in) is never reachable there.
 */
function statusSite(request: NextRequest, slug: string) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/_next/")) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = `/status/${slug}${pathname === "/" ? "" : pathname}`;
  return NextResponse.rewrite(url);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = requestHost(request.headers);
  const statusSlug = host ? await statusSlugForHost(host) : null;
  if (statusSlug) return statusSite(request, statusSlug);
  if (pathname.startsWith("/api/") && !NOT_SESSION.some((p) => pathname === p || pathname.startsWith(`${p}/`)) && crossSiteRequest(request, process.env.BETTER_AUTH_URL))
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  // Optimistic check only; pages verify the session for real.
  if (!getSessionCookie(request)) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const url = new URL("/login", request.url);
    // The query comes along: /cli/login?code=… must still have its code after signing in.
    if (pathname !== "/") url.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Backup and CLI uploads skip the proxy: it would buffer (and cut off) large bodies. The routes check the session or token themselves.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/services/[^/]+/backups/import|api/v1/services/[^/]+/deploy/upload|api/v1/services/[^/]+/backups/import|.*\\.(?:svg|png|jpg|ico|webp)$).*)",
  ],
};
