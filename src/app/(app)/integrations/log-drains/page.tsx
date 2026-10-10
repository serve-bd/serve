import { NoAccess } from "@/components/no-access";
import { requireOrg } from "@/server/auth";
import { logDrainsProps } from "@/server/log-drains/view";
import { LogDrains } from "./log-drains";

export const metadata = { title: "Log drains" };

export default async function LogDrainsPage() {
  const ctx = await requireOrg();
  // Drains cover every project: members limited to some projects do not manage them.
  if (ctx.projectIds) return <NoAccess permission="integrations.manage" />;
  const { drains, projects } = await logDrainsProps(ctx.org.id, true);
  return <LogDrains drains={drains} projects={projects} />;
}
