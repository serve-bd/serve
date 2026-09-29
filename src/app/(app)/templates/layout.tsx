import { requireOrg } from "@/server/auth";
import { NoAccess } from "@/components/no-access";

/** Custom templates are managed like integrations. */
export default async function TemplatesLayout({ children }: LayoutProps<"/templates">) {
  const ctx = await requireOrg();
  if (!ctx.can("integrations.manage")) return <NoAccess permission="integrations.manage" />;
  return children;
}
