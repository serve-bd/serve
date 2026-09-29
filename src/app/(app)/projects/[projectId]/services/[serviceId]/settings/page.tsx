import { SettingsRedirect } from "./settings-redirect";

export const metadata = { title: "Settings" };

/** /settings opens General; old /settings#section links open that section. */
export default async function SettingsIndex(props: PageProps<"/projects/[projectId]/services/[serviceId]/settings">) {
  const { projectId, serviceId } = await props.params;
  return <SettingsRedirect base={`/projects/${projectId}/services/${serviceId}/settings`} />;
}
