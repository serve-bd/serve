import bcrypt from "bcryptjs";
import type { NextRequest } from "next/server";
import { tooManyAttempts } from "@/server/attempts";
import { unlockCookie, unlockToken } from "@/server/status-pages/access";
import { pageBySlug } from "@/server/status-pages/data";
import { basePathFor } from "@/server/status-pages/public";

/** The password form of a locked page. A right password sets a cookie for a month. */
export async function POST(request: NextRequest, ctx: RouteContext<"/status/[slug]/unlock">) {
  const { slug } = await ctx.params;
  const page = await pageBySlug(slug);
  if (page?.visibility !== "password" || !page.passwordHash) return new Response("Not found", { status: 404 });
  const base = await basePathFor(page);
  const back = (query = "") => new Response(null, { status: 303, headers: { location: `${base || "/"}${query}` } });
  const ip = request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (tooManyAttempts(`status-unlock:${page.id}:${ip}`, 10, 10 * 60_000)) return new Response("Too many tries. Wait a few minutes.", { status: 429 });
  const form = await request.formData().catch(() => null);
  const password = String(form?.get("password") ?? "");
  if (!password || !(await bcrypt.compare(password, page.passwordHash))) return back("?wrong=1");
  const res = back();
  const secure = request.headers.get("x-forwarded-proto") === "https" || request.nextUrl.protocol === "https:";
  res.headers.append(
    "set-cookie",
    `${unlockCookie(page.id)}=${unlockToken(page.id, page.passwordHash)}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
  return res;
}
