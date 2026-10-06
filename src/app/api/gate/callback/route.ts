import type { NextRequest } from "next/server";
import { GATE_COOKIE, PASS_S, signGate, type Ticket, verifyGate } from "@/server/gate";

/** Reached through the app's own host (GATE_PATH): the ticket from the sign-in becomes a cookie there. */
export async function GET(request: NextRequest) {
  const t = verifyGate<Ticket>(request.nextUrl.searchParams.get("t"), "t");
  if (!t) return new Response("This sign-in link has expired. Open the app again.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const pass = signGate({ k: "c", u: t.u, s: t.s });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${t.x ? "https" : "http"}://${t.h}${t.p}`,
      "Set-Cookie": `${GATE_COOKIE}=${pass}; Path=/; Max-Age=${PASS_S}; HttpOnly; SameSite=Lax${t.x ? "; Secure" : ""}`,
      "Cache-Control": "no-store",
    },
  });
}
