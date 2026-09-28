import { desc, eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { StorageDestinations } from "./storage";

export const metadata = { title: "Backup storage" };

export default async function StoragePage() {
  const ctx = await requireOrg();
  const rows = await db
    .select({ id: schema.s3Destination.id, name: schema.s3Destination.name, endpoint: schema.s3Destination.endpoint, bucket: schema.s3Destination.bucket, region: schema.s3Destination.region, pathPrefix: schema.s3Destination.pathPrefix })
    .from(schema.s3Destination)
    .where(eq(schema.s3Destination.organizationId, ctx.org.id))
    .orderBy(desc(schema.s3Destination.createdAt));
  return (
    <>
      <PageHeader title="Backup storage" description="Send database backups to S3-compatible storage like AWS S3, Cloudflare R2, Backblaze B2 or MinIO." />
      <PageBody className="max-w-3xl">
        <StorageDestinations destinations={rows} isAdmin={ctx.isAdmin} />
      </PageBody>
    </>
  );
}
