import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { NoAccess } from "@/components/no-access";
import { db, schema } from "@/server/db";
import { Registries, type RegistryItem } from "./registries";

export const metadata = { title: "Registries" };

export default async function RegistriesPage() {
  const ctx = await requireOrg();
  if (!ctx.can("integrations.manage")) return <NoAccess permission="integrations.manage" />;
  const [rows, users] = await Promise.all([
    db
      .select({
        id: schema.containerRegistry.id,
        name: schema.containerRegistry.name,
        kind: schema.containerRegistry.kind,
        host: schema.containerRegistry.host,
        username: schema.containerRegistry.username,
        namespace: schema.containerRegistry.namespace,
        createdAt: schema.containerRegistry.createdAt,
      })
      .from(schema.containerRegistry)
      .where(eq(schema.containerRegistry.organizationId, ctx.org.id))
      .orderBy(desc(schema.containerRegistry.createdAt)),
    // Apps that push to a registry, with their project for links.
    db
      .select({
        id: schema.service.id,
        name: schema.service.name,
        projectId: schema.service.projectId,
        registryId: sql<string>`${schema.service.distribution}->>'registryId'`,
      })
      .from(schema.service)
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
      .where(and(eq(schema.project.organizationId, ctx.org.id), isNotNull(sql`${schema.service.distribution}->>'registryId'`))),
  ]);
  const registries: RegistryItem[] = rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    services: users.filter((u) => u.registryId === r.id).map((u) => ({ id: u.id, name: u.name, projectId: u.projectId })),
  }));
  return <Registries registries={registries} isAdmin={ctx.can("integrations.manage")} />;
}
