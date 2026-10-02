import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { crossSiteRequest } from "@/lib/same-origin";

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
];

/** Routes that go by a token or a signature, never the session cookie (better-auth checks its own origins). */
const NOT_SESSION = ["/api/v1", "/api/webhooks", "/api/deploy-hooks", "/api/servers/join", "/api/agent", "/api/auth", "/api/github"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/") && !NOT_SESSION.some((p) => pathname === p || pathname.startsWith(`${p}/`)) && crossSiteRequest(request, process.env.BETTER_AUTH_URL))
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  // Optimistic check only; pages verify the session for real.
  if (!getSessionCookie(request)) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Backup uploads skip the proxy: it would buffer (and cut off) large bodies. The route checks the session itself.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/services/[^/]+/backups/import|.*\\.(?:svg|png|jpg|ico|webp)$).*)"],
};
