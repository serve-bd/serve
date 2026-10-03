import { asc, desc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { LogDrains } from "./log-drains";

export const metadata = { title: "Log drains" };

export default async function LogDrainsPage() {
  const ctx = await requireOrg();
  const [rows, projects] = await Promise.all([
    db.select().from(schema.logDrain).where(eq(schema.logDrain.organizationId, ctx.org.id)).orderBy(desc(schema.logDrain.createdAt)),
    db.select({ id: schema.project.id, name: schema.project.name }).from(schema.project).where(eq(schema.project.organizationId, ctx.org.id)).orderBy(asc(schema.project.name)),
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
    };
  });
  return <LogDrains drains={drains} projects={projects} />;
}
