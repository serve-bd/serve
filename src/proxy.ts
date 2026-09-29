import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

const PUBLIC = ["/login", "/setup", "/invite", "/api/auth", "/api/webhooks", "/api/deploy-hooks", "/api/health", "/api/v1"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
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
