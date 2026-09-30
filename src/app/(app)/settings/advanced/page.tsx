import { instanceAdminPage } from "@/server/auth";
import { asc, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { AdvancedSettings } from "./advanced-settings";
import { CleanupPolicy } from "./cleanup-policy";

export const metadata = { title: "Advanced" };

export default async function AdvancedSettingsPage() {
  await instanceAdminPage();
  const [s, orgs] = await Promise.all([
    getSettings(),
    db
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        createdAt: schema.organization.createdAt,
        members: sql<number>`(select count(*)::int from member m where m.organization_id = "organization"."id")`,
        projects: sql<number>`(select count(*)::int from project p where p.organization_id = "organization"."id")`,
      })
      .from(schema.organization)
      .orderBy(asc(schema.organization.createdAt)),
  ]);
  return (
    <>
      <AdvancedSettings
        orgSettings={{ allowOrganizationCreation: s.allowOrganizationCreation }}
        organizations={orgs.map((o) => ({ ...o, createdAt: o.createdAt.toISOString(), isRoot: o.id === s.rootOrganizationId }))}
      />
      <CleanupPolicy
        latest={s.lastCleanup}
        settings={{
          cleanupEnabled: s.cleanupEnabled,
          cleanupIntervalHours: s.cleanupIntervalHours,
          cleanupDiskThreshold: s.cleanupDiskThreshold,
          cleanupBuildCacheDays: s.cleanupBuildCacheDays,
          cleanupUnusedImages: s.cleanupUnusedImages,
        }}
      />
    </>
  );
}
