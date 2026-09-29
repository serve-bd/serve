import Link from "next/link";
import { Activity } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { recentActivity } from "@/server/queries";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Avatar, Card, EmptyState, TimeAgo } from "@/components/ui/misc";

export const metadata = { title: "Activity" };

export default async function ActivityPage() {
  const ctx = await requireOrg();
  const items = await recentActivity(ctx.org.id, 200);
  return (
    <>
      <PageHeader title="Activity" description="An audit trail of changes made in this organization." />
      <PageBody>
        <Card className="overflow-hidden">
          {items.length === 0 ? (
            <EmptyState icon={<Activity />} title="No activity yet" />
          ) : (
            <ol className="divide-y divide-line">
              {items.map((a) => {
                const href = a.targetType === "service" && a.projectId && a.targetId ? `/projects/${a.projectId}/services/${a.targetId}` : a.projectId ? `/projects/${a.projectId}` : null;
                const body = (
                  <div className="flex items-center gap-3 px-5 py-3">
                    <Avatar name={a.userName ?? "System"} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] text-fg-2">{a.message}</span>
                      <span className="text-xs text-faint">{a.userName ?? "System"}</span>
                    </div>
                    <TimeAgo date={a.createdAt} className="text-xs text-faint" />
                  </div>
                );
                return <li key={a.id}>{href ? <Link href={href} className="block transition-colors hover:bg-hover/40">{body}</Link> : body}</li>;
              })}
            </ol>
          )}
        </Card>
      </PageBody>
    </>
  );
}
