import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { getSettings } from "@/server/settings";
import { InstanceBackups } from "./instance-backups";

export const metadata = { title: "Backups" };

export default async function InstanceBackupsPage() {
  const s = await getSettings();
  const destinations = s.rootOrganizationId
    ? await db
        .select({ id: schema.s3Destination.id, name: schema.s3Destination.name, bucket: schema.s3Destination.bucket })
        .from(schema.s3Destination)
        .where(eq(schema.s3Destination.organizationId, s.rootOrganizationId))
    : [];
  return (
    <InstanceBackups
      settings={{ schedule: s.instanceBackupSchedule, retention: s.instanceBackupRetention, s3DestinationId: s.instanceBackupS3DestinationId }}
      backups={s.instanceBackups}
      destinations={destinations}
      timezone={s.timezone}
    />
  );
}
