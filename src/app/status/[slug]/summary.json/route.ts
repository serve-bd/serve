import { designOf, labelsOf } from "@/lib/status-page";
import { statusView } from "@/server/status-pages/data";
import { publicPage } from "@/server/status-pages/public";

export const dynamic = "force-dynamic";

/** The page as JSON, for scripts and other dashboards. Same rules as the page: a locked page asks for its password first. */
export async function GET(_request: Request, ctx: RouteContext<"/status/[slug]/summary.json">) {
  const { slug } = await ctx.params;
  const found = await publicPage(slug);
  if (!found) return Response.json({ error: "Not found" }, { status: 404 });
  if (found.access === "locked") return Response.json({ error: "This status page needs a password." }, { status: 401 });
  const design = designOf(found.page.design);
  const view = await statusView(found.page, found.base, design);
  const w = labelsOf(design);
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
    postmortem: n.postmortem,
  });
  return Response.json(
    {
      page: { name: view.name, updatedAt: view.generatedAt },
      status: { level: view.overall, description: w[`overall.${view.overall}`] },
      components: view.groups.flatMap((g) =>
        g.components.map((c) => ({ id: c.id, name: c.name, group: g.name, status: c.level, description: w[`level.${c.level}`], uptime: c.uptime })),
      ),
      ongoing: view.active.map(notice),
      planned: view.upcoming.map(notice),
    },
    { headers: { "cache-control": "no-store", "access-control-allow-origin": found.page.visibility === "public" ? "*" : "null" } },
  );
}
