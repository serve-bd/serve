import { asc, eq, inArray } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { NoAccess } from "@/components/no-access";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { REF } from "@/lib/refs";
import { SECRETS_SCOPE } from "@/lib/secret-providers";
import { SecretProviders } from "./secret-providers";

export const metadata = { title: "Secret managers" };

export default async function SecretsPage() {
  const ctx = await requireOrg();
  if (!ctx.can("integrations.manage")) return <NoAccess permission="integrations.manage" />;
  const [rows, projects] = await Promise.all([
    db
      .select({
        id: schema.secretProvider.id,
        name: schema.secretProvider.name,
        kind: schema.secretProvider.kind,
        config: schema.secretProvider.config,
        access: schema.secretProvider.access,
        createdAt: schema.secretProvider.createdAt,
      })
      .from(schema.secretProvider)
      .where(eq(schema.secretProvider.organizationId, ctx.org.id))
      .orderBy(asc(schema.secretProvider.name)),
    db.select({ id: schema.project.id, name: schema.project.name }).from(schema.project).where(eq(schema.project.organizationId, ctx.org.id)).orderBy(asc(schema.project.name)),
  ]);
  const environments = projects.length
    ? await db
        .select({ id: schema.environment.id, name: schema.environment.name, projectId: schema.environment.projectId })
        .from(schema.environment)
        .where(
          inArray(
            schema.environment.projectId,
            projects.map((p) => p.id),
          ),
        )
        .orderBy(asc(schema.environment.createdAt))
    : [];

  // Which services reference each provider, read from their (encrypted) variables.
  const used = new Map<string, { id: string; name: string; projectId: string }[]>();
  if (rows.length && projects.length) {
    const vars = await db
      .select({ value: schema.envVar.value, id: schema.service.id, name: schema.service.name, projectId: schema.service.projectId })
      .from(schema.envVar)
      .innerJoin(schema.service, eq(schema.envVar.serviceId, schema.service.id))
      .where(
        inArray(
          schema.service.projectId,
          projects.map((p) => p.id),
        ),
      );
    for (const v of vars) {
      const value = decryptOrNull(v.value) ?? "";
      for (const [, ref] of value.matchAll(REF)) {
        const m = ref.match(new RegExp(`^${SECRETS_SCOPE}\\.([^.]+)\\.`, "i"));
        if (!m) continue;
        const list = used.get(m[1].toLowerCase()) ?? [];
        if (!list.some((s) => s.id === v.id)) list.push({ id: v.id, name: v.name, projectId: v.projectId });
        used.set(m[1].toLowerCase(), list);
      }
    }
  }

  return (
    <SecretProviders
      providers={rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), usedBy: used.get(r.name) ?? [] }))}
      projects={projects.map((p) => ({ ...p, environments: environments.filter((e) => e.projectId === p.id).map((e) => ({ id: e.id, name: e.name })) }))}
    />
  );
}
