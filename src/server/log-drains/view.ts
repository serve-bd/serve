import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { organizationServices } from "./sync";

/**
 * An organization's drains as pages show them (names of secrets only), with the projects and
 * services they can pick. Without `canManage` (a service's settings, for members who do not manage
 * integrations): names and switches only. A URL can hold an API key, and the picker lists every project.
 */
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
      url: canManage ? r.url : "",
      enabled: r.enabled,
      headerName: canManage ? (secrets.header?.name ?? null) : null,
      username: canManage ? (secrets.username ?? null) : null,
      hasSecret: !!(secrets.header?.value || secrets.password),
      projectIds: r.projectIds?.length ? r.projectIds : null,
      serviceIds: r.serviceIds?.length ? r.serviceIds : null,
      index: r.options?.index ?? null,
      sourcetype: r.options?.sourcetype ?? null,
      insecure: !!r.options?.insecure,
    };
  });
  const projects = (canManage ? projectRows : []).map((p) => ({ ...p, services: services.filter((s) => s.projectId === p.id).map((s) => ({ id: s.id, name: s.name })) }));
  return { drains, projects, canManage };
}
