import { ProjectSettingsPage } from "../settings-page";

export const metadata = { title: "Shared variables" };

export default async function Page(props: PageProps<"/projects/[projectId]/settings/variables">) {
  const { projectId } = await props.params;
  const { env } = await props.searchParams;
  return <ProjectSettingsPage projectId={projectId} env={env} section="variables" />;
}
