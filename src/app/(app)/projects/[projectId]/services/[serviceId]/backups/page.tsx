import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { BackupsManager } from "./backups-manager";
import { NoAccess } from "@/components/no-access";
import { getSettings } from "@/server/settings";
import { engines } from "@/server/databases/engines";
import { IMPORT_EXTENSIONS } from "@/server/backups";
import { DEFAULT_MAX_BODY_SIZE } from "@/server/proxy/config";
import { LOCAL_SERVER_ID } from "@/server/servers/context";

export const metadata = { title: "Backups" };

export default async function BackupsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/backups">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (!service.database) redirect(`/projects/${projectId}/services/${serviceId}`);
  // Backups hold the database's data: only roles that may manage them see the page.
  if (!ctx.can("databases.backups")) return <NoAccess permission="databases.backups" />;
  const destinations = await db
    .select({ id: schema.s3Destination.id, name: schema.s3Destination.name, bucket: schema.s3Destination.bucket })
    .from(schema.s3Destination)
    .where(eq(schema.s3Destination.organizationId, ctx.org.id));
  const settings = await getSettings();
  // Uploads go through the dashboard's proxy on the server Serve runs on, with its limit.
  const [local] = settings.dashboardDomain ? await db.select({ proxyConfig: schema.server.proxyConfig }).from(schema.server).where(eq(schema.server.id, LOCAL_SERVER_ID)) : [];
  const maxUpload = settings.dashboardDomain ? local?.proxyConfig?.nginx?.maxBodySize || DEFAULT_MAX_BODY_SIZE : null;
  return (
    <PageBody>
      <BackupsManager
        serviceId={service.id}
        isAdmin={ctx.isAdmin}
        running={service.status === "running"}
        engineLabel={engines[service.database.engine].label}
        extensions={IMPORT_EXTENSIONS[service.database.engine]}
        maxUpload={maxUpload}
        schedule={service.database.backupSchedule ?? null}
        retention={service.database.backupRetention}
        retentionS3={service.database.backupRetentionS3 ?? null}
        s3DestinationId={service.database.s3DestinationId ?? null}
        destinations={destinations}
        timezone={settings.timezone}
      />
    </PageBody>
  );
}
