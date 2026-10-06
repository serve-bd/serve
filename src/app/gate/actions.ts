"use server";

import { headers } from "next/headers";
import { tooManyAttempts } from "@/server/attempts";
import { guestTicket } from "@/server/gate";
import { dashboardVisitorIp } from "@/server/proxy/trusted-proxies";
import { safeNextPath } from "@/lib/safe-next";

/** A guest's sign-in on the login wall: where to go next, or what went wrong. */
export async function guestSignIn(input: { s: string; h: string; p: string; email: string; password: string }): Promise<{ url: string } | { error: string }> {
  const ip = (await dashboardVisitorIp(await headers())) || "unknown";
  if (tooManyAttempts(`gate:${input.s}:${ip}`, 10, 15 * 60_000)) return { error: "Too many tries. Wait 15 minutes, then try again." };
  const ticket = await guestTicket(input.s, input.h, safeNextPath(input.p), input.email, input.password);
  return ticket ?? { error: "Wrong email or password." };
}
