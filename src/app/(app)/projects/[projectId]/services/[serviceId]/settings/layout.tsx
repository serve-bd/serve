import { PageBody } from "@/components/shell/page-header";

/** The sections list lives in the service's menu (under Settings); each section is its own page. */
export default async function SettingsLayout(props: LayoutProps<"/projects/[projectId]/services/[serviceId]/settings">) {
  return <PageBody>{props.children}</PageBody>;
}
