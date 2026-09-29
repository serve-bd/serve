import { eq } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { commandExists } from "@/server/process";
import { engines } from "@/server/databases/engines";
import { databaseCreds, databaseUrl } from "@/server/databases/options";
import { decryptOrNull } from "@/server/crypto";
import { serversForOrg } from "@/server/servers/access";
import { PageBody } from "@/components/shell/page-header";
import { ServiceSettings } from "./service-settings";

export const metadata = { title: "Settings" };

function dbProps(service: typeof schema.service.$inferSelect, isAdmin: boolean) {
  const cfg = service.database;
  if (!cfg) return null;
  const engine = engines[cfg.engine];
  const password = decryptOrNull(cfg.password) ?? "";
  const creds = databaseCreds(cfg, password);
  const check = engine.healthcheck(creds);
  return {
    config: {
      engine: cfg.engine,
      version: cfg.version,
      username: cfg.username,
      database: cfg.database,
      description: cfg.description ?? null,
      image: cfg.image ?? null,
      initdbArgs: cfg.initdbArgs ?? null,
      hostAuthMethod: cfg.hostAuthMethod ?? null,
      charset: cfg.charset ?? null,
      collation: cfg.collation ?? null,
      initScripts: cfg.initScripts ?? [],
      customConfig: cfg.customConfig ?? null,
      extraArgs: cfg.extraArgs ?? null,
      tls: cfg.tls ?? null,
      healthcheck: cfg.healthcheck ?? null,
      publicPort: cfg.publicPort ?? null,
      publicBind: cfg.publicBind ?? ("0.0.0.0" as const),
    },
    password,
    isAdmin,
    engine: {
      label: engine.label,
      image: engine.image,
      versions: engine.versions,
      port: engine.port,
      hasUser: engine.hasUser,
      hasDatabase: engine.hasDatabase,
      initScripts: engine.initScripts,
      config: { kind: engine.config.kind, placeholder: engine.config.placeholder, path: engine.config.kind === "file" ? engine.config.path : null },
      tls: !!engine.tlsArgs,
      healthcheck: (check[0] === "CMD-SHELL" ? check[1] : check.slice(1).join(" ")).replaceAll(password, "••••••"),
    },
    internalUrl: databaseUrl(cfg, creds, service.slug, engine.port),
    dataPath: cfg.dataMountPath || engine.dataPath,
    defaultDataPath: engine.dataPath,
  };
}

export default async function SettingsPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/settings">) {
  const { projectId, serviceId } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  const [credentials, nixpacks, servers, [server]] = await Promise.all([
    db
      .select({ id: schema.gitCredential.id, name: schema.gitCredential.name, provider: schema.gitCredential.provider })
      .from(schema.gitCredential)
      .where(eq(schema.gitCredential.organizationId, ctx.org.id)),
    commandExists("nixpacks"),
    serversForOrg(ctx.org.id),
    db
      .select({ id: schema.server.id, name: schema.server.name, host: schema.server.host, isLocal: schema.server.isLocal })
      .from(schema.server)
      .where(eq(schema.server.id, service.serverId)),
  ]);
  const { publicBaseUrl } = await import("@/server/git/github-app");
  const base = await publicBaseUrl();
  const source = service.source;
  const viaApp = source?.type === "git" && credentials.find((c) => c.id === source.credentialId)?.provider === "github-app";
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
          status: service.status,
        }}
        db={dbProps(service, ctx.isAdmin)}
        versions={service.database ? engines[service.database.engine].versions : []}
        credentials={credentials}
        nixpacks={nixpacks}
        webhookUrl={`${base}/api/webhooks/git/${service.id}`}
        viaGithubApp={!!viaApp}
        webhookSecret={service.webhookSecret}
        deployHookUrl={`${base}/api/deploy-hooks/${service.id}?token=${service.webhookSecret}`}
        server={server ?? { id: service.serverId, name: "Unknown server", host: "", isLocal: false }}
        servers={servers}
        isRootAdmin={ctx.isInstanceAdmin}
      />
    </PageBody>
  );
}
