import type { NextRequest } from "next/server";
import { basePathFor } from "@/server/status-pages/public";
import { linkPage } from "@/server/status-pages/link-page";
import { removeSubscriber, subscriberByToken } from "@/server/status-pages/subscribers";

async function lookup(request: NextRequest, slug: string) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const found = await subscriberByToken(token);
  if (!found || found.page.slug !== slug.toLowerCase()) return null;
  return { ...found, token, base: (await basePathFor(found.page)) || "/" };
}

/** The link in the email: a page with one button (opening a link must not change anything). */
export async function GET(request: NextRequest, ctx: RouteContext<"/status/[slug]/unsubscribe">) {
  const { slug } = await ctx.params;
  const found = await lookup(request, slug);
  if (!found) return new Response("This link is not valid any more.", { status: 404 });
  return linkPage({
    page: found.page,
    title: "Unsubscribe",
    text: "You will no longer get updates of this page.",
    button: { label: "Unsubscribe", action: `${found.base === "/" ? "" : found.base}/unsubscribe?token=${encodeURIComponent(found.token)}` },
    back: found.base,
  });
}

export async function POST(request: NextRequest, ctx: RouteContext<"/status/[slug]/unsubscribe">) {
  const { slug } = await ctx.params;
  const found = await lookup(request, slug);
  if (!found) return new Response("This link is not valid any more.", { status: 404 });
  await removeSubscriber(found.subscriber.id);
  return linkPage({ page: found.page, title: "You are unsubscribed", text: "No more updates of this page will be sent to you.", back: found.base });
}
