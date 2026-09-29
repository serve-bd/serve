import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { StorageDestinations, type Dest } from "./storage";

export const metadata = { title: "S3 storage" };

export default async function StoragePage() {
  const ctx = await requireOrg();
  const [rows, databases] = await Promise.all([
    db
      .select({
        id: schema.s3Destination.id,
        name: schema.s3Destination.name,
        endpoint: schema.s3Destination.endpoint,
        bucket: schema.s3Destination.bucket,
        region: schema.s3Destination.region,
        pathPrefix: schema.s3Destination.pathPrefix,
        accessKeyId: schema.s3Destination.accessKeyId,
        createdAt: schema.s3Destination.createdAt,
      })
      .from(schema.s3Destination)
      .where(eq(schema.s3Destination.organizationId, ctx.org.id))
      .orderBy(desc(schema.s3Destination.createdAt)),
    // Databases that send backups somewhere, with the project for links.
    db
      .select({ id: schema.service.id, name: schema.service.name, projectId: schema.service.projectId, dest: sql<string>`${schema.service.database}->>'s3DestinationId'` })
      .from(schema.service)
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
      .where(and(eq(schema.project.organizationId, ctx.org.id), isNotNull(sql`${schema.service.database}->>'s3DestinationId'`))),
  ]);
  const uploads = databases.length
    ? await db
        .select({
          serviceId: schema.backup.serviceId,
          last: sql<Date | null>`max(${schema.backup.finishedAt})`,
          count: sql<number>`count(*)::int`,
          bytes: sql<number>`coalesce(sum(${schema.backup.size}), 0)::float`,
        })
        .from(schema.backup)
        .where(
          and(
            inArray(
              schema.backup.serviceId,
              databases.map((d) => d.id),
            ),
            eq(schema.backup.s3Status, "uploaded"),
          ),
        )
        .groupBy(schema.backup.serviceId)
    : [];
  const destinations: Dest[] = rows.map((r) => {
    const users = databases.filter((d) => d.dest === r.id);
    const stats = uploads.filter((u) => users.some((d) => d.id === u.serviceId));
    const last = stats.map((s) => (s.last ? new Date(s.last).getTime() : 0)).reduce((a, b) => Math.max(a, b), 0);
    return {
      ...r,
      accessKeyId: `${r.accessKeyId.slice(0, 4)}…${r.accessKeyId.slice(-4)}`,
      createdAt: r.createdAt.toISOString(),
      databases: users.map((d) => ({ id: d.id, name: d.name, projectId: d.projectId })),
      backups: stats.reduce((a, s) => a + s.count, 0),
      bytes: stats.reduce((a, s) => a + Number(s.bytes), 0),
      lastUpload: last ? new Date(last).toISOString() : null,
    };
  });
  return <StorageDestinations destinations={destinations} isAdmin={ctx.isAdmin} />;
}
