import { referenceName } from "@/lib/refs";
import { NoAccess } from "@/components/no-access";
import { and, eq, isNull } from "drizzle-orm";
import { privateHost } from "@/lib/hostname";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { pageService } from "@/server/services/access";
import { commandExists } from "@/server/process";
import { engines } from "@/server/databases/engines";
import { databaseCreds, databaseUrl } from "@/server/databases/options";
import { decryptOrNull } from "@/server/crypto";
import { serversForOrg } from "@/server/servers/access";
import { traefikBehindProxy } from "@/server/proxy/trusted-proxies";
import { notFound } from "next/navigation";
import { ServiceSettings } from "../service-settings";
import { settingsNav } from "../settings-nav";
import { monitorSummary } from "@/server/monitoring/queries";
import { monitorUrl } from "@/server/monitoring/checks";
import { normalizeDistribution } from "@/server/deploy/distribution";
import { buildsImage, replicaInstances } from "@/server/services/types";
import { meshMemberIds, privatelyConnected } from "@/server/mesh/members";

export async function generateMetadata(props: PageProps<"/projects/[projectId]/services/[serviceId]/settings/[section]">) {
  const { section } = await props.params;
  const label = section.charAt(0).toUpperCase() + section.slice(1).replace(/-/g, " ");
  return { title: `${label} · Settings` };
}

function dbProps(service: typeof schema.service.$inferSelect, isAdmin: boolean, hideSecrets: boolean, replicaServers: { id: string; name: string; home: boolean }[]) {
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
      pooler: cfg.pooler ? { enabled: cfg.pooler.enabled, mode: cfg.pooler.mode, poolSize: cfg.pooler.poolSize, maxClients: cfg.pooler.maxClients } : null,
      replica: cfg.replica ? { enabled: cfg.replica.enabled, instances: replicaInstances(service) } : null,
    },
    password: hideSecrets ? "" : password,
    hideSecrets,
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
      healthcheck: password
        ? (check[0] === "CMD-SHELL" ? check[1] : check.slice(1).join(" ")).replaceAll(password, "••••••")
        : check[0] === "CMD-SHELL"
          ? check[1]
          : check.slice(1).join(" "),
    },
    // The connection URL carries the password: masked for roles that may not see secrets.
    internalUrl: databaseUrl(cfg, hideSecrets ? databaseCreds(cfg, "********") : creds, privateHost(service), engine.port),
    refName: referenceName(service.name),
    replicaServers,
    poolerUrl: databaseUrl(cfg, hideSecrets ? databaseCreds(cfg, "********") : creds, `${privateHost(service)}-pooler`, engine.port),
    replicaUrl: databaseUrl(cfg, hideSecrets ? databaseCreds(cfg, "********") : creds, `${privateHost(service)}-replica`, engine.port),
    dataPath: cfg.dataMountPath || engine.dataPath,
    defaultDataPath: engine.dataPath,
  };
}

async function distributionProps(service: typeof schema.service.$inferSelect, servers: Awaited<ReturnType<typeof serversForOrg>>, orgId: string, isAdmin: boolean) {
  const [registries, [last]] = await Promise.all([
    db
      .select({
        id: schema.containerRegistry.id,
        name: schema.containerRegistry.name,
        host: schema.containerRegistry.host,
        namespace: schema.containerRegistry.namespace,
        username: schema.containerRegistry.username,
      })
      .from(schema.containerRegistry)
      .where(eq(schema.containerRegistry.organizationId, orgId)),
    service.currentDeploymentId
      ? db
          .select({ deploymentId: schema.deployment.id, targets: schema.deployment.targets, registryImage: schema.deployment.registryImage })
          .from(schema.deployment)
          .where(eq(schema.deployment.id, service.currentDeploymentId))
      : Promise.resolve([]),
  ]);
  return {
    // Built images (git and Dockerfile sources) can come from a build server and a registry.
    gitSource: buildsImage(service.source?.type),
    servers: servers.map((s) => ({ id: s.id, name: s.name, status: s.status, isLocal: s.isLocal })),
    registries,
    initial: normalizeDistribution(service.serverId, service.distribution),
    last: last ?? null,
    canEdit: isAdmin && !service.parentServiceId,
  };
}

export default async function SettingsSectionPage(props: PageProps<"/projects/[projectId]/services/[serviceId]/settings/[section]">) {
  const { projectId, serviceId, section } = await props.params;
  const ctx = await requireOrg();
  const { service } = await pageService(serviceId, projectId, ctx.org.id);
  if (!ctx.can("services.manage")) return <NoAccess permission="services.manage" />;
  const [credentials, nixpacks, servers, [server], [environment], imageRegistries] = await Promise.all([
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
    db.select({ name: schema.environment.name }).from(schema.environment).where(eq(schema.environment.id, service.environmentId)),
    service.source?.type === "image"
      ? db
          .select({ id: schema.containerRegistry.id, name: schema.containerRegistry.name, host: schema.containerRegistry.host })
          .from(schema.containerRegistry)
          .where(eq(schema.containerRegistry.organizationId, ctx.org.id))
      : Promise.resolve([]),
  ]);
  const { preferHttps, publicBaseUrl } = await import("@/server/git/github-app");
  const base = await preferHttps(await publicBaseUrl());
  const source = service.source;
  const credProvider = source?.type === "git" ? credentials.find((c) => c.id === source.credentialId)?.provider : undefined;
  const viaApp = credProvider === "github-app";
  const managedWebhook = credProvider === "github" || credProvider === "gitlab" || credProvider === "gitea" || credProvider === "bitbucket";
  const hideSecrets = !ctx.can("variables.view-secrets");
  // A replica runs on the database's server or one linked to it privately.
  const members = service.database?.engine === "postgres" ? await meshMemberIds() : null;
  const replicaServers = members
    ? servers.filter((s) => privatelyConnected(members, service.serverId, s.id)).map((s) => ({ id: s.id, name: s.name, home: s.id === service.serverId }))
    : [];
  const database = dbProps(service, ctx.isAdmin, hideSecrets, replicaServers);
  const nav = settingsNav({
    type: service.type,
    hasSource: !!service.source,
    gitSource: service.source?.type === "git",
    hasBuild: !!service.build,
    hasCompose: !!service.compose,
    previews: service.type === "app" && service.source?.type === "git" && !service.parentServiceId,
    db: database ? { engine: database.config.engine, initScripts: !!database.engine.initScripts, tls: database.engine.tls } : null,
  });
  if (!nav.some((n) => n.id === section)) notFound();
  // Maintenance mode changes what visitors get, so saving it needs deploy rights.
  if (section === "maintenance" && !ctx.can("services.deploy")) return <NoAccess permission="services.deploy" />;
  return (
    <ServiceSettings
      projectId={projectId}
      environmentName={environment?.name ?? "production"}
      service={{
        id: service.id,
        name: service.name,
        slug: service.slug,
        hostname: service.hostname,
        type: service.type,
        autoDeploy: service.autoDeploy,
        previewsEnabled: service.previewsEnabled,
        previewDomain: service.previewDomain,
        isPreview: !!service.parentServiceId,
        source: service.source
          ? service.source.type === "git" || service.source.type === "dockerfile"
            ? service.source
            : {
                type: "image",
                image: service.source.image,
                registryId: service.source.registryId ?? null,
                registryUsername: service.source.registryUsername ?? null,
                hasPassword: !!service.source.registryPassword,
              }
          : null,
        build: service.build,
        runtime: service.runtime,
        compose: service.compose ? { mode: service.compose.mode, content: service.compose.content, path: service.compose.path, isolated: !!service.compose.isolated } : null,
        database: service.database ? { engine: service.database.engine, version: service.database.version } : null,
        status: service.status,
      }}
      db={database}
      section={section}
      versions={service.database ? engines[service.database.engine].versions : []}
      credentials={credentials}
      imageRegistries={imageRegistries}
      nixpacks={nixpacks}
      webhookUrl={`${base}/api/webhooks/git/${service.id}`}
      viaGithubApp={!!viaApp}
      managedWebhook={managedWebhook && !service.parentServiceId}
      webhookSecret={hideSecrets ? "" : service.webhookSecret}
      deployHookUrl={`${base}/api/deploy-hooks/${service.id}?token=${hideSecrets ? "********" : service.webhookSecret}`}
      hideSecrets={hideSecrets}
      server={server ?? { id: service.serverId, name: "Unknown server", host: "", isLocal: false }}
      servers={servers}
      // Host paths and privileges: Root admins, for services of the Root organization.
      isRootAdmin={ctx.isInstanceAdmin && ctx.isRoot}
      maintenance={
        section === "maintenance"
          ? {
              config: service.maintenance ?? null,
              domains: (await db.select({ hostname: schema.domain.hostname }).from(schema.domain).where(eq(schema.domain.serviceId, service.id))).map((d) => d.hostname),
              traefikBehindProxy: await traefikBehindProxy(service.serverId),
            }
          : undefined
      }
      previewDatabase={
        section === "previews" && service.type === "app" && service.source?.type === "git" && !service.parentServiceId
          ? {
              config: service.previewDatabase ?? null,
              previewVars: Object.keys(service.previewVars ?? {}),
              databases: (
                await db
                  .select({ id: schema.service.id, name: schema.service.name, database: schema.service.database })
                  .from(schema.service)
                  .where(and(eq(schema.service.environmentId, service.environmentId), eq(schema.service.type, "database"), isNull(schema.service.parentServiceId)))
              ).map((d) => ({ id: d.id, name: d.name, engine: d.database?.engine ?? "", label: d.database ? engines[d.database.engine].label : "" })),
            }
          : undefined
      }
      monitoring={
        section === "monitoring" ? { monitor: (await monitorSummary(service.id)).monitor, defaultUrl: await monitorUrl({ url: null, path: "/" }, service.id) } : undefined
      }
      distribution={section === "servers" ? await distributionProps(service, servers, ctx.org.id, ctx.isAdmin) : undefined}
    />
  );
}
