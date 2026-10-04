import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import * as actions from "@/server/actions/services";
import { deploymentView, domainView, loadDomain, loadService, page, projectFilter, serviceView } from "../data";
import { ApiError, type ApiRoute, assertCan, route, unwrap } from "../router";

const id = z.string().min(1);
const listQuery = z.object({
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  type: z.enum(["app", "database", "compose"]).optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
});

const variable = z.object({
  key: z.string().max(200),
  value: z.string().max(256 * 1024),
  buildTime: z.boolean().default(true),
  runtime: z.boolean().default(true),
});

const source = z
  .looseObject({ type: z.enum(["git", "image", "dockerfile"]) })
  .describe('Where the code comes from: {type:"git", repository, branch, credentialId?}, {type:"image", image, registryId?} or {type:"dockerfile", dockerfile}.');

const createBody = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("app"),
    projectId: id,
    environmentId: id,
    name: z.string(),
    source,
    build: z
      .looseObject({})
      .optional()
      .describe("builder (auto, dockerfile, nixpacks, railpack, buildpacks, static), buildpacksBuilder, dockerfilePath, context, buildCommand, startCommand, ..."),
    port: z.number().int().optional(),
    envVars: z.array(variable).optional(),
    serverId: z.string().nullable().optional(),
    deploy: z.boolean().optional(),
  }),
  z.looseObject({
    type: z.literal("database"),
    projectId: id,
    environmentId: id,
    name: z.string(),
    engine: z.enum(["postgres", "mysql", "mariadb", "mongodb", "redis", "valkey", "clickhouse"]),
    version: z.string().optional(),
    username: z.string().optional(),
    database: z.string().optional(),
    password: z.string().optional(),
    serverId: z.string().nullable().optional(),
    deploy: z.boolean().optional(),
  }),
  z.looseObject({
    type: z.literal("compose"),
    projectId: id,
    environmentId: id,
    name: z.string(),
    mode: z.enum(["inline", "git"]).default("inline"),
    content: z.string().optional().describe("The compose file, for mode inline without a template."),
    template: z.string().optional().describe("A template id from GET /templates; its compose file is used."),
    vars: z.record(z.string(), z.string()).optional().describe("Template values; missing ones are generated."),
    source: z.looseObject({ repository: z.string(), branch: z.string().optional() }).optional(),
    path: z.string().optional(),
    serverId: z.string().nullable().optional(),
    deploy: z.boolean().optional(),
  }),
]);

/** Variables as stored, values shown only with variables.view-secrets. */
async function variablesOf(serviceId: string, withValues: boolean) {
  const rows = await db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, serviceId)).orderBy(asc(schema.envVar.key));
  return rows.map((r) => ({ key: r.key, ...(withValues ? { value: decryptOrNull(r.value) ?? "" } : {}), buildTime: r.buildTime, runtime: r.runtime }));
}

export const serviceRoutes: ApiRoute[] = [
  route({
    method: "GET",
    path: "/services",
    tag: "Services",
    summary: "List services",
    description: "Services of every project the token may reach. Filter with projectId, environmentId and type.",
    needs: ["projects.view"],
    query: listQuery,
    handler: async ({ auth, query }) => {
      const { limit, offset } = page(query);
      const rows = await db
        .select({ service: schema.service, project: schema.project })
        .from(schema.service)
        .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
        .where(
          and(
            eq(schema.project.organizationId, auth.organizationId),
            projectFilter(auth),
            query.projectId ? eq(schema.service.projectId, query.projectId) : undefined,
            query.environmentId ? eq(schema.service.environmentId, query.environmentId) : undefined,
            query.type ? eq(schema.service.type, query.type) : undefined,
          ),
        )
        .orderBy(asc(schema.project.name), asc(schema.service.name))
        .limit(limit)
        .offset(offset);
      return { services: rows.map((r) => serviceView(r.service, r.project)) };
    },
  }),
  route({
    method: "POST",
    path: "/services",
    tag: "Services",
    summary: "Create a service",
    description:
      "Create an app (from Git, an image or a Dockerfile), a database or a Docker Compose stack (inline, from Git, or from a template). The fields are the ones the dashboard's create forms send. With deploy: true it deploys right away.",
    needs: ["services.manage"],
    body: createBody,
    status: 201,
    handler: async ({ body }) => {
      const { type, ...input } = body;
      const result =
        type === "app"
          ? await unwrap(actions.createAppService(input as never))
          : type === "database"
            ? await unwrap(actions.createDatabaseService(input as never))
            : await unwrap(actions.createComposeService(input as never));
      return result;
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}",
    tag: "Services",
    summary: "Get a service",
    description: "The service with its settings, domains and variable names.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      const { service, project } = await loadService(auth, params.serviceId);
      const [domains, vars] = await Promise.all([
        db.select().from(schema.domain).where(eq(schema.domain.serviceId, service.id)),
        db.select({ key: schema.envVar.key }).from(schema.envVar).where(eq(schema.envVar.serviceId, service.id)).orderBy(asc(schema.envVar.key)),
      ]);
      return {
        service: {
          ...serviceView(service, project),
          domains: domains.map((d) => `${d.https || d.tunnelId ? "https" : "http"}://${d.hostname}`),
          variables: vars.map((v) => v.key),
        },
      };
    },
  }),
  route({
    method: "PATCH",
    path: "/services/{serviceId}",
    tag: "Services",
    summary: "Change a service",
    description:
      "Change settings: name, hostname, autoDeploy, previewsEnabled, previewDomain, source, build, runtime (port, replicas, healthcheck, resources, volumes, ports, restart policy, ...), as the service's settings pages send them. Only the given fields change.",
    needs: ["services.manage"],
    body: z.looseObject({}),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      await unwrap(actions.updateService(params.serviceId, body as never));
      const { service, project } = await loadService(auth, params.serviceId);
      return { service: serviceView(service, project) };
    },
  }),
  route({
    method: "DELETE",
    path: "/services/{serviceId}",
    tag: "Services",
    summary: "Delete a service",
    description: "Stops and removes the service. ?volumes=true also deletes its data volumes.",
    needs: ["services.manage"],
    query: z.object({ volumes: z.enum(["true", "false"]).optional() }),
    handler: async ({ auth, params, query }) => {
      await loadService(auth, params.serviceId);
      await unwrap(actions.deleteService(params.serviceId, query.volumes === "true"));
      return { ok: true };
    },
  }),

  // Deploying and running
  route({
    method: "POST",
    path: "/services/{serviceId}/deploy",
    tag: "Deployments",
    summary: "Deploy a service",
    description: "Deploys the latest commit or image. noCache: true builds without the build cache.",
    needs: ["services.deploy"],
    body: z.object({ noCache: z.boolean().optional() }),
    status: 202,
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      const r = await unwrap(body.noCache ? actions.deployWithoutCache(params.serviceId) : actions.deployService(params.serviceId));
      const deploymentId = (r as { id?: string } | null)?.id ?? null;
      return { deploymentId };
    },
  }),
  ...(["start", "stop", "restart"] as const).map((command) =>
    route({
      method: "POST",
      path: `/services/{serviceId}/${command}`,
      tag: "Services",
      summary: `${command[0].toUpperCase()}${command.slice(1)} a service`,
      needs: ["services.deploy"],
      status: 202,
      handler: async ({ auth, params }) => {
        await loadService(auth, params.serviceId);
        const r = await unwrap(actions.serviceControl(params.serviceId, command));
        return { ok: true, ...(r && typeof r === "object" ? r : {}) };
      },
    }),
  ),
  route({
    method: "POST",
    path: "/services/{serviceId}/containers/{containerId}/restart",
    tag: "Services",
    summary: "Restart one container",
    needs: ["services.deploy"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      await unwrap(actions.restartContainer(params.serviceId, params.containerId));
      return { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/move",
    tag: "Services",
    summary: "Move a service to another server",
    needs: ["services.manage"],
    body: z.object({ serverId: id, force: z.boolean().optional() }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return (await unwrap(actions.moveService(params.serviceId, body.serverId, { force: body.force }))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/webhook-secret",
    tag: "Services",
    summary: "Make a new deploy webhook secret",
    description: "The old secret stops working. The answer holds the new deploy hook URL secret.",
    needs: ["services.manage"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      return (await unwrap(actions.regenerateWebhookSecret(params.serviceId))) ?? { ok: true };
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/compose",
    tag: "Services",
    summary: "The compose file as deployed",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      return { compose: await unwrap(actions.deployedCompose(params.serviceId)) };
    },
  }),
  route({
    method: "DELETE",
    path: "/previews/{previewId}",
    tag: "Services",
    summary: "Remove a pull request preview",
    needs: ["services.manage"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.previewId);
      await unwrap(actions.removePreviewService(params.previewId));
      return { ok: true };
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/pull-requests",
    tag: "Services",
    summary: "List the repository's open pull requests",
    description: "Read from the git provider, with the preview each one has (previewId). Needs preview deployments on.",
    needs: ["services.deploy"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      return { pullRequests: await unwrap(actions.listOpenPullRequests(params.serviceId)) };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/pull-requests/{number}/preview",
    tag: "Services",
    summary: "Deploy the preview of an open pull request",
    description: "For pull requests opened before previews were on, or to deploy one again. Pull requests from forks are refused.",
    needs: ["services.deploy"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      return unwrap(actions.deployPullRequestPreview(params.serviceId, Number(params.number)));
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/previews",
    tag: "Services",
    summary: "Deploy a preview of an image app",
    description: "Runs another tag (or a sha256 digest) of the app's image as the preview numbered pr. The same number again deploys the new tag to that preview.",
    needs: ["services.deploy"],
    body: z.object({ pr: z.number().int().min(1), tag: z.string().min(1).max(200) }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return unwrap(actions.deployImagePreview(params.serviceId, body));
    },
  }),

  // Deployments
  route({
    method: "GET",
    path: "/services/{serviceId}/deployments",
    tag: "Deployments",
    summary: "List deployments of a service",
    description: "Newest first.",
    needs: ["projects.view"],
    query: z.object({ limit: z.coerce.number().int().optional(), offset: z.coerce.number().int().optional() }),
    handler: async ({ auth, params, query }) => {
      await loadService(auth, params.serviceId);
      const { limit, offset } = page(query);
      const rows = await db
        .select()
        .from(schema.deployment)
        .where(eq(schema.deployment.serviceId, params.serviceId))
        .orderBy(desc(schema.deployment.createdAt))
        .limit(limit)
        .offset(offset);
      return { deployments: rows.map((d) => deploymentView(d)) };
    },
  }),

  // Variables
  route({
    method: "GET",
    path: "/services/{serviceId}/variables",
    tag: "Variables",
    summary: "List variables",
    description: "Names and flags. Values are included when the token has variables.view-secrets.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      return { variables: await variablesOf(params.serviceId, auth.can("variables.view-secrets")) };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/variables",
    tag: "Variables",
    summary: "Replace all variables",
    description: "The list becomes the service's variables; variables not in it are removed. redeploy: true deploys after saving.",
    needs: ["variables.edit"],
    body: z.object({ variables: z.array(variable).max(500), redeploy: z.boolean().default(false) }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      if (body.redeploy) assertCan(auth, "services.deploy");
      return unwrap(actions.saveEnvVars(params.serviceId, body.variables, body.redeploy));
    },
  }),
  route({
    method: "PATCH",
    path: "/services/{serviceId}/variables",
    tag: "Variables",
    summary: "Set or remove some variables",
    description: 'Keys to set, and null to remove one: {"variables": {"API_URL": "https://...", "OLD": null}}. Other variables stay as they are.',
    needs: ["variables.edit"],
    body: z.object({
      variables: z.record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "Invalid variable name"),
        z
          .string()
          .max(256 * 1024)
          .nullable(),
      ),
      redeploy: z.boolean().default(false),
    }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      if (body.redeploy) assertCan(auth, "services.deploy");
      const stored = await db.select().from(schema.envVar).where(eq(schema.envVar.serviceId, params.serviceId));
      const changes = body.variables;
      const next = stored
        .filter((v) => !(v.key in changes))
        .map((v) => ({ key: v.key, value: "", keep: v.key, buildTime: v.buildTime, runtime: v.runtime }))
        .concat(
          Object.entries(changes)
            .filter(([, value]) => value !== null)
            .map(([key, value]) => {
              const prev = stored.find((v) => v.key === key);
              return { key, value: value as string, keep: undefined as unknown as string, buildTime: prev?.buildTime ?? true, runtime: prev?.runtime ?? true };
            }),
        )
        .map(({ keep, ...v }) => (keep ? { ...v, keep } : v));
      const r = await unwrap(actions.saveEnvVars(params.serviceId, next, body.redeploy));
      return { ok: true, deploymentId: r?.deploymentId ?? null };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/replicas/{replica}/variables",
    tag: "Variables",
    summary: "Set the variables of one replica",
    description: "Variables only replica N (1, 2, ...) gets, on top of the service's. An empty list removes them.",
    needs: ["variables.edit"],
    body: z.object({ variables: z.array(z.object({ key: z.string(), value: z.string() })).max(500), redeploy: z.boolean().default(false) }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      if (body.redeploy) assertCan(auth, "services.deploy");
      return (await unwrap(actions.saveReplicaVars(params.serviceId, Number(params.replica), body.variables, body.redeploy))) ?? { ok: true };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/preview-variables",
    tag: "Variables",
    summary: "Set the variables pull request previews use",
    description: "They replace the service's variables of the same name in its previews.",
    needs: ["variables.edit"],
    body: z.object({ variables: z.array(z.object({ key: z.string(), value: z.string() })).max(500) }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      await unwrap(actions.savePreviewVars(params.serviceId, body.variables));
      return { ok: true };
    },
  }),

  // The first API's variable endpoints, kept for scripts that use them.
  route({
    method: "GET",
    path: "/services/{serviceId}/env",
    tag: "Variables",
    summary: "Variable values as one object (older form)",
    description: 'Answers {"variables": {"KEY": "value"}}. GET /services/{serviceId}/variables gives the flags too.',
    needs: ["projects.view", "variables.view-secrets"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      return { variables: Object.fromEntries((await variablesOf(params.serviceId, true)).map((v) => [v.key, v.value])) };
    },
  }),
  route({
    method: "PATCH",
    path: "/services/{serviceId}/env",
    tag: "Variables",
    summary: "Set or remove some variables (older form)",
    description: "The same as PATCH /services/{serviceId}/variables.",
    needs: ["variables.edit"],
    body: z.object({ variables: z.record(z.string(), z.string().nullable()), redeploy: z.boolean().default(false) }),
    handler: async (c) => {
      const patch = serviceRoutes.find((r) => r.method === "PATCH" && r.path === "/services/{serviceId}/variables")!;
      return patch.handler(c);
    },
  }),

  // Domains
  route({
    method: "GET",
    path: "/services/{serviceId}/domains",
    tag: "Domains",
    summary: "List domains of a service",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      const rows = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, params.serviceId)).orderBy(asc(schema.domain.hostname));
      return { domains: rows.map(domainView) };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/domains",
    tag: "Domains",
    summary: "Add a domain",
    description: "HTTPS with a free certificate by default. cloudflare: {accountId, zoneId, proxied, createRecord} also creates the DNS record.",
    needs: ["domains.manage"],
    body: z.looseObject({
      hostname: z.string(),
      port: z.number().int().nullable().optional(),
      composeService: z.string().nullable().optional(),
      https: z.boolean().optional(),
      forceHttps: z.boolean().optional(),
      redirectTo: z.string().nullable().optional(),
      certificateId: z.string().nullable().optional(),
      tunnelId: z.string().nullable().optional(),
      cloudflare: z.looseObject({ accountId: z.string(), zoneId: z.string(), proxied: z.boolean(), createRecord: z.boolean() }).nullable().optional(),
    }),
    status: 201,
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return (await unwrap(actions.addDomain(params.serviceId, body as never))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/domains/generate",
    tag: "Domains",
    summary: "Add a generated domain",
    description: "A free address on the server's wildcard domain or sslip.io.",
    needs: ["domains.manage"],
    status: 201,
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      return (await unwrap(actions.generateDomain(params.serviceId))) ?? { ok: true };
    },
  }),
  route({
    method: "PATCH",
    path: "/domains/{domainId}",
    tag: "Domains",
    summary: "Change a domain",
    description: "port, composeService, https, forceHttps, redirectTo, certificateId. primary: true makes it the main domain; tunnelId (or null) changes how it is reached.",
    needs: ["domains.manage"],
    body: z.looseObject({ primary: z.literal(true).optional(), tunnelId: z.string().nullable().optional() }),
    handler: async ({ auth, params, body }) => {
      const before = await loadDomain(auth, params.domainId);
      const { primary, tunnelId, ...rest } = body as { primary?: true; tunnelId?: string | null } & Record<string, unknown>;
      if (Object.keys(rest).length) await unwrap(actions.updateDomain(params.domainId, rest as never));
      if (primary) await unwrap(actions.setPrimaryDomain(params.domainId));
      if (tunnelId !== undefined && tunnelId !== before.tunnelId) await unwrap(actions.setDomainRoute(params.domainId, tunnelId));
      return { domain: domainView(await loadDomain(auth, params.domainId)) };
    },
  }),
  route({
    method: "DELETE",
    path: "/domains/{domainId}",
    tag: "Domains",
    summary: "Remove a domain",
    description: "?dns=true also deletes the DNS record Serve made for it.",
    needs: ["domains.manage"],
    query: z.object({ dns: z.enum(["true", "false"]).optional() }),
    handler: async ({ auth, params, query }) => {
      await loadDomain(auth, params.domainId);
      await unwrap(actions.removeDomain(params.domainId, query.dns === "true"));
      return { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/domains/{domainId}/check-dns",
    tag: "Domains",
    summary: "Check where a domain's DNS points",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await loadDomain(auth, params.domainId);
      return { dns: await unwrap(actions.checkDomainDns(params.domainId)) };
    },
  }),
  route({
    method: "POST",
    path: "/domains/{domainId}/retry-certificate",
    tag: "Domains",
    summary: "Try the certificate of a domain again",
    needs: ["domains.manage"],
    handler: async ({ auth, params }) => {
      await loadDomain(auth, params.domainId);
      return (await unwrap(actions.retryCertificate(params.domainId))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/domains/{domainId}/reconnect-tunnel",
    tag: "Domains",
    summary: "Route a domain through its tunnel again",
    needs: ["domains.manage"],
    handler: async ({ auth, params }) => {
      await loadDomain(auth, params.domainId);
      return (await unwrap(actions.reconnectDomainTunnel(params.domainId))) ?? { ok: true };
    },
  }),

  // Backups (databases, and compose stacks with backups)
  route({
    method: "GET",
    path: "/services/{serviceId}/backups",
    tag: "Backups",
    summary: "List backups",
    needs: ["databases.backups"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      const rows = await db.select().from(schema.backup).where(eq(schema.backup.serviceId, params.serviceId)).orderBy(desc(schema.backup.createdAt)).limit(200);
      return {
        backups: rows.map((b) => ({
          id: b.id,
          status: b.status,
          trigger: b.trigger,
          target: b.target,
          databases: b.databases,
          filename: b.filename,
          size: b.size,
          destination: b.destination,
          error: b.error,
          restoreStatus: b.restoreStatus,
          restoredAt: b.restoredAt?.toISOString() ?? null,
          createdAt: b.createdAt.toISOString(),
          finishedAt: b.finishedAt?.toISOString() ?? null,
        })),
      };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/backups",
    tag: "Backups",
    summary: "Back up now",
    description: `target picks a compose service's backup (see the stack's backup settings). databases (a database service): the databases of the server to take, or ["*"] for every one, new ones included; without it the service's choice (database.backupDatabases) or the main database.`,
    needs: ["databases.backups"],
    body: z.object({ target: z.string().nullable().optional(), databases: z.array(z.string()).optional() }),
    status: 202,
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return (await unwrap(actions.createBackup(params.serviceId, body.target ?? null, { databases: body.databases }))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/backups/{backupId}/restore",
    tag: "Backups",
    summary: "Restore a backup",
    description: "backupFirst: true backs up the current data first. users: true also restores database users and roles.",
    needs: ["databases.backups"],
    body: z.object({ backupFirst: z.boolean().optional(), users: z.boolean().optional() }),
    status: 202,
    handler: async ({ params, body }) => (await unwrap(actions.restoreFromBackup(params.backupId, body))) ?? { ok: true },
  }),
  route({
    method: "DELETE",
    path: "/backups/{backupId}",
    tag: "Backups",
    summary: "Delete a backup",
    needs: ["databases.backups"],
    handler: async ({ params }) => {
      await unwrap(actions.deleteBackup(params.backupId));
      return { ok: true };
    },
  }),

  // Logs
  route({
    method: "GET",
    path: "/services/{serviceId}/logs",
    tag: "Logs",
    summary: "Recent container logs",
    description: "The last lines of each running container of the service (tail, 10-5000, default 200).",
    needs: ["logs.view"],
    query: z.object({ tail: z.coerce.number().int().min(10).max(5000).default(200), container: z.string().optional() }),
    handler: async ({ auth, params, query }) => {
      const { service } = await loadService(auth, params.serviceId);
      const { serverOf } = await import("@/server/servers/context");
      const { LABEL, listServiceContainers, demuxDockerBuffer } = await import("@/server/docker/client");
      let docker: Awaited<ReturnType<typeof serverOf>>["docker"];
      try {
        docker = (await serverOf(service)).docker;
      } catch (e) {
        throw new ApiError(503, `The server of this service is unreachable: ${(e as Error).message}`);
      }
      const all = await listServiceContainers(service.id, true, docker);
      const current = service.type === "app" && service.currentDeploymentId ? all.filter((c) => c.Labels[LABEL.deployment] === service.currentDeploymentId) : all;
      const containers = query.container ? current.filter((c) => c.Labels["com.docker.compose.service"] === query.container || c.Id.startsWith(query.container!)) : current;
      const out = [];
      for (const c of containers) {
        const buf = await docker
          .getContainer(c.Id)
          .logs({ stdout: true, stderr: true, tail: query.tail, timestamps: true })
          .catch(() => null);
        out.push({
          id: c.Id.slice(0, 12),
          name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
          state: c.State,
          lines: buf
            ? demuxDockerBuffer(buf as unknown as Buffer)
                .split("\n")
                .filter(Boolean)
            : [],
        });
      }
      return { containers: out };
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/containers",
    tag: "Services",
    summary: "List containers",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      const { service } = await loadService(auth, params.serviceId);
      const { serverOf } = await import("@/server/servers/context");
      const { listServiceContainers } = await import("@/server/docker/client");
      const docker = (
        await serverOf(service).catch((e) => {
          throw new ApiError(503, `The server of this service is unreachable: ${(e as Error).message}`);
        })
      ).docker;
      const rows = await listServiceContainers(service.id, true, docker);
      return {
        containers: rows.map((c) => ({
          id: c.Id.slice(0, 12),
          name: c.Names[0]?.replace(/^\//, ""),
          image: c.Image,
          state: c.State,
          status: c.Status,
          deploymentId: c.Labels["serve.deployment"] ?? null,
          composeService: c.Labels["com.docker.compose.service"] ?? null,
          createdAt: new Date(c.Created * 1000).toISOString(),
        })),
      };
    },
  }),
];
