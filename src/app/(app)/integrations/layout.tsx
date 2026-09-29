import { requireOrg } from "@/server/auth";
import { NoAccess } from "@/components/no-access";

/** Integrations hold the organization's credentials; only roles that manage them see these pages. */
export default async function IntegrationsLayout({ children }: LayoutProps<"/integrations">) {
  const ctx = await requireOrg();
  if (!ctx.can("integrations.manage")) return <NoAccess permission="integrations.manage" />;
  return children;
}
