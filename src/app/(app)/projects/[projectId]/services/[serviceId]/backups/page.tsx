import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { BackupsManager } from "./backups-manager";
import { getSettings } from "@/server/settings";

export const metadata = { title: "Backups" };

export default async function BackupsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/backups">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (!service.database) redirect(`/projects/${projectId}/services/${serviceId}`);
  const destinations = await db
    .select({ id: schema.s3Destination.id, name: schema.s3Destination.name, bucket: schema.s3Destination.bucket })
    .from(schema.s3Destination)
    .where(eq(schema.s3Destination.organizationId, ctx.org.id));
  return (
    <PageBody>
      <BackupsManager
        serviceId={service.id}
        isAdmin={ctx.isAdmin}
        schedule={service.database.backupSchedule ?? null}
        retention={service.database.backupRetention}
        s3DestinationId={service.database.s3DestinationId ?? null}
        destinations={destinations}
        timezone={(await getSettings()).timezone}
      />
    </PageBody>
  );
}
