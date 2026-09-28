import { eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { env } from "@/server/env";
import { commandExists } from "@/server/process";
import { engines } from "@/server/databases/engines";
import { PageBody } from "@/components/shell/page-header";
import { ServiceSettings } from "./service-settings";

export const metadata = { title: "Settings" };

export default async function SettingsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/settings">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  const [credentials, nixpacks] = await Promise.all([
    db
      .select({ id: schema.gitCredential.id, name: schema.gitCredential.name, provider: schema.gitCredential.provider })
      .from(schema.gitCredential)
      .where(eq(schema.gitCredential.organizationId, ctx.org.id)),
    commandExists("nixpacks"),
  ]);
  const base = env.appUrl.replace(/\/$/, "");
  return (
    <PageBody>
      <ServiceSettings
        projectId={projectId}
        service={{
          id: service.id,
          name: service.name,
          slug: service.slug,
          type: service.type,
          autoDeploy: service.autoDeploy,
          previewsEnabled: service.previewsEnabled,
          isPreview: !!service.parentServiceId,
          source: service.source
            ? service.source.type === "git"
              ? service.source
              : { type: "image", image: service.source.image, registryUsername: service.source.registryUsername ?? null, hasPassword: !!service.source.registryPassword }
            : null,
          build: service.build,
          runtime: service.runtime,
          compose: service.compose ? { mode: service.compose.mode, content: service.compose.content, path: service.compose.path } : null,
          database: service.database ? { engine: service.database.engine, version: service.database.version } : null,
        }}
        versions={service.database ? engines[service.database.engine].versions : []}
        credentials={credentials}
        nixpacks={nixpacks}
        webhookUrl={`${base}/api/webhooks/git/${service.id}`}
        webhookSecret={service.webhookSecret}
        deployHookUrl={`${base}/api/deploy-hooks/${service.id}?token=${service.webhookSecret}`}
      />
    </PageBody>
  );
}
