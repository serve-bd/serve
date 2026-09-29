import { eq } from "drizzle-orm";
import { privateHost } from "@/lib/hostname";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { commandExists } from "@/server/process";
import { engines } from "@/server/databases/engines";
import { databaseCreds, databaseUrl } from "@/server/databases/options";
import { decryptOrNull } from "@/server/crypto";
import { serversForOrg } from "@/server/servers/access";
import { PageBody } from "@/components/shell/page-header";
import { notFound } from "next/navigation";
import { ServiceSettings } from "../service-settings";
import { settingsNav } from "../settings-nav";
import { monitorSummary } from "@/server/monitoring/queries";
import { monitorUrl } from "@/server/monitoring/checks";

export async function generateMetadata(props: PageProps<"/projects/[projectId]/services/[serviceId]/settings/[section]">) {
  const { section } = await props.params;
  const label = section.charAt(0).toUpperCase() + section.slice(1).replace(/-/g, " ");
  return { title: `${label} · Settings` };
}

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
    internalUrl: databaseUrl(cfg, creds, privateHost(service), engine.port),
    dataPath: cfg.dataMountPath || engine.dataPath,
    defaultDataPath: engine.dataPath,
  };
}

export default async function SettingsSectionPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/settings/[section]">) {
  const { projectId, serviceId, section } = await props.params;
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
  const credProvider = source?.type === "git" ? credentials.find((c) => c.id === source.credentialId)?.provider : undefined;
  const viaApp = credProvider === "github-app";
  const managedWebhook = credProvider === "github" || credProvider === "gitlab" || credProvider === "gitea" || credProvider === "bitbucket";
  const database = dbProps(service, ctx.isAdmin);
  const nav = settingsNav({
    type: service.type,
    hasSource: !!service.source,
    gitSource: service.source?.type === "git",
    hasBuild: !!service.build,
    hasCompose: !!service.compose,
    db: database ? { engine: database.config.engine, initScripts: !!database.engine.initScripts, tls: database.engine.tls } : null,
  });
  if (!nav.some((n) => n.id === section)) notFound();
  return (
    <PageBody>
      <ServiceSettings
        projectId={projectId}
        service={{
          id: service.id,
          name: service.name,
          slug: service.slug,
          hostname: service.hostname,
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
          compose: service.compose ? { mode: service.compose.mode, content: service.compose.content, path: service.compose.path, isolated: !!service.compose.isolated } : null,
          database: service.database ? { engine: service.database.engine, version: service.database.version } : null,
          status: service.status,
        }}
        db={database}
        section={section}
        nav={nav}
        versions={service.database ? engines[service.database.engine].versions : []}
        credentials={credentials}
        nixpacks={nixpacks}
        webhookUrl={`${base}/api/webhooks/git/${service.id}`}
        viaGithubApp={!!viaApp}
        managedWebhook={managedWebhook && !service.parentServiceId}
        webhookSecret={service.webhookSecret}
        deployHookUrl={`${base}/api/deploy-hooks/${service.id}?token=${service.webhookSecret}`}
        server={server ?? { id: service.serverId, name: "Unknown server", host: "", isLocal: false }}
        servers={servers}
        isRootAdmin={ctx.isInstanceAdmin}
        monitoring={
          section === "monitoring" ? { monitor: (await monitorSummary(service.id)).monitor, defaultUrl: await monitorUrl({ url: null, path: "/" }, service.id) } : undefined
        }
      />
    </PageBody>
  );
}
