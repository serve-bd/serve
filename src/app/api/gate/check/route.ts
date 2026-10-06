import type { NextRequest } from "next/server";
import { publicBaseUrl } from "@/server/git/github-app";
import { GATE_COOKIE, GATE_KEY_HEADER, gateAllows, gateKeyValid, type Pass, verifyGate } from "@/server/gate";

/**
 * Forward auth for apps with the login wall: 204 lets the request through. Anyone else is sent to
 * sign in: a 302 (Caddy and Traefik hand it to the visitor), or a 401 with the address (r=401: nginx
 * only passes 401 on, and redirects itself).
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const serviceId = q.get("s") ?? "";
  if (gateKeyValid(serviceId, request.headers.get(GATE_KEY_HEADER))) return new Response(null, { status: 204 });
  const pass = verifyGate<Pass>(request.cookies.get(GATE_COOKIE)?.value, "c");
  if (pass?.s === serviceId && (await gateAllows(pass.u, serviceId))) return new Response(null, { status: 204 });

  // Traefik names the host in the query (a dashboard behind another proxy rewrites X-Forwarded-Host).
  const host = q.get("h") ?? request.headers.get("x-serve-host") ?? request.headers.get("x-forwarded-host") ?? "";
  let path = request.headers.get("x-serve-uri") ?? request.headers.get("x-forwarded-uri") ?? "/";
  // A dashboard behind Traefik replaces X-Forwarded-Uri with this check: back to the app's start page.
  if (path.startsWith("/api/gate/")) path = "/";
  const login = `${await publicBaseUrl()}/gate?${new URLSearchParams({ s: serviceId, h: host, p: path })}`;
  return new Response(null, { status: q.get("r") === "401" ? 401 : 302, headers: { Location: login, "Cache-Control": "no-store" } });
}
