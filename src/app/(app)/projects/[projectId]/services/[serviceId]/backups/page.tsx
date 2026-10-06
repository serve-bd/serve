import { and, eq, isNotNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { PageBody } from "@/components/shell/page-header";
import { BackupsManager } from "./backups-manager";
import { ComposeBackups } from "./compose-backups";
import { composeDatabases } from "@/server/backups/compose";
import { stackStorage } from "@/server/backups/storage";
import { serverOf } from "@/server/servers/context";
import { NoAccess } from "@/components/no-access";
import { getSettings } from "@/server/settings";
import { engines } from "@/server/databases/engines";
import { IMPORT_EXTENSIONS } from "@/server/backups";
import { DEFAULT_MAX_BODY_SIZE } from "@/server/proxy/config";
import { LOCAL_SERVER_ID } from "@/server/servers/context";
import { backupDatabaseChoices } from "@/server/actions/services";

export const metadata = { title: "Backups" };

export default async function BackupsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/backups">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (!service.database && service.type !== "compose" && service.type !== "app") redirect(`/projects/${projectId}/services/${serviceId}`);
  // Backups hold the database's data: only roles that may manage them see the page.
  if (!ctx.can("databases.backups")) return <NoAccess permission="databases.backups" />;
  const destinations = await db
    .select({ id: schema.s3Destination.id, name: schema.s3Destination.name, bucket: schema.s3Destination.bucket })
    .from(schema.s3Destination)
    .where(eq(schema.s3Destination.organizationId, ctx.org.id));
  const settings = await getSettings();
  if (service.type === "compose" || !service.database) {
    const databases = composeDatabases(service.compose?.content ?? "").map((d) => ({
      key: `db:${d.service}`,
      kind: "db" as const,
      name: d.service,
      detail: d.image,
      containers: [d.service],
    }));
    const server = await serverOf(service).catch(() => null);
    const storage = server
      ? (await stackStorage(server, service.id).catch(() => [])).map((m) => ({
          key: `${m.kind}:${m.source}`,
          kind: m.kind,
          name: m.source,
          detail: m.destinations.join(", "),
          containers: m.containers,
        }))
      : [];
    const configs = service.composeBackups ?? {};
    const targets = await db
      .selectDistinct({ target: schema.backup.target })
      .from(schema.backup)
      .where(and(eq(schema.backup.serviceId, service.id), isNotNull(schema.backup.target)));
    return (
      <PageBody>
        <ComposeBackups
          serviceId={service.id}
          slug={service.slug}
          stack={service.type === "compose"}
          isAdmin={ctx.isAdmin}
          running={service.status === "running"}
          configs={configs}
          orphaned={targets.map((t) => t.target as string).filter((t) => !configs[t])}
          databases={databases}
          storage={storage}
          destinations={destinations}
          timezone={settings.timezone}
        />
      </PageBody>
    );
  }
  // Uploads go through the dashboard's proxy on the server Serve runs on, with its limit.
  const [local] = settings.dashboardDomain ? await db.select({ proxyConfig: schema.server.proxyConfig }).from(schema.server).where(eq(schema.server.id, LOCAL_SERVER_ID)) : [];
  const maxUpload = settings.dashboardDomain ? local?.proxyConfig?.nginx?.maxBodySize || DEFAULT_MAX_BODY_SIZE : null;
  // The databases a backup can take, read from the running database.
  const choices = service.status === "running" ? await backupDatabaseChoices(service.id) : null;
  const databaseChoices =
    choices?.ok && choices.data.supported ? { databases: choices.data.databases, selected: choices.data.selected, main: choices.data.main, engine: service.database.engine } : null;
  return (
    <PageBody>
      <BackupsManager
        serviceId={service.id}
        isAdmin={ctx.isAdmin}
        running={service.status === "running"}
        engineLabel={engines[service.database.engine].label}
        // Plain SQL dumps carry users too (a whole-server dump): Postgres, MySQL and MariaDB.
        restoresUsers={!!engines[service.database.engine].restoreUsersCommand || ["postgres", "mysql", "mariadb"].includes(service.database.engine)}
        extensions={IMPORT_EXTENSIONS[service.database.engine]}
        maxUpload={maxUpload}
        schedule={service.database.backupSchedule ?? null}
        retention={service.database.backupRetention}
        retentionS3={service.database.backupRetentionS3 ?? null}
        keepLocal={service.database.backupLocal !== false}
        timeoutMinutes={service.database.backupTimeoutMinutes ?? null}
        lowPriority={!!service.database.backupLowPriority}
        s3DestinationId={service.database.s3DestinationId ?? null}
        destinations={destinations}
        timezone={settings.timezone}
        databaseChoices={databaseChoices}
      />
    </PageBody>
  );
}
