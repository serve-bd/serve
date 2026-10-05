import { designOf, LEVEL_TEXT, OVERALL_TEXT } from "@/lib/status-page";
import { statusView } from "@/server/status-pages/data";
import { publicPage } from "@/server/status-pages/public";

export const dynamic = "force-dynamic";

/** The page as JSON, for scripts and other dashboards. Same rules as the page: a locked page asks for its password first. */
export async function GET(_request: Request, ctx: RouteContext<"/status/[slug]/summary.json">) {
  const { slug } = await ctx.params;
  const found = await publicPage(slug);
  if (!found) return Response.json({ error: "Not found" }, { status: 404 });
  if (found.access === "locked") return Response.json({ error: "This status page needs a password." }, { status: 401 });
  const view = await statusView(found.page, found.base, designOf(found.page.design));
  const notice = (n: (typeof view.active)[number]) => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    state: n.state,
    impact: n.impact,
    components: n.components,
    startsAt: n.startsAt,
    endsAt: n.endsAt,
    resolvedAt: n.resolvedAt,
    updates: n.updates,
  });
  return Response.json(
    {
      page: { name: view.name, updatedAt: view.generatedAt },
      status: { level: view.overall, description: OVERALL_TEXT[view.overall] },
      components: view.groups.flatMap((g) =>
        g.components.map((c) => ({ id: c.id, name: c.name, group: g.name, status: c.level, description: LEVEL_TEXT[c.level], uptime: c.uptime })),
      ),
      ongoing: view.active.map(notice),
      planned: view.upcoming.map(notice),
    },
    { headers: { "cache-control": "no-store", "access-control-allow-origin": found.page.visibility === "public" ? "*" : "null" } },
  );
}
