import Link from "next/link";
import { eq } from "drizzle-orm";
import { AlertTriangle } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { effectiveLimits, orgUsage } from "@/server/limits";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Card, CardBody, CardHeader, TimeAgo } from "@/components/ui/misc";
import { UsageBars } from "@/components/usage-bars";
import { hasAnyLimit, limitCatalog, usageLevel } from "@/lib/limits";
import { cn } from "@/lib/utils";

export const metadata = { title: "Usage" };

export default async function UsagePage() {
  const ctx = await requireOrg();
  const limits = await effectiveLimits(ctx.org.id);
  const [usage, [row]] = await Promise.all([
    orgUsage(ctx.org.id, limits),
    db.select({ diskMeasuredAt: schema.organizationLimit.diskMeasuredAt }).from(schema.organizationLimit).where(eq(schema.organizationLimit.organizationId, ctx.org.id)),
  ]);
  const levels = limitCatalog.map((l) => ({ ...l, level: usageLevel(usage[l.key], limits[l.key]) }));
  const full = levels.filter((l) => l.level === "full" && l.key !== "concurrentBuilds");
  const warn = levels.filter((l) => l.level === "warn");
  const limited = hasAnyLimit(limits);

  return (
    <>
      <PageHeader title="Usage" description={`What ${ctx.org.name} uses, and the limits set for it.`} />
      <PageBody className="flex flex-col gap-6">
        {(full.length > 0 || warn.length > 0) && (
          <div className={cn("flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px]", full.length ? "border-bad/30 bg-bad-soft" : "border-warn/30 bg-warn-soft")}>
            <AlertTriangle className={cn("mt-0.5 size-4 flex-none", full.length ? "text-bad" : "text-warn")} />
            <p className="text-fg-2">
              {full.length ? (
                <>
                  <span className="font-medium text-fg">Limit reached: {full.map((l) => l.label.toLowerCase()).join(", ")}.</span> New ones are refused until something is removed
                  or an administrator raises the limit.
                </>
              ) : (
                <>
                  <span className="font-medium text-fg">Close to a limit: {warn.map((l) => l.label.toLowerCase()).join(", ")}.</span> More than 80 % is in use.
                </>
              )}
            </p>
          </div>
        )}
        <Card>
          <CardHeader
            title="Limits"
            description={limited ? "Set by the administrators of this instance." : "This organization has no limits. The numbers show what it uses."}
            actions={
              ctx.isInstanceAdmin && (
                <Link href="/settings/organizations" className="text-[13px] font-medium text-accent hover:underline">
                  Manage limits
                </Link>
              )
            }
          />
          <CardBody className="py-5">
            <UsageBars usage={usage} limits={limits} />
          </CardBody>
        </Card>
        <p className="text-xs text-faint">
          Services without their own CPU or memory limit count as {limits.defaultCpu ?? 0.5} cores and {limits.defaultMemory ?? 512} MB when those limits apply.
          {row?.diskMeasuredAt ? (
            <>
              {" "}
              Volume sizes measured <TimeAgo date={row.diskMeasuredAt} />.
            </>
          ) : (
            " Volume sizes are measured every half hour."
          )}
        </p>
      </PageBody>
    </>
  );
}
