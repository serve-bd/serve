import { instanceAdminPage } from "@/server/auth";
import { asc, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { effectiveLimits, orgUsage } from "@/server/limits";
import { getSettings } from "@/server/settings";
import { OrgLimitsView } from "./org-limits";

export const metadata = { title: "Organizations" };

export default async function OrganizationsSettingsPage() {
  await instanceAdminPage();
  const [settings, orgs, rows, servers] = await Promise.all([
    getSettings(),
    db
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        members: sql<number>`(select count(*)::int from member m where m.organization_id = "organization"."id")`,
      })
      .from(schema.organization)
      .orderBy(asc(schema.organization.createdAt)),
    db.select({ organizationId: schema.organizationLimit.organizationId, custom: schema.organizationLimit.custom }).from(schema.organizationLimit),
    db.select({ id: schema.server.id, name: schema.server.name }).from(schema.server).orderBy(asc(schema.server.createdAt)),
  ]);
  const list = await Promise.all(
    orgs.map(async (o) => {
      const limits = await effectiveLimits(o.id);
      return {
        ...o,
        root: o.id === settings.rootOrganizationId,
        custom: !!rows.find((r) => r.organizationId === o.id)?.custom,
        limits,
        usage: await orgUsage(o.id, limits),
      };
    }),
  );
  return <OrgLimitsView orgs={list} defaults={settings.defaultOrgLimits ?? {}} servers={servers} />;
}
