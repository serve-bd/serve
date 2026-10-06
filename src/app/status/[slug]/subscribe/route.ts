import type { NextRequest } from "next/server";
import { UserError } from "@/server/action";
import { tooManyAttempts } from "@/server/attempts";
import { pageBySlug } from "@/server/status-pages/data";
import { subscribe } from "@/server/status-pages/subscribers";
import { db, schema } from "@/server/db";
import { eq } from "drizzle-orm";

/** A visitor subscribes from the page's Subscribe dialog. */
export async function POST(request: NextRequest, ctx: RouteContext<"/status/[slug]/subscribe">) {
  const { slug } = await ctx.params;
  const found = await pageBySlug(slug);
  if (found?.visibility !== "public") return Response.json({ error: "Not found" }, { status: 404 });
  const ip = request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  // Each email costs a send and each webhook a test request: a few per visitor and hour.
  if (tooManyAttempts(`status-subscribe:${found.id}:${ip}`, 8, 60 * 60_000)) return Response.json({ error: "Too many tries. Wait a while and try again." }, { status: 429 });
  const body = (await request.json().catch(() => null)) as { kind?: string; target?: string; componentIds?: string[] } | null;
  if (!body) return Response.json({ error: "Send the form again." }, { status: 400 });
  const [page] = await db.select().from(schema.statusPage).where(eq(schema.statusPage.id, found.id));
  try {
    const result = await subscribe(page, { kind: body.kind ?? "", target: body.target ?? "", componentIds: Array.isArray(body.componentIds) ? body.componentIds.map(String) : [] });
    return Response.json(result);
  } catch (e) {
    if (e instanceof UserError) return Response.json({ error: e.message }, { status: 400 });
    // An email that could not be sent, a bad input shape: said plainly, never a stack.
    const message = (e as Error).message ?? "";
    return Response.json(
      { error: /email/i.test(message) ? "The email could not be sent. Try again later." : "That did not work. Check the address and try again." },
      { status: 400 },
    );
  }
}
