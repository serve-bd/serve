import { requireOrg } from "@/server/auth";
import { pageProject } from "@/server/services/access";
import { PageHeader } from "@/components/shell/page-header";
import { SectionNav } from "@/components/shell/section-nav";

export default async function ProjectSettingsLayout({ children, params }: LayoutProps<"/projects/[projectId]/settings">) {
  const { projectId } = await params;
  const ctx = await requireOrg();
  const project = await pageProject(projectId, ctx.org.id);
  const base = `/projects/${project.id}/settings`;
  return (
    <>
      <PageHeader
        title="Project settings"
        breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${project.id}` }, { label: "Settings" }]}
      />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 pt-4 pb-16 sm:px-8 lg:flex-row lg:gap-10 lg:pt-6">
        <SectionNav
          groups={[
            {
              items: [
                { href: base, label: "General", icon: "Settings2", exact: true },
                { href: `${base}/variables`, label: "Shared variables", icon: "Variable" },
                { href: `${base}/environments`, label: "Environments", icon: "Layers3" },
              ],
            },
          ]}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </>
  );
}
