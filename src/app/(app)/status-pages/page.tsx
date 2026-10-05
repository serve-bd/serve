import { RadioTower } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { orgStatusPages } from "@/server/status-pages/admin";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Card, EmptyState } from "@/components/ui/misc";
import { NewStatusPageButton, StatusPageList } from "./status-page-list";

export const metadata = { title: "Status pages" };

export default async function StatusPagesPage() {
  const ctx = await requireOrg();
  const pages = await orgStatusPages(ctx.org.id);
  const canManage = ctx.can("status-pages.manage") && !ctx.projectIds;
  return (
    <>
      <PageHeader
        title="Status pages"
        description="Public pages that show visitors how your services are doing, with incidents and planned maintenance."
        actions={canManage && pages.length > 0 ? <NewStatusPageButton /> : undefined}
      />
      <PageBody>
        {pages.length === 0 ? (
          <Card>
            <EmptyState
              icon={<RadioTower />}
              title="No status pages yet"
              description={
                canManage
                  ? "Create one: it starts with your services that have an uptime check, as a draft only your team can see."
                  : "Members who manage status pages can create one here."
              }
              action={canManage ? <NewStatusPageButton /> : undefined}
            />
          </Card>
        ) : (
          <StatusPageList pages={pages} canManage={canManage} />
        )}
      </PageBody>
    </>
  );
}
