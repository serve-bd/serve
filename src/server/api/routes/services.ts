import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@/server/id";
import { dockerSince } from "@/lib/log-offset";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import * as actions from "@/server/actions/services";
import * as tagActions from "@/server/actions/tags";
import * as dbActions from "@/server/actions/databases";
import { setServiceApproval } from "@/server/actions/deploy-rules";
import * as serviceProxy from "@/server/actions/service-proxy";
import { saveComposeMounts } from "@/server/actions/compose-storage";
import { savePreviewDatabase } from "@/server/actions/environments";
import * as monitoring from "@/server/actions/monitoring";
import { setMainServer } from "@/server/actions/main-server";
import { balancingOf, type ProxyInput, proxyFormInitial, proxyInputSchema, type ServiceProxyConfig } from "@/server/services/proxy-config";
import { readComposeMounts } from "@/lib/compose-mounts";
import { deploymentView, domainView, loadDomain, loadService, page, projectFilter, serviceView } from "../data";
import { ApiError, type ApiRoute, assertCan, route, unwrap } from "../router";

const id = z.string().min(1);

/**
 * Saved HTTP options as the options form sends them, so a change can leave fields out: basic auth
 * and guests without passwords keep theirs, and raw directives left out stay as saved.
 */
function proxyInputOf(c: ServiceProxyConfig | null | undefined): ProxyInput {
  if (!c) return {};
  const { basicAuth, guests, sticky: _sticky, customDirectives: _n, caddyDirectives: _c, traefikMiddlewares: _t, ...rest } = c;
  return {
    ...rest,
    balancing: balancingOf(c),
    basicAuth: basicAuth ? { enabled: true, username: basicAuth.username } : { enabled: false },
    guests: (guests ?? []).map((g) => ({ id: g.id, email: g.email })),
  };
}

const mountPath = z.string().min(1).max(4096);
const composeMount = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("volume"), source: z.string().min(1).max(255), target: mountPath, readOnly: z.boolean().optional() }),
  z.object({ kind: z.literal("bind"), source: mountPath, target: mountPath, readOnly: z.boolean().optional(), hostType: z.enum(["file", "directory"]).optional() }),
  z.object({ kind: z.literal("file"), name: z.string().min(1).max(255), target: mountPath, content: z.string().max(512_000) }),
  z.object({ kind: z.literal("other"), from: z.enum(["volumes", "configs"]), index: z.number().int().min(0).max(1000), target: z.string().max(4096), label: z.string().max(4096) }),
]);
const listQuery = z.object({
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  type: z.enum(["app", "database", "compose"]).optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
});

/** Content types a .tar.gz may arrive with; none at all is fine too. */
const UPLOAD_TYPES = ["application/gzip", "application/x-gzip", "application/octet-stream", "application/x-tar", "application/x-compressed-tar", "application/tar+gzip"];

const variable = z.object({
  key: z.string().max(200),
  value: z.string().max(256 * 1024),
  buildTime: z.boolean().default(true),
  runtime: z.boolean().default(true),
  /** Kept as written: ${{…}} in it is not filled in. */
  literal: z.boolean().default(false),
  multiline: z.boolean().default(false),
});

const source = z
  .looseObject({ type: z.enum(["git", "image", "dockerfile", "upload"]) })
  .describe(
    'Where the code comes from: {type:"git", repository, branch, credentialId?}, {type:"image", image, registryId?}, {type:"dockerfile", content} or {type:"upload"} (deployed from the CLI: POST /services/{serviceId}/deploy/upload).',
  );

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
  return rows.map((r) => ({
    key: r.key,
    ...(withValues ? { value: decryptOrNull(r.value) ?? "" } : {}),
    buildTime: r.buildTime,
    runtime: r.runtime,
    literal: r.literal,
    multiline: r.multiline,
  }));
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
      "Change settings: name, hostname, autoDeploy, previewsEnabled, previewDomain, source, build, runtime (port, replicas, healthcheck, resources, volumes, ports, restart policy, ...), as the service's settings pages send them. Only the given fields change. A git source takes commitStatuses: false to stop reporting deployments on commits (on by default).",
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
  route({
    method: "POST",
    path: "/services/{serviceId}/deploy/upload",
    tag: "Deployments",
    summary: "Deploy uploaded files",
    description: [
      "The body is the project folder as a .tar.gz (Content-Type: application/gzip), streamed to disk. This is what `serve deploy` sends.",
      "Serve unpacks it where a repository would be cloned and builds it like a checkout: the Dockerfile, the detected builder and the build settings all apply.",
      'For apps with source {type:"upload"}, and as a one-off deploy of local files for apps built from Git or a Dockerfile. Not for image apps, compose stacks or databases.',
      "Query: message, commit, branch (shown with the deployment), dirty=1 (the folder had changes that were not committed), noCache=1.",
      "Redeploying the deployment builds the same files again; the files of the last 5 uploads are kept.",
    ].join(" "),
    needs: ["services.deploy"],
    query: z.object({
      message: z.string().max(5000).optional(),
      commit: z
        .string()
        .regex(/^[0-9a-f]{4,64}$/i, "A commit is a hexadecimal hash")
        .optional(),
      branch: z.string().max(255).optional(),
      dirty: z.enum(["0", "1", "true", "false"]).optional(),
      noCache: z.enum(["0", "1", "true", "false"]).optional(),
    }),
    status: 202,
    handler: async ({ auth, params, query, request }) => {
      const { service } = await loadService(auth, params.serviceId);
      if (service.type !== "app") throw new ApiError(400, `Only apps can be deployed from uploaded files. This is a ${service.type === "compose" ? "compose stack" : "database"}.`);
      if (!service.source || service.source.type === "image")
        throw new ApiError(400, 'This app runs an image, so there is nothing to build from files. Set its source to {"type": "upload"} to deploy it from the CLI.');
      // Files from an upload become the code of a service that reaches the host: like changing its source, only for Root admins.
      const { serviceHasHostAccess } = await import("@/server/security");
      if (serviceHasHostAccess(service)) {
        const { isInstanceAdmin } = await import("@/server/auth");
        const { getSetting } = await import("@/server/settings");
        const root = auth.admin && auth.organizationId === (await getSetting("rootOrganizationId")) && (await isInstanceAdmin(auth.userId));
        if (!root)
          throw new ApiError(403, "This app has host access (privileged mode, host paths or devices), so only admins of the Root organization can deploy uploaded files to it.");
      }
      const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (type && !UPLOAD_TYPES.includes(type)) throw new ApiError(400, `Send the project folder as a .tar.gz with Content-Type: application/gzip (got ${type}).`);
      const { receiveUpload, discardUpload, pruneUploads, UploadError } = await import("@/server/deploy/uploads");
      const { deployRefusal, queueDeployment } = await import("@/server/services/create");
      // A freeze or a full queue refuses the deploy before the body is stored.
      const refusal = await deployRefusal(service.id, "cli", auth.userId);
      if (refusal) throw new ApiError(409, refusal);
      const deploymentId = newId();
      let stored: Awaited<ReturnType<typeof receiveUpload>>;
      try {
        stored = await receiveUpload(service.id, deploymentId, request.body, Number(request.headers.get("content-length") ?? 0) || 0);
      } catch (e) {
        if (e instanceof UploadError) throw new ApiError(e.status, e.message);
        throw e;
      }
      const yes = (v?: string) => v === "1" || v === "true";
      let setNoCache = false;
      try {
        if (!stored.files) throw new ApiError(400, "The upload holds no files. Check that the folder is not empty and that your ignore files do not leave out everything.");
        if (yes(query.noCache) && service.build) {
          await db
            .update(schema.service)
            .set({ build: { ...service.build, noCacheOnce: true } })
            .where(eq(schema.service.id, service.id));
          setNoCache = !service.build.noCacheOnce;
        }
        await queueDeployment(service.id, "cli", {
          id: deploymentId,
          userId: auth.userId,
          commitSha: query.commit?.toLowerCase() ?? null,
          commitMessage: query.message?.trim() || null,
          branch: query.branch?.trim() || null,
          upload: { archive: stored.archive, size: stored.size, files: stored.files, dirty: yes(query.dirty) },
        });
        await pruneUploads(service.id).catch(() => {});
        return { deploymentId };
      } catch (e) {
        await discardUpload(stored.archive);
        // Nothing was queued: the next deploy must not build without the cache because of this one.
        if (setNoCache && service.build)
          await db
            .update(schema.service)
            .set({ build: { ...service.build, noCacheOnce: false } })
            .where(eq(schema.service.id, service.id))
            .catch(() => {});
        throw e;
      }
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
    method: "GET",
    path: "/services/{serviceId}/proxy",
    tag: "Domains",
    summary: "HTTP options of a service",
    description: "Body size, timeouts, balancing, basic auth and login wall, IP rules, headers, CORS and more, as saved. Never a password or its hash.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      const { service } = await loadService(auth, params.serviceId);
      return { options: proxyFormInitial(service.proxy) };
    },
  }),
  route({
    method: "PATCH",
    path: "/services/{serviceId}/proxy",
    tag: "Domains",
    summary: "Change HTTP options of a service",
    description:
      "Fields left out keep their value; the proxy tests the new site and nothing changes when it refuses it. basicAuth {enabled, username, password}: the password may be left out to keep it for the same user. guests: the whole list; a guest with its id may leave out its password. customDirectives, caddyDirectives and traefikMiddlewares need a Root admin.",
    needs: ["admin", "domains.manage"],
    body: proxyInputSchema,
    handler: async ({ auth, params, body }) => {
      const { service } = await loadService(auth, params.serviceId);
      const saved = proxyInputOf(service.proxy);
      // Only the old sticky flag sent: it decides the strategy, as it did before balancing existed.
      if (body.sticky !== undefined && body.balancing === undefined) delete saved.balancing;
      await unwrap(serviceProxy.updateServiceProxy(params.serviceId, { ...saved, ...body }));
      const { service: after } = await loadService(auth, params.serviceId);
      return { options: proxyFormInitial(after.proxy) };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/proxy/custom",
    tag: "Domains",
    summary: "Replace the generated proxy site of a service",
    description:
      "content: the site for the proxy the server runs now (nginx, Caddy or Traefik), or null to go back to the generated one. The proxy checks it; a refused file changes nothing.",
    needs: ["instance"],
    body: z.object({ content: z.string().max(100_000).nullable() }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return (await unwrap(serviceProxy.saveServiceProxyCustom(params.serviceId, body.content))) ?? { ok: true };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/preview-database",
    tag: "Services",
    summary: "Give each pull request preview its own database",
    description:
      'sourceServiceId: a database of the same environment, copied for each preview; variable: the variable that gets the copy\'s URL (like DATABASE_URL). mode "service" (a copy as its own service) or "branch" (a branch of the database). scrubSql runs on the copy (PostgreSQL, MySQL, MariaDB, ClickHouse).',
    needs: ["services.manage"],
    body: z.object({
      sourceServiceId: id,
      variable: z.string().max(200),
      scrubSql: z.string().max(100_000).nullable().optional(),
      mode: z.enum(["service", "branch"]).optional(),
    }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      await loadService(auth, body.sourceServiceId);
      return (await unwrap(savePreviewDatabase(params.serviceId, body))) ?? { ok: true };
    },
  }),
  route({
    method: "DELETE",
    path: "/services/{serviceId}/preview-database",
    tag: "Services",
    summary: "Stop giving previews their own database",
    needs: ["services.manage"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      return (await unwrap(savePreviewDatabase(params.serviceId, null))) ?? { ok: true };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/main-server",
    tag: "Services",
    summary: "Make one of an app's extra servers its main one",
    description:
      "Visitors enter through it from now on; nothing is redeployed and the old main server becomes an extra one. Serve moves the DNS records and tunnel routes it manages: manual lists the names to point at the new IP yourself.",
    needs: ["services.manage"],
    body: z.object({ serverId: id }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return unwrap(setMainServer(params.serviceId, body.serverId));
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/approval",
    tag: "Deployments",
    summary: "Whether a service's deploys wait for approval",
    description: "mode always (they always wait), never (they never do) or null (the project's deploy rules decide).",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      const { service } = await loadService(auth, params.serviceId);
      return { mode: service.deployApproval ?? null };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/approval",
    tag: "Deployments",
    summary: "Make a service's deploys wait for approval, or not",
    description: "mode always, never, or null to follow the project's deploy rules. Database deploys never wait.",
    needs: ["deploys.approve"],
    body: z.object({ mode: z.enum(["always", "never"]).nullable() }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      await unwrap(setServiceApproval(params.serviceId, body.mode));
      return { mode: body.mode };
    },
  }),
  route({
    method: "POST",
    path: "/services/redeploy",
    tag: "Deployments",
    summary: "Redeploy several services",
    description:
      "Like after a database password change: each running service of serviceIds (up to 50) is deployed again; stopped ones are left alone. Answers how many were queued.",
    needs: ["services.deploy"],
    body: z.object({ serviceIds: z.array(id).min(1).max(50) }),
    handler: async ({ auth, body }) => {
      const ids = [...new Set(body.serviceIds)];
      for (const serviceId of ids) await loadService(auth, serviceId);
      return unwrap(dbActions.redeployServices(ids));
    },
  }),
  route({
    method: "DELETE",
    path: "/services/{serviceId}/volumes/{volume}",
    tag: "Services",
    summary: "Delete the data of a volume no longer mounted",
    description:
      "Permanently removes a Docker volume of the service from its server: one its settings (or its compose file) no longer mount. A database's own data volume goes only with the database.",
    needs: ["services.manage"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      await unwrap(dbActions.deleteVolumeData(params.serviceId, params.volume));
      return { deleted: true };
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
    description:
      "The old secret stops working. The answer holds the new secret (webhookSecret) and the deploy hook URL with it (deployHookUrl); without variables.view-secrets, as in the dashboard, the secret is hidden.",
    needs: ["services.manage"],
    handler: async ({ auth, params, request }) => {
      await loadService(auth, params.serviceId);
      await unwrap(actions.regenerateWebhookSecret(params.serviceId));
      const [row] = await db.select({ webhookSecret: schema.service.webhookSecret }).from(schema.service).where(eq(schema.service.id, params.serviceId));
      const { preferHttps, publicBaseUrl } = await import("@/server/git/github-app");
      const base = await preferHttps((await publicBaseUrl().catch(() => "")) || new URL(request.url).origin);
      const secret = auth.can("variables.view-secrets") ? (row?.webhookSecret ?? null) : null;
      return {
        ok: true,
        webhookSecret: secret,
        deployHookUrl: `${base}/api/deploy-hooks/${params.serviceId}?token=${secret ?? "********"}`,
        webhookUrl: `${base}/api/webhooks/git/${params.serviceId}`,
      };
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
    method: "GET",
    path: "/services/{serviceId}/compose/mounts",
    tag: "Services",
    summary: "Storage of each service of a stack",
    description:
      "As the saved compose file has it: named volumes, paths on the server (bind), inline files, and other entries (kind other) that are kept as written when sent back.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      const { service } = await loadService(auth, params.serviceId);
      if (service.type !== "compose" || !service.compose) throw new ApiError(400, "Not a compose service.");
      return { services: readComposeMounts(service.compose.content) };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/compose/mounts/{name}",
    tag: "Services",
    summary: "Replace the storage of one service of a stack",
    description:
      "mounts becomes the storage of the compose service name, written into the compose file and saved like the compose editor does (paths on the server need a Root admin). Send back kind other entries from GET to keep them. Redeploy to apply. Not for stacks read from Git.",
    needs: ["services.manage"],
    body: z.object({ mounts: z.array(composeMount).max(100) }),
    handler: async ({ auth, params, body }) => {
      const { service } = await loadService(auth, params.serviceId);
      if (service.type !== "compose" || !service.compose) throw new ApiError(400, "Not a compose service.");
      return (await unwrap(saveComposeMounts(params.serviceId, params.name, body.mounts))) ?? { ok: true };
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
  // Tags
  route({
    method: "GET",
    path: "/tags",
    tag: "Services",
    summary: "List tags",
    description: "The organization's tags, with the ids of the services that carry each one.",
    needs: ["projects.view"],
    handler: async ({ auth }) => {
      const tags = await db.select().from(schema.tag).where(eq(schema.tag.organizationId, auth.organizationId)).orderBy(asc(schema.tag.name));
      const links = tags.length
        ? (
            await db
              .select({ tagId: schema.serviceTag.tagId, serviceId: schema.serviceTag.serviceId, projectId: schema.service.projectId })
              .from(schema.serviceTag)
              .innerJoin(schema.service, eq(schema.service.id, schema.serviceTag.serviceId))
              .where(
                inArray(
                  schema.serviceTag.tagId,
                  tags.map((t) => t.id),
                ),
              )
          ).filter((l) => auth.canAccessProject(l.projectId))
        : [];
      return { tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color, serviceIds: links.filter((l) => l.tagId === t.id).map((l) => l.serviceId) })) };
    },
  }),
  route({
    method: "POST",
    path: "/tags",
    tag: "Services",
    summary: "Create a tag",
    needs: ["services.manage"],
    body: z.object({ name: z.string(), color: z.string().optional() }),
    status: 201,
    handler: async ({ body }) => unwrap(tagActions.createTag(body)),
  }),
  route({
    method: "PATCH",
    path: "/tags/{tagId}",
    tag: "Services",
    summary: "Rename or recolor a tag",
    needs: ["services.manage"],
    body: z.object({ name: z.string().optional(), color: z.string().optional() }),
    handler: async ({ params, body }) => unwrap(tagActions.updateTag(params.tagId, body)),
  }),
  route({
    method: "DELETE",
    path: "/tags/{tagId}",
    tag: "Services",
    summary: "Delete a tag",
    description: "The tag goes from every service; the services stay.",
    needs: ["services.manage"],
    handler: async ({ params }) => unwrap(tagActions.deleteTag(params.tagId)),
  }),
  route({
    method: "POST",
    path: "/tags/{tagId}/deploy",
    tag: "Deployments",
    summary: "Deploy every service of a tag",
    description: "Each deploy follows its project's rules: a freeze skips it, an approval holds it.",
    needs: ["services.deploy"],
    handler: async ({ params }) => unwrap(tagActions.deployTagAction(params.tagId)),
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/tags",
    tag: "Services",
    summary: "Set the tags of a service",
    description: "By name; names without a tag yet become new tags.",
    needs: ["services.manage"],
    body: z.object({ tags: z.array(z.string()).max(50) }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return unwrap(tagActions.saveServiceTags(params.serviceId, body.tags));
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/clone",
    tag: "Services",
    summary: "Clone a service",
    description:
      "Copies the service into an environment of the organization, on one of its servers: settings, variables, scheduled tasks (turned off) and a generated domain. Nothing is deployed. copyData: true also copies a database's data (needs databases.backups).",
    needs: ["services.manage"],
    body: z.object({ environmentId: z.string(), serverId: z.string(), name: z.string().optional(), copyData: z.boolean().optional() }),
    status: 201,
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return unwrap(actions.cloneServiceAction(params.serviceId, body));
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
        .map((v) => ({ key: v.key, value: "", keep: v.key, buildTime: v.buildTime, runtime: v.runtime, literal: v.literal, multiline: v.multiline }))
        .concat(
          Object.entries(changes)
            .filter(([, value]) => value !== null)
            .map(([key, value]) => {
              const prev = stored.find((v) => v.key === key);
              return {
                key,
                value: value as string,
                keep: undefined as unknown as string,
                buildTime: prev?.buildTime ?? true,
                runtime: prev?.runtime ?? true,
                literal: prev?.literal ?? false,
                multiline: prev?.multiline ?? (value as string).includes("\n"),
              };
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
    path: "/domains/{domainId}/point-at-main",
    tag: "Domains",
    summary: "Point a domain's DNS at the app's main server",
    description:
      "When its A record points at another server the app runs on. Only through the connected Cloudflare account that holds its zone, and only records that point at one of the app's servers.",
    needs: ["domains.manage"],
    handler: async ({ auth, params }) => {
      await loadDomain(auth, params.domainId);
      return (await unwrap(actions.pointDomainAtMain(params.domainId))) ?? { ok: true };
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
          checksum: b.checksum,
          encrypted: !!b.keyHint || !!b.filename?.endsWith(".enc"),
          copies: b.copies ?? [],
          verifyStatus: b.verifyStatus,
          verifiedAt: b.verifiedAt?.toISOString() ?? null,
          verifyDetail: b.verifyDetail,
          verifyError: b.verifyError,
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
    description: `target picks a compose service's backup (see the stack's backup settings). databases (a database service): the databases of the server to take, or ["*"] for every one, new ones included; without it the service's choice (database.backupDatabases) or the main database. choice (a database service): other settings for this backup only: s3DestinationId (null: this server only), copies (more buckets), local (keep a copy on the server too), users, encrypt (false leaves out encryption; admins only).`,
    needs: ["databases.backups"],
    body: z.object({
      target: z.string().nullable().optional(),
      databases: z.array(z.string()).optional(),
      choice: z
        .object({
          s3DestinationId: z.string().nullable().optional(),
          copies: z.array(z.string()).optional(),
          local: z.boolean().optional(),
          users: z.boolean().optional(),
          encrypt: z.boolean().optional(),
        })
        .optional(),
    }),
    status: 202,
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return (await unwrap(actions.createBackup(params.serviceId, body.target ?? null, { databases: body.databases, choice: body.choice }))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/backups/{backupId}/restore",
    tag: "Backups",
    summary: "Restore a backup",
    description: [
      "backupFirst: true backs up the current data first. users: true also restores the dump's users, passwords and roles (Serve's own accounts keep theirs).",
      'into: another database service of the same engine to restore into. databases: only these databases of the backup ("" is a dump\'s unnamed one); renames: a database restored under another name;',
      "tables: only these tables of the one chosen database (Postgres as schema.table, MySQL, MariaDB). passphrase: for a backup encrypted with a passphrase other than the current one.",
    ].join(" "),
    needs: ["databases.backups"],
    body: z.object({
      backupFirst: z.boolean().optional(),
      users: z.boolean().optional(),
      into: z.string().optional(),
      databases: z.array(z.string()).optional(),
      renames: z.record(z.string(), z.string()).optional(),
      tables: z.array(z.string()).optional(),
      passphrase: z.string().optional(),
    }),
    status: 202,
    handler: async ({ params, body }) => (await unwrap(actions.restoreFromBackup(params.backupId, body))) ?? { ok: true },
  }),
  route({
    method: "GET",
    path: "/backups/{backupId}/contents",
    tag: "Backups",
    summary: "What a backup holds",
    description:
      "Its databases and, for Postgres, MySQL and MariaDB, their tables: what a restore can choose. An encrypted backup made with another passphrase: that one in the X-Backup-Passphrase header.",
    needs: ["databases.backups"],
    handler: async ({ params, request }) => unwrap(actions.restoreChoices(params.backupId, request.headers.get("x-backup-passphrase") ?? undefined)),
  }),
  route({
    method: "POST",
    path: "/backups/{backupId}/test",
    tag: "Backups",
    summary: "Test a backup",
    description: "Restores it into a throwaway database on the database's server and counts what came back. The result shows on the backup (verifyStatus, verifyDetail).",
    needs: ["databases.backups"],
    status: 202,
    handler: async ({ params }) => (await unwrap(actions.testBackup(params.backupId))) ?? { ok: true },
  }),
  route({
    method: "GET",
    path: "/backups/{backupId}/download",
    tag: "Backups",
    summary: "Download a backup",
    description: "The file as it is stored (encrypted ones stay encrypted). X-Checksum-SHA256 carries the checksum recorded when it was made.",
    needs: ["databases.backups"],
    produces: "application/octet-stream",
    handler: async ({ auth, params }) => {
      const [b] = await db.select().from(schema.backup).where(eq(schema.backup.id, params.backupId));
      if (!b?.filename || b.status !== "success") throw new ApiError(404, "Backup not found");
      await loadService(auth, b.serviceId);
      const fs = await import("node:fs");
      const { Readable } = await import("node:stream");
      const { backupFile, openS3Backup } = await import("@/server/backups");
      const headers = {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${b.filename}"`,
        ...(b.checksum ? { "x-checksum-sha256": b.checksum } : {}),
      };
      const file = backupFile(b.serviceId, b.filename);
      if (fs.existsSync(file))
        return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers: { ...headers, "content-length": String(fs.statSync(file).size) } });
      const remote = await openS3Backup(b).catch(() => null);
      if (!remote) throw new ApiError(404, "The backup file is no longer stored.");
      return new Response(remote.body as ReadableStream, { headers: { ...headers, ...(remote.size ? { "content-length": String(remote.size) } : {}) } });
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/backups/import",
    tag: "Backups",
    summary: "Import a backup file",
    description: [
      "The body is the file, streamed to disk (up to 20 GB), then restored: a dump for a database service, or for one backup of a compose stack (target).",
      "Query: filename (its extension says the format), target (db:…, volume:…, dir:…), backupFirst=1, users=1, database (restore the file's one database into this database of the server, merged). An encrypted file's passphrase goes in the X-Backup-Passphrase header.",
    ].join(" "),
    needs: ["databases.backups"],
    query: z.object({
      filename: z.string(),
      target: z.string().optional(),
      backupFirst: z.enum(["0", "1", "true", "false"]).optional(),
      users: z.enum(["0", "1", "true", "false"]).optional(),
      database: z.string().optional(),
    }),
    status: 202,
    handler: async ({ auth, params, query, request }) => {
      const { service } = await loadService(auth, params.serviceId);
      // Importing overwrites live data: admins only, like restoring.
      if (!auth.admin) throw new ApiError(403, "Only organization admins can import backups.");
      const { ImportError, receiveImport } = await import("@/server/backups/import-upload");
      const yes = (v?: string) => v === "1" || v === "true";
      try {
        return await receiveImport({
          service,
          target: query.target || null,
          filename: query.filename,
          body: request.body,
          declared: Number(request.headers.get("content-length") ?? 0),
          backupFirst: yes(query.backupFirst),
          users: yes(query.users),
          intoDatabase: query.database || null,
          passphrase: request.headers.get("x-backup-passphrase"),
          userId: auth.userId,
        });
      } catch (e) {
        if (e instanceof ImportError) throw new ApiError(e.status, e.message);
        throw e;
      }
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/backups/settings",
    tag: "Backups",
    summary: "Backup settings of a database",
    description: "Schedule, retention, buckets, encryption (whether it is on, never the passphrase), daily tests and more.",
    needs: ["databases.backups"],
    handler: async ({ auth, params }) => {
      const { service } = await loadService(auth, params.serviceId);
      const c = service.database;
      if (!c) throw new ApiError(400, "Not a database. Compose stacks: GET /services/{serviceId}/compose-backups.");
      return {
        schedule: c.backupSchedule ?? null,
        databases: c.backupDatabases ?? null,
        retention: c.backupRetention,
        retentionS3: c.backupRetentionS3 ?? null,
        s3DestinationId: c.s3DestinationId ?? null,
        copyDestinationIds: c.backupCopyDestinationIds ?? [],
        local: c.backupLocal !== false,
        timeoutMinutes: c.backupTimeoutMinutes ?? null,
        lowPriority: !!c.backupLowPriority,
        verify: !!c.backupVerify,
        users: !!c.backupUsers,
        encrypted: !!c.backupPassphrase,
      };
    },
  }),
  route({
    method: "PATCH",
    path: "/services/{serviceId}/backups/settings",
    tag: "Backups",
    summary: "Change backup settings of a database",
    description:
      "Fields left out keep their value. passphrase: a new one encrypts backups from now on (at least 8 characters), null stops encrypting. users: backups also take the server's users, passwords and rights (Postgres, MySQL, MariaDB).",
    needs: ["databases.backups", "services.manage"],
    body: z.object({
      schedule: z.string().nullable().optional(),
      databases: z.array(z.string()).nullable().optional(),
      retention: z.number().int().optional(),
      retentionS3: z.number().int().nullable().optional(),
      s3DestinationId: z.string().nullable().optional(),
      copyDestinationIds: z.array(z.string()).optional(),
      local: z.boolean().optional(),
      timeoutMinutes: z.number().int().nullable().optional(),
      lowPriority: z.boolean().optional(),
      verify: z.boolean().optional(),
      users: z.boolean().optional(),
      passphrase: z.string().nullable().optional(),
    }),
    handler: async ({ auth, params, body }) => {
      const { service } = await loadService(auth, params.serviceId);
      if (!service.database) throw new ApiError(400, "Not a database. Compose stacks: PUT /services/{serviceId}/compose-backups/{key}.");
      const map: [keyof typeof body, string][] = [
        ["schedule", "backupSchedule"],
        ["databases", "backupDatabases"],
        ["retention", "backupRetention"],
        ["retentionS3", "backupRetentionS3"],
        ["s3DestinationId", "s3DestinationId"],
        ["copyDestinationIds", "backupCopyDestinationIds"],
        ["local", "backupLocal"],
        ["timeoutMinutes", "backupTimeoutMinutes"],
        ["lowPriority", "backupLowPriority"],
        ["verify", "backupVerify"],
        ["users", "backupUsers"],
        ["passphrase", "backupPassphrase"],
      ];
      const database = Object.fromEntries(map.filter(([k]) => body[k] !== undefined).map(([k, to]) => [to, body[k]]));
      await unwrap(actions.updateService(params.serviceId, { database }));
      return { ok: true };
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/compose-backups",
    tag: "Backups",
    summary: "Backups set up in a compose stack",
    description: "Keyed by what they back up: db:<service> (a database container), volume:<name> or dir:<path>. encrypted says whether a passphrase is set; it is never returned.",
    needs: ["databases.backups"],
    handler: async ({ auth, params }) => {
      const { service } = await loadService(auth, params.serviceId);
      return {
        backups: Object.fromEntries(Object.entries(service.composeBackups ?? {}).map(([k, { passphrase, ...c }]) => [k, { ...c, encrypted: !!passphrase }])),
      };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/compose-backups/{key}",
    tag: "Backups",
    summary: "Set up or change a backup of a compose stack",
    description:
      "key: db:<service>, volume:<name> or dir:<path> (URL-encoded). Adds it when missing. Body: schedule (cron or null), retention, retentionS3, s3DestinationId, copyDestinationIds, local, timeoutMinutes, lowPriority, passphrase (null stops encrypting; left out keeps it).",
    needs: ["databases.backups"],
    body: z.looseObject({}),
    handler: async ({ auth, params, body }) => {
      const { service } = await loadService(auth, params.serviceId);
      const key = decodeURIComponent(params.key);
      const { addComposeBackup, saveComposeBackup } = await import("@/server/actions/compose-backups");
      if (!service.composeBackups?.[key]) await unwrap(addComposeBackup(params.serviceId, key));
      const fresh = (await loadService(auth, params.serviceId)).service.composeBackups?.[key];
      const { passphrase: _, ...current } = fresh ?? { schedule: null, retention: 7 };
      await unwrap(saveComposeBackup(params.serviceId, key, { retentionS3: null, s3DestinationId: null, ...current, ...(body as object) } as never));
      return { ok: true };
    },
  }),
  route({
    method: "DELETE",
    path: "/services/{serviceId}/compose-backups/{key}",
    tag: "Backups",
    summary: "Stop backing up part of a compose stack",
    description: "Backups already taken stay until deleted.",
    needs: ["databases.backups"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      const { removeComposeBackup } = await import("@/server/actions/compose-backups");
      await unwrap(removeComposeBackup(params.serviceId, decodeURIComponent(params.key)));
      return { ok: true };
    },
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

  route({
    method: "GET",
    path: "/services/{serviceId}/request-log",
    tag: "Logs",
    summary: "Request log",
    description:
      "Single requests through the proxy, newest first, when the service keeps a request log (Settings → Monitoring). Filters: status (like 5xx or 4,5), path (contains), method, from and to (RFC 3339 or Unix seconds), limit (1-500, default 100). Pass next as before for the next page.",
    needs: ["logs.view"],
    query: z.object({
      status: z.string().optional(),
      path: z.string().optional(),
      method: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      before: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
    handler: async ({ auth, params, query }) => {
      const { service } = await loadService(auth, params.serviceId);
      const { filterFromQuery, requestLogPage } = await import("@/server/request-log");
      const q = new URLSearchParams(
        Object.entries(query)
          .filter((e): e is [string, string] => e[1] !== undefined)
          .map(([k, v]) => [k, String(v)]),
      );
      return requestLogPage(service.id, filterFromQuery(q));
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/request-log/settings",
    tag: "Logs",
    summary: "Request log settings",
    description: "Whether the service keeps a request log, for how many days, which responses (2 to 5 for 2xx to 5xx) and whether visitor IPs are kept.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      const { service } = await loadService(auth, params.serviceId);
      const { requestLogConfig } = await import("@/server/request-log");
      return { settings: requestLogConfig(service.requestLog) };
    },
  }),
  route({
    method: "PATCH",
    path: "/services/{serviceId}/request-log/settings",
    tag: "Logs",
    summary: "Change the request log settings",
    description: "Fields left out keep their value. Turning ips off also clears the IPs already kept.",
    needs: ["services.manage"],
    body: z.object({
      enabled: z.boolean().optional(),
      days: z.number().int().min(1).optional(),
      statuses: z.array(z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)])).optional(),
      ips: z.boolean().optional(),
    }),
    handler: async ({ auth, params, body }) => {
      const { service } = await loadService(auth, params.serviceId);
      const { requestLogConfig } = await import("@/server/request-log");
      await unwrap(monitoring.saveRequestLog(params.serviceId, { ...requestLogConfig(service.requestLog), ...body }));
      const { service: after } = await loadService(auth, params.serviceId);
      return { settings: requestLogConfig(after.requestLog) };
    },
  }),
  route({
    method: "DELETE",
    path: "/services/{serviceId}/request-log",
    tag: "Logs",
    summary: "Delete the requests kept",
    description: "Every request kept for the service and its previews. The log keeps recording when it is on.",
    needs: ["services.manage"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      await unwrap(monitoring.deleteRequestLog(params.serviceId));
      return { deleted: true };
    },
  }),
  // Logs
  route({
    method: "GET",
    path: "/services/{serviceId}/logs",
    tag: "Logs",
    summary: "Recent container logs",
    description:
      "The last lines of each running container of the service (tail, 10-5000, default 200). since (RFC 3339 or Unix seconds) gives only newer lines: poll with the time of the last line to follow the logs.",
    needs: ["logs.view"],
    query: z.object({
      tail: z.coerce.number().int().min(10).max(5000).default(200),
      container: z.string().optional(),
      since: z
        .string()
        .refine((v) => dockerSince(v) !== null, "Use an RFC 3339 time or Unix seconds")
        .optional(),
    }),
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
          .logs({ stdout: true, stderr: true, tail: query.tail, timestamps: true, ...(query.since ? { since: dockerSince(query.since) as unknown as number } : {}) })
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
