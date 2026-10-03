import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { organizationServices } from "./sync";

/** An organization's drains as pages show them (names of secrets only), with the projects and services they can pick. */
export async function logDrainsProps(organizationId: string, canManage: boolean) {
  const [rows, projectRows, services] = await Promise.all([
    db.select().from(schema.logDrain).where(eq(schema.logDrain.organizationId, organizationId)).orderBy(desc(schema.logDrain.createdAt)),
    db.select({ id: schema.project.id, name: schema.project.name }).from(schema.project).where(eq(schema.project.organizationId, organizationId)).orderBy(asc(schema.project.name)),
    organizationServices(organizationId),
  ]);
  const drains = rows.map((r) => {
    // Names only: header values and passwords never leave the server.
    const secrets = JSON.parse(decryptOrNull(r.secrets) ?? "{}") as { header?: { name: string; value: string }; username?: string; password?: string };
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      url: r.url,
      enabled: r.enabled,
      headerName: secrets.header?.name ?? null,
      username: secrets.username ?? null,
      hasSecret: !!(secrets.header?.value || secrets.password),
      projectIds: r.projectIds?.length ? r.projectIds : null,
      serviceIds: r.serviceIds?.length ? r.serviceIds : null,
      index: r.options?.index ?? null,
      sourcetype: r.options?.sourcetype ?? null,
    };
  });
  const projects = projectRows.map((p) => ({ ...p, services: services.filter((s) => s.projectId === p.id).map((s) => ({ id: s.id, name: s.name })) }));
  return { drains, projects, canManage };
}
