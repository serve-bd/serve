import { requireOrg } from "@/server/auth";
import { deployBuckets, loadDashboard, serverCards } from "@/server/dashboard";
import { projectSummaries, recentDeployments } from "@/server/queries";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { allWidgets, widgetLimit } from "@/lib/dashboard";
import { CustomizeButton, Dashboard, DashboardProvider } from "./_components/dashboard";
import { type DashboardData, renderWidget } from "./_components/widgets";
import { listedServerIds, viewableServerIds } from "@/server/servers/access";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const ctx = await requireOrg();
  const canCreate = ctx.can("projects.manage");
  const { layout } = await loadDashboard(ctx);
  const widgets = allWidgets(layout);
  const deployCount = Math.max(0, ...widgets.filter((w) => w.type === "deploys").map(widgetLimit));
  // Days of deploy history the widgets need: the calendar's period, or 30 days for the success rate.
  const days = Math.max(0, ...widgets.map((w) => (w.type === "activity" ? (w.options.weeks ?? 26) * 7 + 7 : w.type === "glance" ? 30 : 0)));

  const [projects, deployments, buckets, servers] = await Promise.all([
    projectSummaries(ctx.org.id, ctx.projectIds),
    deployCount ? recentDeployments(ctx.org.id, deployCount, undefined, ctx.projectIds) : [],
    days ? deployBuckets(ctx.org.id, ctx.projectIds, days) : [],
    // Servers it manages, plus the ones every member sees: owned by or shared with this organization.
    Promise.all([listedServerIds(ctx), viewableServerIds(ctx)]).then(([listed, viewable]) => {
      const ids = [...new Set([...listed, ...viewable])];
      return ids.length ? serverCards(ids, new Set(listed), ctx.org.id) : [];
    }),
  ]);
  const data: DashboardData = { userName: ctx.user.name, canCreate, projects, servers, deployments, buckets };
  const nodes = Object.fromEntries(widgets.map((w) => [w.id, renderWidget(w, data) ?? null]));

  return (
    <DashboardProvider>
      <PageHeader crumb="Overview" crumbActions={<CustomizeButton />} />
      <PageBody>
        <Dashboard initial={layout} nodes={nodes} projects={projects.map((p) => ({ id: p.id, name: p.name }))} servers={servers.map((s) => ({ id: s.id, name: s.name }))} />
      </PageBody>
    </DashboardProvider>
  );
}
