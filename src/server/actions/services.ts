"use server";

import { ALL_DATABASES, SKIP_PREFIX } from "@/lib/backup-databases";
import { and, asc, isNotNull, eq, inArray, lt, ne, or, sql as dsql } from "drizzle-orm";
import { runServerIds } from "@/server/deploy/distribution";
import { z } from "zod";
import { PASSWORD_PATTERN } from "@/server/databases/password";
import { normalizeTrustedRanges } from "@/lib/trusted-proxies";
import { act, UserError } from "@/server/action";
import { cannotMessage } from "@/lib/permissions";
import { requirePermission } from "@/server/auth";
import { requireDeleteProof } from "@/server/delete-proof";
import { db, schema, sql } from "@/server/db";
import { encrypt, randomPassword } from "@/server/crypto";
import { newId } from "@/server/id";
import { CANCEL_CHANNEL, enqueue, JOB_CHANNEL } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { projectInOrg, serviceInOrg } from "@/server/services/access";
import { generatedHostname, lastUploadOf, NO_UPLOAD, newWebhookSecret, queueDeployment, serviceNameTaken, uniqueServiceName, uniqueServiceSlug } from "@/server/services/create";
import { KEEP_UPLOADS, uploadExists } from "@/server/deploy/uploads";
import { buildsImage, defaultBuild, defaultRuntime, type BuildConfig, type RuntimeConfig, type SourceConfig, hasHostAccess, usesOutsideResources } from "@/server/services/types";
import { engines } from "@/server/databases/engines";
import { resolveTemplate, templateVarValue } from "@/server/services/custom-templates";
import { assertCredentialHost, normalizeRepoUrl, repoUrlProblem } from "@/server/deploy/git";
import { registerRepoWebhook, syncRepoWebhook } from "@/server/git/repo-webhooks";
import { queueCommitStatus } from "@/server/git/commit-status";
import { composeServiceNames, parseCompose } from "@/server/deploy/compose";
import { removeServiceProxy, syncServiceProxy } from "@/server/proxy/nginx";
import { ensureCertificateFor } from "@/server/ssl/certificates";
import { Cloudflare } from "@/server/cloudflare/api";
import { getSettings } from "@/server/settings";
import { assertNotDashboardHost, assertNotStatusHost, domainOwnership, ownershipMessage } from "@/server/domains/ownership";
import { teardownServices } from "@/server/services/teardown";
import { composeNameClashes, composeSecurityIssues, safeRedirectUrl } from "@/server/security";
import type { OrgContext } from "@/server/auth";
import { requestServiceControl } from "@/server/services/control";
import { hasRoom, requireNotOver, requireResourceChange, requireRoom, runCopies, withReservation } from "@/server/limits";
import { restartOwnContainer } from "@/server/services/container-info";
import { resolveServerForOrg, serverPublicIp } from "@/server/servers/access";
import { HOSTNAME_RE } from "@/lib/hostname";
import { SERVICE_NAME_RE, toServiceName } from "@/lib/service-name";
import { CAPABILITIES, DROP_CAPABILITIES, SECURITY_OPT_RE } from "@/server/deploy/options";
import { containerOptionsSchema } from "@/server/deploy/runtime-schema";
import { volumeListSchema } from "@/server/services/volume-schema";
import { dockerfileSourceSchema, uploadSourceSchema } from "@/server/services/source-schema";
import { getRegistry } from "@/server/registries";
import { sameRegistryHost, splitImage } from "@/server/registries/browse";

async function assertEnvironment(projectId: string, environmentId: string) {
  const [env] = await db
    .select()
    .from(schema.environment)
    .where(and(eq(schema.environment.id, environmentId), eq(schema.environment.projectId, projectId)));
  if (!env) throw new UserError("Environment not found.");
  return env;
}

async function assertCredential(credentialId: string | null | undefined, orgId: string, repository?: string) {
  if (!credentialId) return;
  const [cred] = await db
    .select({ id: schema.gitCredential.id, provider: schema.gitCredential.provider, baseUrl: schema.gitCredential.baseUrl })
    .from(schema.gitCredential)
    .where(and(eq(schema.gitCredential.id, credentialId), eq(schema.gitCredential.organizationId, orgId)));
  if (!cred) throw new UserError("Git credential not found.");
  // Over SSH the key only signs; over HTTPS the token goes to the repository's server (checked again at each clone).
  const url = repository ? normalizeRepoUrl(repository) : null;
  if (url && /^https?:\/\//i.test(url)) {
    try {
      assertCredentialHost(cred, url);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }
}

/** Host-level options (bind mounts, host ports, privileged compose keys) are reserved for server admins. */
/** A repository address git may fetch (see repoUrlProblem): owner/repo, https or ssh. */
const repositoryField = z
  .string()
  .trim()
  .min(3, "Enter a repository URL")
  .superRefine((v, ctx) => {
    const problem = repoUrlProblem(normalizeRepoUrl(v));
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

function assertHostAccess(ctx: OrgContext, what: string) {
  if (!ctx.isInstanceAdmin || !ctx.isRoot) throw new UserError(`${what} is only available to admins of the Root organization, for its own services.`);
}

/**
 * Host-level compose options are allowed only for services of the Root organization (created by
 * its admins), the same rule every deploy checks: an instance admin working in another
 * organization gets the answer now, not on every deploy.
 */
async function assertSafeCompose(ctx: OrgContext, content: string, environmentId: string, serviceId: string | null = null) {
  const issues = composeSecurityIssues(content);
  if (issues.length && !(ctx.isInstanceAdmin && ctx.isRoot)) {
    const who = ctx.isRoot ? "only admins of the Root organization may use" : "only services of the Root organization may use";
    throw new UserError(`This compose file uses options ${who}: ${issues.slice(0, 3).join("; ")}.`);
  }
  await assertComposeNames(content, environmentId, serviceId);
}

/**
 * Nobody's file may take a name another service answers to (the proxy would send it that
 * traffic), nor a private hostname of its environment (the name would answer for two services).
 */
async function assertComposeNames(content: string, environmentId: string, serviceId: string | null) {
  const others = (
    await db.select({ id: schema.service.id, slug: schema.service.slug, hostname: schema.service.hostname, environmentId: schema.service.environmentId }).from(schema.service)
  ).filter((s) => s.id !== serviceId);
  const hostnames = others.filter((s) => s.environmentId === environmentId && s.hostname).map((s) => s.hostname as string);
  const clashes = composeNameClashes(
    content,
    others.map((s) => s.slug),
    hostnames,
  );
  if (clashes.length) throw new UserError(`This compose file uses names of other services: ${clashes.slice(0, 3).join("; ")}.`);
}

async function addGeneratedDomain(serviceId: string, slug: string, organizationId: string, port?: number | null, composeService?: string | null, serverId?: string) {
  const generated = await generatedHostname(slug, serverId);
  if (!generated) return;
  // A full domain limit skips the generated domain instead of failing the service.
  if (!(await hasRoom(organizationId, { domains: 1 }))) return;
  const [domain] = await db
    .insert(schema.domain)
    .values({
      id: newId(),
      serviceId,
      hostname: generated.hostname,
      https: generated.https,
      forceHttps: generated.https,
      generated: true,
      port: port ?? null,
      composeService: composeService ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (domain?.https) await ensureCertificateFor(domain, organizationId);
}

/* -------------------------------------------------------------------------- */
/*                                   Create                                   */
/* -------------------------------------------------------------------------- */

/** A saved registry an image pulls with: the organization's own, and the image must live in it. */
async function assertImageRegistry(registryId: string | null | undefined, image: string, organizationId: string) {
  if (!registryId) return;
  const registry = await getRegistry(registryId, organizationId);
  if (!registry) throw new UserError("That registry is not in this organization.");
  const { host } = splitImage(image);
  if (!sameRegistryHost(host, registry.host)) {
    throw new UserError(`${image} is not in ${registry.name} (${registry.host}). Use an image from ${registry.host}, or no registry.`);
  }
}

/** Letters, numbers and hyphens; other text (a template title) is turned into that form. */
const serviceName = z
  .string()
  .trim()
  .min(1, "Enter a name")
  .transform((v) => toServiceName(v))
  .pipe(z.string().regex(SERVICE_NAME_RE, "Use letters, numbers and hyphens, like api or web-2"));

const envVarInput = z.array(z.object({ key: z.string(), value: z.string() })).optional();

const appSchema = z.object({
  projectId: z.string(),
  environmentId: z.string(),
  name: serviceName,
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("git"),
      repository: repositoryField,
      branch: z.string().trim().min(1).default("main"),
      credentialId: z.string().nullable().optional(),
    }),
    z.object({
      type: z.literal("image"),
      image: z.string().trim().min(1, "Enter an image"),
      registryId: z.string().optional().nullable(),
      registryUsername: z.string().trim().optional().nullable(),
      registryPassword: z.string().optional().nullable(),
    }),
    dockerfileSourceSchema,
    uploadSourceSchema,
  ]),
  build: z
    .object({
      builder: z.enum(["auto", "dockerfile", "nixpacks", "railpack", "buildpacks", "static"]).default("auto"),
      rootDir: z.string().default("/"),
      dockerfile: z.string().default("Dockerfile"),
      installCommand: z.string().nullable().optional(),
      buildCommand: z.string().nullable().optional(),
      startCommand: z.string().nullable().optional(),
      publishDir: z.string().nullable().optional(),
    })
    .partial()
    .optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  envVars: envVarInput,
  /** Persistent storage set up front: named Docker volumes only (host paths need the root admin, in settings). */
  volumes: volumeListSchema.refine((list) => list.every((v) => v.kind === "volume" && !v.external), "Add host paths and files in the service settings.").optional(),
  /** Services are never deployed on creation unless the caller asks (e.g. the API). */
  deploy: z.boolean().default(false),
  /** Server to run on; defaults to the server Serve runs on. */
  serverId: z.string().nullable().optional(),
});

export async function createAppService(input: z.input<typeof appSchema>) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const data = appSchema.parse(input);
    await projectInOrg(data.projectId, ctx.org.id);
    await assertEnvironment(data.projectId, data.environmentId);

    if (data.source.type === "git") await assertCredential(data.source.credentialId, ctx.org.id, data.source.repository);
    if (data.source.type === "image") await assertImageRegistry(data.source.registryId, data.source.image, ctx.org.id);
    const server = await resolveServerForOrg(data.serverId, ctx.org.id);
    const reserved = await requireRoom(ctx.org.id, { services: 1, type: "app", serverId: server.id });

    const source: SourceConfig =
      data.source.type === "git"
        ? { type: "git", repository: normalizeRepoUrl(data.source.repository), branch: data.source.branch, credentialId: data.source.credentialId ?? null }
        : data.source.type === "dockerfile"
          ? { type: "dockerfile", content: data.source.content }
          : data.source.type === "upload"
            ? { type: "upload" }
            : {
                type: "image",
                image: data.source.image,
                ...(data.source.registryId
                  ? { registryId: data.source.registryId, registryUsername: null, registryPassword: null }
                  : {
                      registryId: null,
                      registryUsername: data.source.registryUsername || null,
                      registryPassword: data.source.registryPassword ? encrypt(data.source.registryPassword) : null,
                    }),
              };

    const id = newId();
    data.name = await uniqueServiceName(data.environmentId, data.name);
    const slug = await uniqueServiceSlug(data.name);
    await db.insert(schema.service).values({
      id,
      projectId: data.projectId,
      environmentId: data.environmentId,
      serverId: server.id,
      name: data.name,
      slug,
      type: "app",
      source,
      build:
        data.source.type === "git" || data.source.type === "upload"
          ? { ...defaultBuild(), ...(data.build as Partial<BuildConfig>) }
          : data.source.type === "dockerfile"
            ? { ...defaultBuild(), builder: "dockerfile" }
            : null,
      runtime: withReservation({ ...defaultRuntime(data.port ?? null), volumes: data.volumes ?? [] }, reserved),
      webhookSecret: newWebhookSecret(),
    });
    await writeEnvVars(
      id,
      (data.envVars ?? []).filter((v) => v.key.trim()).map((v) => ({ ...v, buildTime: true, runtime: true })),
    );
    await addGeneratedDomain(id, slug, ctx.org.id, null, null, server.id);
    // Deploy on push: add the repository webhook when the credential can (failures are recorded, not thrown).
    if (source.type === "git") await registerRepoWebhook(id);
    if (data.deploy) await queueDeployment(id, "create", { userId: ctx.user.id });
    await logActivity({ userId: ctx.user.id, projectId: data.projectId, action: "service.created", targetType: "service", targetId: id, message: `Created ${data.name}` });
    return { id };
  });
}

const dbSchema = z.object({
  deploy: z.boolean().default(false),
  projectId: z.string(),
  environmentId: z.string(),
  name: serviceName,
  engine: z.enum(["postgres", "mysql", "mariadb", "mongodb", "redis", "valkey", "clickhouse"]),
  version: z.string().optional(),
  username: z
    .string()
    .trim()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Use letters, numbers and underscores")
    .optional(),
  database: z
    .string()
    .trim()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Use letters, numbers and underscores")
    .optional(),
  password: z.string().regex(PASSWORD_PATTERN, "Use 12 to 128 letters, numbers, dots, dashes, underscores or tildes (these work in URLs).").optional(),
  serverId: z.string().nullable().optional(),
  /** Start on the data of a database deleted with its volume kept: its engine, account and server. */
  keptId: z.string().optional(),
});

export async function createDatabaseService(input: z.input<typeof dbSchema>) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const data = dbSchema.parse(input);
    await projectInOrg(data.projectId, ctx.org.id);
    await assertEnvironment(data.projectId, data.environmentId);
    const [kept] = data.keptId
      ? await db
          .select()
          .from(schema.keptDatabase)
          .where(and(eq(schema.keptDatabase.id, data.keptId), eq(schema.keptDatabase.organizationId, ctx.org.id)))
      : [];
    // Members limited to some projects only reach data their projects left (as deleting it).
    if (data.keptId && (!kept || (kept.projectId ? !ctx.canAccessProject(kept.projectId) : ctx.projectIds !== null))) throw new UserError("That kept data is gone.");
    // Kept data lives on its server: the database runs there.
    const server = await resolveServerForOrg(kept ? kept.serverId : data.serverId, ctx.org.id);
    if (kept && !kept.volume.startsWith("/")) {
      const { getServer } = await import("@/server/servers/context");
      const there = await (await getServer(server.id)).docker
        .getVolume(kept.volume)
        .inspect()
        .catch(() => null);
      if (!there) {
        await db.delete(schema.keptDatabase).where(eq(schema.keptDatabase.id, kept.id));
        throw new UserError(`The volume ${kept.volume} is not on ${server.name} any more.`);
      }
    }
    const reserved = await requireRoom(ctx.org.id, { services: 1, type: "database", serverId: server.id });
    if (kept) data.engine = kept.engine;
    const engine = engines[data.engine];
    const version = kept ? kept.version : data.version && engine.versions.includes(data.version) ? data.version : engine.defaultVersion;
    const id = newId();
    data.name = await uniqueServiceName(data.environmentId, data.name);
    // Claimed in one step: two requests cannot both start a database on the same data.
    if (kept) {
      const [claimed] = await db.delete(schema.keptDatabase).where(eq(schema.keptDatabase.id, kept.id)).returning({ id: schema.keptDatabase.id });
      if (!claimed) throw new UserError("That kept data is used by another database already.");
    }
    await db.insert(schema.service).values({
      id,
      projectId: data.projectId,
      environmentId: data.environmentId,
      serverId: server.id,
      name: data.name,
      slug: await uniqueServiceSlug(data.name),
      type: "database",
      runtime: withReservation({ ...defaultRuntime(engine.port), restartPolicy: "unless-stopped" as const }, reserved),
      database: kept
        ? {
            // The data was made with this account: it signs in again as it did.
            engine: kept.engine,
            version,
            image: kept.image,
            username: kept.username,
            password: kept.password,
            database: kept.database,
            dataVolume: kept.volume,
            dataVolumeOwned: kept.owned,
            dataMountPath: kept.dataMountPath,
            pgdata: kept.pgdata,
            publicPort: null,
            backupSchedule: null,
            backupRetention: 7,
            s3DestinationId: null,
          }
        : {
            engine: data.engine,
            version,
            username: engine.hasUser ? data.username || engine.defaultUser : engine.defaultUser,
            password: encrypt(data.password || randomPassword()),
            database: engine.hasDatabase ? data.database || engine.defaultDatabase : engine.defaultDatabase,
            publicPort: null,
            backupSchedule: null,
            backupRetention: 7,
            s3DestinationId: null,
          },
      webhookSecret: newWebhookSecret(),
    });
    if (data.deploy) await queueDeployment(id, "create", { userId: ctx.user.id });
    await logActivity({
      userId: ctx.user.id,
      projectId: data.projectId,
      action: "service.created",
      targetType: "service",
      targetId: id,
      message: `Created ${engine.label} database ${data.name}${kept ? ` on the kept data of ${kept.name}` : ""}`,
    });
    return { id };
  });
}

const composeSchema = z.object({
  deploy: z.boolean().default(false),
  projectId: z.string(),
  environmentId: z.string(),
  name: serviceName,
  mode: z.enum(["inline", "git"]),
  content: z.string().optional(),
  path: z.string().optional(),
  source: z.object({ repository: repositoryField, branch: z.string().trim().default("main"), credentialId: z.string().nullable().optional() }).optional(),
  template: z.string().optional(),
  /** Values chosen on the configure step; anything missing is generated from the template. */
  vars: z.record(z.string(), z.string().max(4000)).optional(),
  /** Variables typed on the create form (stacks without a template). */
  envVars: envVarInput,
  serverId: z.string().nullable().optional(),
});

export async function createComposeService(input: z.input<typeof composeSchema>) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const data = composeSchema.parse(input);
    await projectInOrg(data.projectId, ctx.org.id);
    await assertEnvironment(data.projectId, data.environmentId);

    const template = data.template ? await resolveTemplate(data.template, ctx.org.id) : null;
    if (data.template && !template) throw new UserError("Template not found.");
    let content = template?.compose ?? data.content ?? "";
    if (data.mode === "inline") {
      try {
        parseCompose(content);
      } catch (e) {
        throw new UserError(`The compose file is not valid: ${(e as Error).message}`);
      }
      // Built-in templates are reviewed; only those that touch the host need the Root organization.
      if (!template || template.custom || template.hostAccess) await assertSafeCompose(ctx, content, data.environmentId);
      else await assertComposeNames(content, data.environmentId, null);
    } else if (!data.source) throw new UserError("Enter a repository.");
    await assertCredential(data.source?.credentialId, ctx.org.id, data.source?.repository);
    const server = await resolveServerForOrg(data.serverId, ctx.org.id);
    const reserved = await requireRoom(ctx.org.id, { services: 1, type: "compose", serverId: server.id });
    if (!server.isLocal && server.info && (server.info as { compose?: string | null }).compose === null) {
      throw new UserError(`${server.name} has no Docker Compose. Install the compose plugin there first.`);
    }
    if (data.mode === "git") content = "";

    const id = newId();
    data.name = await uniqueServiceName(data.environmentId, data.name);
    const slug = await uniqueServiceSlug(data.name);
    await db.insert(schema.service).values({
      id,
      projectId: data.projectId,
      environmentId: data.environmentId,
      serverId: server.id,
      name: data.name,
      slug,
      type: "compose",
      icon: template && !template.custom ? template.id : null,
      source:
        data.mode === "git" && data.source
          ? { type: "git", repository: normalizeRepoUrl(data.source.repository), branch: data.source.branch, credentialId: data.source.credentialId ?? null }
          : null,
      runtime: withReservation(defaultRuntime(null), reserved),
      compose: {
        mode: data.mode,
        content,
        path: data.path || "docker-compose.yml",
        template: template?.id ?? null,
        // Host-level options (from git they are only seen at deploy) need an admin of the Root organization.
        hostAccess: ctx.isInstanceAdmin && ctx.isRoot,
      },
      webhookSecret: newWebhookSecret(),
    });

    if (template) {
      const generated = template.expose ? await generatedHostname(slug, server.id) : null;
      if (generated && template.expose) {
        const [domain] = await db
          .insert(schema.domain)
          .values({
            id: newId(),
            serviceId: id,
            hostname: generated.hostname,
            https: generated.https,
            forceHttps: generated.https,
            generated: true,
            // With more domains below, the exposed service stays the one SERVE_PUBLIC_URL means.
            primary: template.domains.length > 0,
            port: template.expose.port,
            composeService: template.expose.service,
          })
          .returning();
        if (domain.https) await ensureCertificateFor(domain, ctx.org.id);
        for (const extra of template.domains) {
          const host = await generatedHostname(`${slug}-${extra.service}`, server.id);
          if (!host) continue;
          const [taken] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, host.hostname)).limit(1);
          if (taken) continue;
          const [more] = await db
            .insert(schema.domain)
            .values({
              id: newId(),
              serviceId: id,
              hostname: host.hostname,
              https: host.https,
              forceHttps: host.https,
              generated: true,
              port: extra.port,
              composeService: extra.service,
            })
            .returning();
          if (more.https) await ensureCertificateFor(more, ctx.org.id);
        }
      }
      const vars = template.vars.map((v) => ({
        key: v.key,
        value: data.vars?.[v.key] ?? templateVarValue(v, !!generated),
        buildTime: false,
        runtime: true,
      }));
      await writeEnvVars(id, vars);
    } else if (data.envVars?.length) {
      await writeEnvVars(
        id,
        data.envVars.filter((v) => v.key.trim()).map((v) => ({ key: v.key.trim(), value: v.value, buildTime: true, runtime: true })),
      );
    }
    // Deploy on push, like apps from git.
    if (data.mode === "git") await registerRepoWebhook(id);
    if (data.deploy) await queueDeployment(id, "create", { userId: ctx.user.id });
    await logActivity({
      userId: ctx.user.id,
      projectId: data.projectId,
      action: "service.created",
      targetType: "service",
      targetId: id,
      message: !template ? `Created compose stack ${data.name}` : data.name === template.name ? `Created ${data.name}` : `Created ${data.name} from the ${template.name} template`,
    });
    return { id };
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Settings                                  */
/* -------------------------------------------------------------------------- */

const updateSchema = z.object({
  name: serviceName.optional(),
  /** Extra private hostname; "" or null removes it. */
  hostname: z.string().trim().toLowerCase().max(63).nullable().optional(),
  autoDeploy: z.boolean().optional(),
  previewsEnabled: z.boolean().optional(),
  /** URL template for previews, like pr-{pr}.example.com; "" or null: generated addresses. */
  previewDomain: z.string().trim().toLowerCase().nullable().optional(),
  source: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("git"),
        repository: repositoryField,
        branch: z.string().trim().min(1),
        credentialId: z.string().nullable().optional(),
        /** Report deployments on their commits; left out, it stays as it was (on by default). */
        commitStatuses: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("image"),
        image: z.string().trim().min(1),
        registryId: z.string().nullable().optional(),
        registryUsername: z.string().nullable().optional(),
        registryPassword: z.string().nullable().optional(),
      }),
      dockerfileSourceSchema,
      uploadSourceSchema,
    ])
    .optional(),
  build: z
    .object({
      builder: z.enum(["auto", "dockerfile", "nixpacks", "railpack", "buildpacks", "static"]),
      rootDir: z.string(),
      dockerfile: z.string(),
      installCommand: z.string().nullable(),
      buildCommand: z.string().nullable(),
      startCommand: z.string().nullable(),
      publishDir: z.string().nullable(),
      target: z.string().nullable(),
      buildpacksBuilder: z
        .string()
        .trim()
        .max(300)
        .regex(/^[a-z0-9][a-z0-9._/:@-]*$/i, "Enter an image name like heroku/builder:24.")
        .nullable(),
      buildArgs: z.array(z.object({ key: z.string().trim().max(200), value: z.string().max(4000) })).max(100),
      noCache: z.boolean(),
      buildTimeoutMinutes: z.number().int().min(1).max(240).nullable(),
      submodules: z.boolean(),
      watchPaths: z.array(z.string().trim().min(1).max(300)).max(50),
    })
    .partial()
    .optional(),
  runtime: z
    .object({
      port: z.number().int().min(1).max(65535).nullable(),
      replicas: z.number().int().min(1),
      command: z.string().nullable(),
      // A URL path only: it is requested by the proxy and must not carry anything else.
      healthcheckPath: z
        .string()
        .trim()
        .max(300)
        .regex(/^\/?[A-Za-z0-9._~%/?=&+,:@!*()-]*$/, "Use a path like /health")
        .nullable(),
      healthcheckTimeout: z.number().int().min(10).max(1800).nullable(),
      restartPolicy: z.enum(["always", "unless-stopped", "on-failure", "no"]),
      crashLimit: z.number().int().min(1, "At least 1 crash").max(1000, "At most 1000 crashes").nullable(),
      cpuLimit: z.number().min(0.05).max(256).nullable(),
      memoryLimit: z
        .number()
        .int()
        .min(16)
        .max(1024 * 1024)
        .nullable(),
      volumes: volumeListSchema,
      ports: z.array(
        z.object({
          host: z.number().int().min(1).max(65535),
          container: z.number().int().min(1).max(65535),
          protocol: z.enum(["tcp", "udp"]),
          bindAddress: z.enum(["0.0.0.0", "127.0.0.1"]).optional(),
        }),
      ),
      preDeployCommand: z.string().max(4000).nullable(),
      backupBeforeDeploy: z.array(z.string().max(64)),
      postDeployCommand: z.string().max(4000).nullable(),
      deployStrategy: z.enum(["rolling", "recreate"]),
      drainSeconds: z.number().int().min(0).max(600).nullable(),
      restartSchedule: z.string().max(100).nullable(),
      healthcheckPort: z.number().int().min(1).max(65535).nullable(),
      healthcheckInterval: z.number().int().min(1).max(300).nullable(),
      healthcheckStartPeriod: z.number().int().min(0).max(1800).nullable(),
      healthcheckStatus: z
        .string()
        .regex(/^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/, "Use a status or range like 200-399")
        .nullable(),
      healthcheckSuccesses: z.number().int().min(1).max(20).nullable(),
      workingDir: z.string().regex(/^\//, "Use an absolute path").max(500).nullable(),
      user: z
        .string()
        .regex(/^[a-zA-Z0-9_.-]+(:[a-zA-Z0-9_.-]+)?$/, "Use a user like node or 1000:1000")
        .nullable(),
      stopTimeout: z.number().int().min(0).max(3600).nullable(),
      stopSignal: z.enum(["SIGTERM", "SIGINT", "SIGQUIT", "SIGHUP", "SIGUSR1", "SIGUSR2"]).nullable(),
      init: z.boolean(),
      shmSize: z.number().int().min(1).max(65536).nullable(),
      extraHosts: z
        .array(
          z
            .string()
            .trim()
            .regex(/^[a-z0-9.-]+:([0-9a-f.:]+|host-gateway)$/i, "Use hostname:ip lines"),
        )
        .max(50),
      labels: z.array(z.object({ key: z.string().trim().max(200), value: z.string().max(4000) })).max(100),
      logMaxSizeMb: z.number().int().min(1).max(1024).nullable(),
      logMaxFiles: z.number().int().min(1).max(50).nullable(),
      memoryReservation: z
        .number()
        .int()
        .min(16)
        .max(1024 * 1024)
        .nullable(),
      cpuset: z
        .string()
        .trim()
        .max(100)
        .regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/, "Use CPU cores like 0-3 or 0,2")
        .nullable(),
      cpuWeight: z.number().int().min(2).max(262144).nullable(),
      swapLimit: z
        .number()
        .int()
        .min(0)
        .max(1024 * 1024)
        .nullable(),
      swappiness: z.number().int().min(0).max(100).nullable(),
      noNewPrivileges: z.boolean(),
      capDrop: z.array(z.enum(DROP_CAPABILITIES)).max(20),
      privileged: z.boolean(),
      capAdd: z.array(z.enum(CAPABILITIES)).max(20),
      securityOpt: z.array(z.string().trim().regex(SECURITY_OPT_RE, "Use options like apparmor=profile or seccomp=unconfined")).max(10),
      ...containerOptionsSchema,
    })
    .partial()
    .optional(),
  database: z
    .object({
      version: z.string(),
      // "auto": a free port on its server, picked here.
      publicPort: z.union([z.number().int().min(1024).max(65535), z.literal("auto")]).nullable(),
      publicBind: z.enum(["0.0.0.0", "127.0.0.1"]).optional(),
      publicAllow: z.array(z.string().max(100)).max(200).nullable(),
      backupSchedule: z.string().nullable(),
      backupDatabases: z.array(z.string().min(1).max(128)).min(1).nullable(),
      backupRetention: z.number().int().min(1).max(365),
      backupRetentionS3: z.number().int().min(1).max(3650).nullable(),
      backupLocal: z.boolean(),
      backupTimeoutMinutes: z.number().int().min(1).max(10080).nullable(),
      backupLowPriority: z.boolean(),
      /** A new passphrase encrypts the backups from now on; null stops encrypting. */
      backupPassphrase: z.string().min(8, "Use at least 8 characters for the passphrase").max(200).nullable(),
      backupVerify: z.boolean(),
      backupUsers: z.boolean(),
      backupCopyDestinationIds: z.array(z.string().max(64)),
      s3DestinationId: z.string().nullable(),
    })
    .partial()
    .optional(),
  compose: z
    .object({
      content: z.string().optional(),
      path: z.string().optional(),
      /** Stack reaches only its own services, not the rest of the environment. */
      isolated: z.boolean().optional(),
      ports: z
        .array(
          z.object({
            service: z.string().min(1).max(100),
            host: z.number().int().min(1).max(65535),
            container: z.number().int().min(1).max(65535),
            protocol: z.enum(["tcp", "udp"]),
            bindAddress: z.enum(["0.0.0.0", "127.0.0.1"]).optional(),
          }),
        )
        .max(20)
        .optional(),
    })
    .optional(),
});

export async function updateService(serviceId: string, input: z.input<typeof updateSchema>) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const data = updateSchema.parse(input);
    const patch: Partial<typeof schema.service.$inferInsert> = {};
    // Databases backed up before each deploy: database services of this organization.
    for (const id of data.runtime?.backupBeforeDeploy ?? []) {
      const [row] = await db
        .select({ type: schema.service.type, org: schema.project.organizationId, projectId: schema.project.id })
        .from(schema.service)
        .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
        .where(eq(schema.service.id, id));
      if (row?.type !== "database" || row.org !== ctx.org.id || !ctx.canAccessProject(row.projectId))
        throw new UserError("Choose databases of this organization to back up before deploys.");
    }
    if (data.name) {
      if (await serviceNameTaken(service.environmentId, data.name, service.id)) {
        throw new UserError(`Another service in this environment is already called ${data.name}. References like \${{name.KEY}} need unique names.`);
      }
      patch.name = data.name;
    }
    if (data.hostname !== undefined) {
      const hostname = data.hostname && data.hostname !== service.slug ? data.hostname : null;
      if (hostname) {
        if (service.type === "compose") throw new UserError("Compose stacks name each container themselves; set a custom hostname on apps and databases.");
        if (!HOSTNAME_RE.test(hostname)) throw new UserError("Use lowercase letters, numbers and dashes, like postgres or api-db.");
        // The proxy joins every environment network and reaches upstreams by names derived from
        // slugs (<slug>, <slug>-<service>), so a hostname must never match one of those anywhere.
        // Plain names like "db" only need to be unique within their own environment.
        if (hostname.startsWith("serve-")) throw new UserError("Names starting with serve- are reserved.");
        const all = await db
          .select({ id: schema.service.id, environmentId: schema.service.environmentId, slug: schema.service.slug, hostname: schema.service.hostname })
          .from(schema.service);
        const taken = all.find(
          (x) => x.id !== service.id && (x.slug === hostname || hostname.startsWith(`${x.slug}-`) || (x.environmentId === service.environmentId && x.hostname === hostname)),
        );
        if (taken) throw new UserError(`${hostname} is already used by another service. Choose a different name.`);
        // Stack containers are on the environment network too: a compose service called the same
        // would answer to the name inside its stack.
        const stacks = await db
          .select({ name: schema.service.name, compose: schema.service.compose })
          .from(schema.service)
          .where(and(eq(schema.service.environmentId, service.environmentId), eq(schema.service.type, "compose"), ne(schema.service.id, service.id)));
        const stack = stacks.find((s) => {
          try {
            return !!s.compose?.content && composeNameClashes(s.compose.content, [], [hostname]).length > 0;
          } catch {
            return false;
          }
        });
        if (stack) throw new UserError(`The compose stack ${stack.name} in this environment has a service called ${hostname}. Choose a different name.`);
      }
      patch.hostname = hostname;
    }
    if (data.autoDeploy !== undefined) patch.autoDeploy = data.autoDeploy;
    if (data.previewsEnabled !== undefined) {
      // A preview is built as an app from the repository: compose stacks have none.
      if (data.previewsEnabled && service.type !== "app") throw new UserError("Preview deployments are only for apps built from a repository.");
      patch.previewsEnabled = data.previewsEnabled;
    }
    if (data.previewDomain !== undefined) {
      const { normalizePreviewTemplate, previewTemplateProblem } = await import("@/lib/preview-url");
      const template = normalizePreviewTemplate(data.previewDomain);
      if (template) {
        if (service.type !== "app") throw new UserError("Preview deployments are only for apps built from a repository.");
        if (!ctx.can("domains.manage")) throw new UserError("You need permission to manage domains to set the preview URL.");
        const problem = previewTemplateProblem(template);
        if (problem) throw new UserError(problem);
        // Like domains (hostnameSchema), with room for a pull request number of seven digits.
        if (template.replace("{pr}", "1234567").length > 100) throw new UserError("Use a preview URL of at most 100 characters.");
        // Every preview host sits under one wildcard: check it like a wildcard domain.
        const wildcard = `*.${template.slice(template.indexOf(".") + 1)}`;
        await assertNotDashboardHost(ctx, wildcard);
        const ownership = await domainOwnership({ id: ctx.org.id, isRoot: ctx.isRoot }, wildcard);
        if (!ownership.verified) throw new UserError(ownershipMessage(wildcard, ownership));
      }
      patch.previewDomain = template || null;
    }
    if (data.source) {
      if (data.source.type === "git") {
        await assertCredential(data.source.credentialId, ctx.org.id, data.source.repository);
        const commitStatuses = data.source.commitStatuses ?? (service.source?.type === "git" ? service.source.commitStatuses : undefined);
        patch.source = {
          type: "git",
          repository: normalizeRepoUrl(data.source.repository),
          branch: data.source.branch,
          credentialId: data.source.credentialId ?? null,
          // Only "off" is stored: unset means on.
          ...(commitStatuses === false ? { commitStatuses: false } : {}),
        };
      } else if (data.source.type === "dockerfile") {
        if (service.type !== "app") throw new UserError("Only apps can be built from a Dockerfile.");
        patch.source = { type: "dockerfile", content: data.source.content };
        if (!service.build) patch.build = { ...defaultBuild(), builder: "dockerfile" };
      } else if (data.source.type === "upload") {
        if (service.type !== "app") throw new UserError("Only apps can be deployed from the CLI.");
        patch.source = { type: "upload" };
        if (!service.build) patch.build = defaultBuild();
      } else {
        const prev = service.source?.type === "image" ? service.source : null;
        // Left out: keeps the registry it had (older clients do not send the field).
        const registryId = data.source.registryId === undefined ? (prev?.registryId ?? null) : data.source.registryId;
        await assertImageRegistry(registryId, data.source.image, ctx.org.id);
        // The pull logs in to the image's registry: a stored password only goes to the registry it was saved for.
        if (
          !registryId &&
          data.source.registryPassword === undefined &&
          prev?.registryPassword &&
          !sameRegistryHost(splitImage(data.source.image).host, splitImage(prev.image).host)
        )
          throw new UserError("Enter the registry password again: the image is on another registry.");
        patch.source = registryId
          ? { type: "image", image: data.source.image, registryId, registryUsername: null, registryPassword: null }
          : {
              type: "image",
              image: data.source.image,
              registryId: null,
              registryUsername: data.source.registryUsername || null,
              registryPassword:
                data.source.registryPassword === undefined ? (prev?.registryPassword ?? null) : data.source.registryPassword ? encrypt(data.source.registryPassword) : null,
            };
      }
    }
    if (data.build) patch.build = { ...defaultBuild(), ...service.build, ...data.build } as BuildConfig;
    // The builder image's lifecycle runs next to Docker's socket: only known publishers' images go without host rights.
    if (data.build?.buildpacksBuilder && data.build.buildpacksBuilder !== service.build?.buildpacksBuilder) {
      const { knownBuildpacksBuilder } = await import("@/server/deploy/builders");
      if (!knownBuildpacksBuilder(data.build.buildpacksBuilder)) assertHostAccess(ctx, "A buildpacks builder image from another publisher");
    }
    // A service that runs with host-level access: what it runs is an admin's decision too.
    if (hasHostAccess(service.runtime) && (data.source || data.build || data.runtime || data.compose)) assertHostAccess(ctx, "Changing a service that has host-level access");
    if (data.runtime) {
      const runtime = { ...service.runtime, ...data.runtime } as RuntimeConfig;
      const copies = { before: runCopies(service.type, service.runtime, service.distribution), after: runCopies(service.type, runtime, service.distribution) };
      if (runtime.cpuLimit !== service.runtime.cpuLimit || runtime.memoryLimit !== service.runtime.memoryLimit || copies.after > copies.before) {
        await requireResourceChange(ctx.org.id, service.runtime, { cpuLimit: runtime.cpuLimit ?? null, memoryLimit: runtime.memoryLimit ?? null }, copies);
      }
      const addsBind = runtime.volumes.some((v) => v.kind === "bind") && JSON.stringify(runtime.volumes) !== JSON.stringify(service.runtime.volumes);
      const addsPorts = runtime.ports.length > 0 && JSON.stringify(runtime.ports) !== JSON.stringify(service.runtime.ports);
      if (addsBind) assertHostAccess(ctx, "Mounting host paths");
      if (addsPorts) assertHostAccess(ctx, "Publishing host ports");
      if (runtime.ports.some((p) => p.host < 1024 || [80, 443].includes(p.host))) {
        throw new UserError("Ports below 1024 are reserved for the proxy and system services.");
      }
      if (runtime.replicas > 1 && runtime.ports.length) throw new UserError("Published host ports only work with a single replica.");
      const grantsHost = (data.runtime.privileged === true && !service.runtime.privileged) || data.runtime.capAdd?.some((c) => !(service.runtime.capAdd ?? []).includes(c));
      if (grantsHost) assertHostAccess(ctx, "Privileged mode and extra capabilities");
      if (data.runtime.securityOpt?.some((o) => !(service.runtime.securityOpt ?? []).includes(o))) assertHostAccess(ctx, "Security options");
      if (runtime.swapLimit != null && !runtime.memoryLimit) throw new UserError("Set a memory limit first: swap is added on top of it.");
      // Both reach past the organization's limits on a shared server: swap on top of its memory (0, none, is fine), a CPU share over the default.
      if (data.runtime.swapLimit && data.runtime.swapLimit !== service.runtime.swapLimit) assertHostAccess(ctx, "Swap");
      if (data.runtime.cpuWeight != null && data.runtime.cpuWeight > 1024 && data.runtime.cpuWeight !== service.runtime.cpuWeight)
        assertHostAccess(ctx, "A CPU weight above the default (1024)");
      const grantsHardware =
        (!!data.runtime.gpus && data.runtime.gpus !== service.runtime.gpus) ||
        (!!data.runtime.devices?.length && JSON.stringify(data.runtime.devices) !== JSON.stringify(service.runtime.devices ?? []));
      if (grantsHardware) assertHostAccess(ctx, "GPUs and host devices");
      if (data.runtime.labels?.some((l) => /^(serve\.|com\.docker\.)/.test(l.key))) throw new UserError("Labels starting with serve. or com.docker. are reserved.");
      if (data.runtime.restartSchedule) {
        const { CronExpressionParser } = await import("cron-parser");
        try {
          CronExpressionParser.parse(data.runtime.restartSchedule);
        } catch {
          throw new UserError("The restart schedule is not a valid cron expression.");
        }
      }
      patch.runtime = runtime;
    }
    if (data.database && service.database) {
      if (data.database.version && !engines[service.database.engine].versions.includes(data.database.version)) {
        throw new UserError("Unsupported version.");
      }
      if (data.database.backupSchedule) {
        const { CronExpressionParser } = await import("cron-parser");
        try {
          CronExpressionParser.parse(data.database.backupSchedule);
        } catch {
          throw new UserError("The backup schedule is not a valid cron expression.");
        }
      }
      // Every bucket a backup goes to must be the organization's.
      for (const id of data.database.backupCopyDestinationIds ?? []) {
        const [dest] = await db
          .select({ id: schema.s3Destination.id })
          .from(schema.s3Destination)
          .where(and(eq(schema.s3Destination.id, id), eq(schema.s3Destination.organizationId, ctx.org.id)));
        if (!dest) throw new UserError("Backup storage not found.");
      }
      if (data.database.s3DestinationId) {
        const [dest] = await db
          .select({ id: schema.s3Destination.id })
          .from(schema.s3Destination)
          .where(and(eq(schema.s3Destination.id, data.database.s3DestinationId), eq(schema.s3Destination.organizationId, ctx.org.id)));
        if (!dest) throw new UserError("Backup storage not found.");
      }
      if (data.database.publicAllow) {
        const r = normalizeTrustedRanges(data.database.publicAllow, { anyWidth: true });
        if ("error" in r) throw new UserError(r.error);
        data.database.publicAllow = r.ranges.length ? r.ranges : null;
      }
      if (data.database.publicPort === "auto") {
        const { freePublicPort } = await import("@/server/databases/domain-tls");
        data.database.publicPort = service.database.publicPort ?? (await freePublicPort(service, engines[service.database.engine].port));
      }
      // Resolved above: never "auto" from here on.
      const nextPort = data.database.publicPort as number | null | undefined;
      // A public port once set stays: clients and firewalls point at it. Turning it off frees it.
      if (nextPort && service.database.publicPort && nextPort !== service.database.publicPort)
        throw new UserError(`The public port is ${service.database.publicPort} and stays: clients and firewalls use it. Turn public access off and on again for a new one.`);
      if (nextPort && nextPort !== (service.database.publicPort ?? null)) {
        // The firewall rules of an allowlist follow this port: it must be free, not another tenant's.
        const { busyHostPorts } = await import("@/server/services/ports");
        const { heldDatabasePorts } = await import("@/server/databases/public-ports");
        if ((await heldDatabasePorts(service.serverId, { serviceId, holder: "database" })).has(nextPort) || (await busyHostPorts(service)).includes(nextPort))
          throw new UserError(`Port ${nextPort} is already used on this server.`);
      }
      // Whoever sets the passphrase decides who can restore: admins only, like restores.
      if (data.database.backupPassphrase !== undefined && !ctx.isAdmin) throw new UserError("Only organization admins can change backup encryption.");
      // Kept encrypted with Serve's key; the browser never gets it back.
      if (typeof data.database.backupPassphrase === "string") data.database.backupPassphrase = encrypt(data.database.backupPassphrase);
      patch.database = { ...service.database, ...data.database, publicPort: nextPort === undefined ? service.database.publicPort : nextPort };
      // Public access changed by hand: it is the user's now, not something the domain opened.
      const before = service.database;
      const moved =
        (data.database.publicPort !== undefined && data.database.publicPort !== (before.publicPort ?? null)) ||
        (data.database.publicBind !== undefined && data.database.publicBind !== (before.publicBind ?? "0.0.0.0"));
      if (moved && before.domainOpened?.public) patch.database.domainOpened = { ...before.domainOpened, public: false };
    }
    if (data.compose && service.compose) {
      if (data.compose.content !== undefined && service.compose.mode === "inline") {
        try {
          parseCompose(data.compose.content);
        } catch (e) {
          throw new UserError(`The compose file is not valid: ${(e as Error).message}`);
        }
        await assertSafeCompose(ctx, data.compose.content, service.environmentId, serviceId);
      }
      if (data.compose.ports) {
        const ports = data.compose.ports;
        if (ports.length && JSON.stringify(ports) !== JSON.stringify(service.compose.ports ?? [])) assertHostAccess(ctx, "Publishing host ports");
        if (ports.some((p) => p.host < 1024)) throw new UserError("Ports below 1024 are reserved for the proxy and system services.");
        const seen = new Set<string>();
        for (const p of ports) {
          const key = `${p.host}/${p.protocol}`;
          if (seen.has(key)) throw new UserError(`Port ${p.host} is used twice.`);
          seen.add(key);
        }
      }
      patch.compose = { ...service.compose, ...data.compose };
    }
    // Who last set up a stack's file, repository or branch decides whether its host-level options may deploy.
    if (service.type === "compose" && service.compose && (data.compose || data.source)) {
      patch.compose = { ...(patch.compose ?? service.compose), hostAccess: ctx.isInstanceAdmin && ctx.isRoot };
    }
    await db.update(schema.service).set(patch).where(eq(schema.service.id, serviceId));
    if (data.source) await syncRepoWebhook(service.source, serviceId);
    if (data.runtime?.port !== undefined) await syncServiceProxy(serviceId).catch(() => {});
    return null;
  });
}

export async function regenerateWebhookSecret(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    await db.update(schema.service).set({ webhookSecret: newWebhookSecret() }).where(eq(schema.service.id, serviceId));
    // A hook Serve registered carries the old secret: register it again with the new one.
    if (service.source?.type === "git" && service.source.webhook?.id) await registerRepoWebhook(serviceId);
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/*                                 Lifecycle                                  */
/* -------------------------------------------------------------------------- */

/** Remove one pull request preview (and its database copy) before the pull request closes. */
export async function removePreviewService(previewId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service: preview } = await serviceInOrg(previewId, ctx.org.id);
    if (!preview.parentServiceId || preview.previewPr === null || preview.type !== "app") throw new UserError("This is not a pull request preview.");
    const [parent] = await db.select().from(schema.service).where(eq(schema.service.id, preview.parentServiceId));
    if (!parent) throw new UserError("The app of this preview no longer exists.");
    const { removePreview } = await import("@/server/services/previews");
    await removePreview(parent, preview.previewPr);
    return null;
  });
}

/** The app's parent checks for starting a preview by hand: an app (not a preview) with previews on. */
async function previewParent(serviceId: string, orgId: string, source: "git" | "image") {
  const { service } = await serviceInOrg(serviceId, orgId);
  if (service.type !== "app" || service.parentServiceId) throw new UserError("Previews are for apps.");
  if (service.source?.type !== source) throw new UserError(source === "git" ? "This app is not built from a repository." : "This app does not run an image.");
  if (!service.previewsEnabled) throw new UserError("Preview deployments are off. Turn them on in Settings → Previews.");
  return service;
}

/** The repository's open pull requests, with the preview each one has, to deploy ones opened before previews were on. */
export async function listOpenPullRequests(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const service = await previewParent(serviceId, ctx.org.id, "git");
    const { openPullRequests } = await import("@/server/git/pull-requests");
    let prs: Awaited<ReturnType<typeof openPullRequests>>;
    try {
      prs = await openPullRequests(service);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const previews = await db.select({ id: schema.service.id, pr: schema.service.previewPr }).from(schema.service).where(eq(schema.service.parentServiceId, service.id));
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.branch,
      author: pr.author,
      fork: pr.fork,
      url: pr.url,
      updatedAt: pr.updatedAt,
      previewId: previews.find((p) => p.pr === pr.number)?.id ?? null,
    }));
  });
}

/** Deploys the preview of one open pull request, read again from the provider. */
export async function deployPullRequestPreview(serviceId: string, number: number) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const n = z.number().int().min(1).max(1e9).parse(number);
    const service = await previewParent(serviceId, ctx.org.id, "git");
    const { openPullRequests } = await import("@/server/git/pull-requests");
    const prs = await openPullRequests(service).catch((e: Error) => {
      throw new UserError(e.message);
    });
    const pr = prs.find((p) => p.number === n);
    if (!pr) throw new UserError(`Pull request #${n} is not open.`);
    if (pr.fork) throw new UserError("Pull requests from forks are not deployed: they would run outside code with this app's variables.");
    const { deployPreview } = await import("@/server/services/previews");
    const result = await deployPreview(service, pr);
    if (!result) throw new UserError("The preview could not be created.");
    return { previewId: result.preview.id, deploymentId: result.deploymentId };
  });
}

/** Creates or updates the preview of an image app: a pull request number and the image tag it runs. */
export async function deployImagePreview(serviceId: string, input: { pr: number; tag: string }) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const data = z.object({ pr: z.number().int().min(1).max(1e9), tag: z.string().trim().min(1).max(200) }).parse(input);
    const service = await previewParent(serviceId, ctx.org.id, "image");
    const { deployPreview, imageWithTag } = await import("@/server/services/previews");
    const image = service.source?.type === "image" ? imageWithTag(service.source.image, data.tag) : null;
    if (!image) throw new UserError("Use an image tag like pr-12, or a digest like sha256:….");
    const result = await deployPreview(service, { number: data.pr, branch: "", repository: "", title: `Image ${image}`, sha: null, author: null, image }).catch((e) => {
      if (e instanceof UserError) throw e;
      throw new UserError((e as Error).message);
    });
    if (!result) throw new UserError("The preview could not be created.");
    return { previewId: result.preview.id, deploymentId: result.deploymentId };
  });
}

/** Where a service can be cloned to: the organization's projects with their environments, and its servers. */
export async function cloneTargets() {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { serversForOrg } = await import("@/server/servers/access");
    const rows = await db
      .select({ projectId: schema.project.id, projectName: schema.project.name, environmentId: schema.environment.id, environmentName: schema.environment.name })
      .from(schema.environment)
      .innerJoin(schema.project, eq(schema.environment.projectId, schema.project.id))
      .where(eq(schema.project.organizationId, ctx.org.id))
      .orderBy(asc(schema.project.name), asc(schema.environment.createdAt));
    const projects = new Map<string, { id: string; name: string; environments: { id: string; name: string }[] }>();
    for (const r of rows) {
      if (!ctx.canAccessProject(r.projectId)) continue;
      const p = projects.get(r.projectId) ?? { id: r.projectId, name: r.projectName, environments: [] };
      p.environments.push({ id: r.environmentId, name: r.environmentName });
      projects.set(r.projectId, p);
    }
    const servers = (await serversForOrg(ctx.org.id)).filter((s) => s.isLocal || s.status === "ready").map((s) => ({ id: s.id, name: s.name }));
    return { projects: [...projects.values()], servers };
  });
}

/** Copies a service into an environment of the organization, on one of its servers. Nothing is deployed. */
export async function cloneServiceAction(serviceId: string, input: { name?: string; environmentId: string; serverId: string; copyData?: boolean }) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const data = z
      .object({ name: serviceName.optional(), environmentId: z.string().min(1).max(64), serverId: z.string().min(1).max(64), copyData: z.boolean().optional() })
      .parse(input);
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.parentServiceId) throw new UserError("Previews cannot be cloned: clone the app they belong to.");
    const { cloneService, environmentInOrg } = await import("@/server/services/clone");
    const env = await environmentInOrg(data.environmentId, ctx.org.id);
    if (!env || !ctx.canAccessProject(env.projectId)) throw new UserError("Environment not found.");
    await resolveServerForOrg(data.serverId, ctx.org.id);
    const { requireRoomFor } = await import("@/server/limits");
    await requireRoomFor(ctx.org.id, [{ type: service.type, runtime: service.runtime, distribution: data.serverId === service.serverId ? service.distribution : null }]);
    // Reading the data to copy it is a backup's right too.
    if (data.copyData && !ctx.can("databases.backups")) throw new UserError(cannotMessage("databases.backups"));
    return cloneService(service, { ...data, userId: ctx.user.id, hostAccess: ctx.isInstanceAdmin && ctx.isRoot });
  });
}

export async function deployService(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type === "app" && !service.source) throw new UserError("Connect a source before deploying.");
    if ((await lastUploadOf(serviceId)) === "none") throw new UserError(NO_UPLOAD);
    const id = await queueDeployment(serviceId, "manual", { userId: ctx.user.id });
    return { id };
  });
}

/** Deploy once without the build cache (fresh base images and layers). */
export async function deployWithoutCache(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type !== "app" || !buildsImage(service.source?.type) || !service.build) throw new UserError("Only services Serve builds have a build cache.");
    await db
      .update(schema.service)
      .set({ build: { ...service.build, noCacheOnce: true } })
      .where(eq(schema.service.id, serviceId));
    const id = await queueDeployment(serviceId, "manual", { userId: ctx.user.id });
    return { id };
  });
}

export async function redeployDeployment(deploymentId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const [dep] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
    if (!dep) throw new UserError("Deployment not found.");
    await serviceInOrg(dep.serviceId, ctx.org.id);
    // Uploaded files are built again as they were, with the commit they were sent with.
    if (dep.upload && !(await uploadExists(dep.upload.archive)))
      throw new UserError(`The files of this upload were deleted (Serve keeps those of the last ${KEEP_UPLOADS} uploads). Run serve deploy again.`);
    const id = await queueDeployment(
      dep.serviceId,
      "redeploy",
      dep.upload ? { userId: ctx.user.id, upload: dep.upload, commitSha: dep.commitSha, commitMessage: dep.commitMessage, branch: dep.branch } : { userId: ctx.user.id },
    );
    return { id };
  });
}

export async function rollbackTo(deploymentId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const [dep] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
    if (!dep) throw new UserError("Deployment not found.");
    const { service } = await serviceInOrg(dep.serviceId, ctx.org.id);
    if (service.type === "compose") {
      const { composeRollbackProblem } = await import("@/server/deploy/compose");
      const problem = composeRollbackProblem(dep);
      if (problem) throw new UserError(problem);
    } else if (service.type !== "app") throw new UserError("Rollbacks are available for apps and compose stacks.");
    else if (dep.status !== "success" || !dep.image) throw new UserError("Only successful deployments can be restored.");
    const id = await queueDeployment(dep.serviceId, "rollback", { userId: ctx.user.id, rollbackOf: dep.id });
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "deploy.rollback",
      targetType: "service",
      targetId: service.id,
      message: `Rolled back ${service.name}`,
    });
    return { id };
  });
}

export async function cancelDeployment(deploymentId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const [dep] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
    if (!dep) throw new UserError("Deployment not found.");
    await serviceInOrg(dep.serviceId, ctx.org.id);
    // Waiting for approval: nothing runs yet, so it simply ends.
    if (dep.status === "waiting") {
      await db
        .update(schema.deployment)
        .set({ status: "cancelled", finishedAt: new Date(), logs: "Cancelled while it waited for approval.\n" })
        .where(and(eq(schema.deployment.id, deploymentId), eq(schema.deployment.status, "waiting")));
      await queueCommitStatus(deploymentId);
      return null;
    }
    if (dep.status === "queued") {
      const [cancelled] = await db
        .update(schema.deployment)
        .set({ status: "cancelled", finishedAt: new Date(), logs: "Cancelled before it started.\n" })
        .where(and(eq(schema.deployment.id, deploymentId), eq(schema.deployment.status, "queued")))
        .returning({ id: schema.deployment.id });
      if (cancelled) {
        await queueCommitStatus(deploymentId);
        await settleCancelledStatus(dep.serviceId);
        return null;
      }
      // The worker picked it up in the meantime: cancel the running deployment instead.
      const [now] = await db.select({ status: schema.deployment.status }).from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
      dep.status = now?.status ?? dep.status;
    }
    if (dep.status === "building" || dep.status === "deploying") {
      await sql.notify(CANCEL_CHANNEL, deploymentId);
    } else if (dep.status !== "queued") {
      throw new UserError("This deployment has already finished.");
    }
    return null;
  });
}

/**
 * Starts a queued deployment now, past its build server's limit of concurrent builds. Deployments
 * of the same service that run or wait ahead of it are cancelled: two at once would fight over the
 * service, and the newer one wins. It starts as soon as the cancelled one has stopped.
 */
export async function forceStartDeployment(deploymentId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const [dep] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
    if (!dep) throw new UserError("Deployment not found.");
    const { service } = await serviceInOrg(dep.serviceId, ctx.org.id);
    if (dep.status !== "queued") throw new UserError("This deployment is not waiting any more.");
    const [job] = await db
      .select()
      .from(schema.job)
      .where(and(eq(schema.job.type, "deploy"), eq(schema.job.status, "pending"), dsql`${schema.job.payload}->>'deploymentId' = ${deploymentId}`));
    if (!job) throw new UserError("This deployment is starting already.");
    if (job.concurrencyKey) {
      // Something else of the service runs (a start, a restart): that is not ours to cancel.
      const running = await db
        .select({ type: schema.job.type, payload: schema.job.payload })
        .from(schema.job)
        .where(and(eq(schema.job.status, "running"), eq(schema.job.concurrencyKey, job.concurrencyKey)));
      if (running.some((j) => j.type !== "deploy")) throw new UserError(`${service.name} is busy with another task. This deployment starts when it ends.`);
    }
    // The deployments in the way: the one running, and older ones still queued (they would run first).
    const ahead = await db
      .select({ id: schema.deployment.id, status: schema.deployment.status })
      .from(schema.deployment)
      .where(
        and(
          eq(schema.deployment.serviceId, dep.serviceId),
          ne(schema.deployment.id, dep.id),
          or(inArray(schema.deployment.status, ["building", "deploying"]), and(eq(schema.deployment.status, "queued"), lt(schema.deployment.createdAt, dep.createdAt))),
        ),
      );
    for (const other of ahead) {
      if (other.status === "queued") {
        const [cancelled] = await db
          .update(schema.deployment)
          .set({ status: "cancelled", finishedAt: new Date(), logs: "Cancelled: a newer deployment was force started.\n" })
          .where(and(eq(schema.deployment.id, other.id), eq(schema.deployment.status, "queued")))
          .returning({ id: schema.deployment.id });
        if (cancelled) {
          await queueCommitStatus(other.id);
          continue;
        }
      }
      // Running (or it just started): the worker stops it, and the previous version keeps running.
      await sql.notify(CANCEL_CHANNEL, other.id);
    }
    await db
      .update(schema.job)
      .set({ payload: { ...(job.payload as object), force: true }, runAt: new Date() })
      .where(and(eq(schema.job.id, job.id), eq(schema.job.status, "pending")));
    await sql.notify(JOB_CHANNEL, job.id).catch(() => {});
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "deployment.force-started",
      targetType: "service",
      targetId: service.id,
      message: `Force started a deployment of ${service.name}${ahead.length ? `, cancelling ${ahead.length === 1 ? "the one before it" : `${ahead.length} before it`}` : ""}`,
    });
    return null;
  });
}

/** A move sets "deploying" before it queues its deployment: cancelling that deployment must not leave it so. */
async function settleCancelledStatus(serviceId: string) {
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  if (service?.status !== "deploying") return;
  const [active] = await db
    .select({ id: schema.deployment.id })
    .from(schema.deployment)
    .where(and(eq(schema.deployment.serviceId, serviceId), inArray(schema.deployment.status, ["queued", "building", "deploying"])))
    .limit(1);
  // A queued start or restart job sets its own status when it runs.
  const [job] = await db
    .select({ id: schema.job.id })
    .from(schema.job)
    .where(
      and(
        eq(schema.job.concurrencyKey, `service:${serviceId}`),
        inArray(schema.job.status, ["pending", "running"]),
        inArray(schema.job.type, ["service.start", "service.restart"]),
      ),
    )
    .limit(1);
  if (active || job) return;
  const { getServer } = await import("@/server/servers/context");
  const { listServiceContainers } = await import("@/server/docker/client");
  const server = await getServer(service.serverId).catch(() => null);
  const running = server ? (await listServiceContainers(serviceId, false, server.docker).catch(() => [])).length > 0 : false;
  await db
    .update(schema.service)
    .set({ status: running ? "running" : "idle" })
    .where(and(eq(schema.service.id, serviceId), eq(schema.service.status, "deploying")));
}

export async function serviceControl(serviceId: string, command: "stop" | "start" | "restart") {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    await requestServiceControl(service, command, ctx.user.id);
    return null;
  });
}

/** The compose file Serve last deployed for a stack: the user's file plus labels, networks and ports. Values stay in .env. */
export async function deployedCompose(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("projects.view");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type !== "compose" || !service.compose) throw new UserError("Only Docker Compose services have a compose file.");
    const { default: fs } = await import("node:fs/promises");
    const path = await import("node:path");
    const { paths } = await import("@/server/paths");
    const { containedPath } = await import("@/server/security");
    const root = paths.service(service.id);
    const dir = service.compose.mode === "git" ? path.dirname(containedPath(path.join(root, "repo"), service.compose.path, "Compose file path")) : path.join(root, "compose");
    const file = path.join(dir, ".serve-compose.yml");
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return null;
    return { content: await fs.readFile(file, "utf8"), writtenAt: stat.mtime.toISOString() };
  });
}

/** Restart one container of a service (for example one compose service), without a deployment. */
export async function restartContainer(serviceId: string, containerId: string, serverId?: string | null) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (!(await restartOwnContainer(service, containerId, serverId))) throw new UserError("This container is not part of the service any more.");
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      organizationId: ctx.org.id,
      action: "service.container.restart",
      message: `Restarted container ${containerId.slice(0, 12)} of ${service.name}`,
      targetType: "service",
      targetId: service.id,
    });
    return null;
  });
}

/**
 * Move a service to another server: its containers on the old server are
 * removed (data volumes stay there) and it is deployed fresh on the new one.
 */
export async function moveService(serviceId: string, serverId: string, opts: { force?: boolean } = {}) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.parentServiceId) throw new UserError("Preview deployments follow their parent service.");
    if (service.serverId === serverId) throw new UserError("The service already runs on that server.");
    if (usesOutsideResources(service)) throw new UserError("This service keeps its data or network names in volumes and networks of its server. It stays on that server.");
    const target = await resolveServerForOrg(serverId, ctx.org.id);
    await requireRoom(ctx.org.id, { serverId: target.id });
    const [source] = await db.select({ name: schema.server.name }).from(schema.server).where(eq(schema.server.id, service.serverId));
    if (service.type === "database" && !opts.force) {
      throw new UserError(
        `Moving a database starts it empty on ${target.name}. Its data stays in a volume on ${source?.name ?? "the old server"}. Back it up and restore it after the move.${
          service.database?.replica?.enabled || service.database?.pooler?.public
            ? " Its read replicas copy it again, and the public access of its pooler and replicas is turned off until you set it again."
            : ""
        }`,
      );
    }
    const [busy] = await db
      .select({ id: schema.deployment.id })
      .from(schema.deployment)
      .where(and(eq(schema.deployment.serviceId, serviceId), inArray(schema.deployment.status, ["queued", "building", "deploying"])))
      .limit(1);
    if (busy) throw new UserError("Wait for the running deployment to finish first.");

    // Old containers go first (same concurrency key as deployments, so it runs before the new deploy).
    await enqueue(
      "service.delete",
      {
        serviceId,
        slug: service.slug,
        type: service.type,
        removeVolumes: false,
        environmentId: service.environmentId,
        serverId: service.serverId,
        keepFiles: true,
        keepServerFiles: true,
      },
      { concurrencyKey: `service:${serviceId}` },
    );
    // Stop routing on the old server right away, without waiting on it: it may be gone for good, and
    // the delete job cleans it up too.
    void removeServiceProxy(serviceId, service.serverId).catch(() => {});
    // The new server can no longer be an extra or the separate build server of this service.
    const distribution = service.distribution
      ? {
          ...service.distribution,
          buildServerId: service.distribution.buildServerId === target.id ? null : (service.distribution.buildServerId ?? null),
          extraServerIds: (service.distribution.extraServerIds ?? []).filter((id) => id !== target.id),
        }
      : null;
    await db.update(schema.service).set({ serverId: target.id, status: "deploying", distribution }).where(eq(schema.service.id, serviceId));

    // A database starts empty there: its replicas copy it again (those on the old server move with
    // it), and the public side of its pooler and replicas (ports and DNS of the old servers) is off
    // until it is set again.
    if (service.type === "database" && service.database && (service.database.pooler || service.database.replica)) {
      const cfg = service.database;
      const { replicaInstances } = await import("@/server/services/types");
      const { removeReplicaInstance } = await import("@/server/databases/addons");
      const { syncAddonDomain } = await import("@/server/databases/addon-domains");
      const before = replicaInstances(service);
      const leftovers: string[] = [];
      const { leftover, recordLeftovers } = await import("@/server/services/leftovers");
      for (const r of before) await removeReplicaInstance(service, r).catch(leftover(leftovers, `Read replica ${r.id} of ${service.name}`));
      await recordLeftovers(leftovers, { projectId: service.projectId, userId: ctx.user.id });
      if (cfg.pooler?.public) await syncAddonDomain(service, cfg.pooler.public, null, [service.serverId], ctx.org.id).catch(() => []);
      if (cfg.replica?.public) await syncAddonDomain(service, cfg.replica.public, null, [...new Set(before.map((r) => r.serverId))], ctx.org.id).catch(() => []);
      // A replica on a server the new one shares no private network with could not reach it: it goes.
      const { meshMemberIds, privatelyConnected } = await import("@/server/mesh/members");
      const members = await meshMemberIds();
      const instances = before
        .map((r) => ({ id: r.id, serverId: r.serverId === service.serverId ? target.id : r.serverId }))
        .filter((r) => privatelyConnected(members, target.id, r.serverId));
      await db
        .update(schema.service)
        .set({
          database: {
            ...cfg,
            pooler: cfg.pooler ? { ...cfg.pooler, public: null } : cfg.pooler,
            replica: cfg.replica ? { ...cfg.replica, enabled: instances.length > 0, instances, public: null } : cfg.replica,
          },
        })
        .where(eq(schema.service.id, serviceId));
    }

    // Generated domains carry the server's address (sslip.io / wildcard); give them the new one.
    const domains = await db
      .select()
      .from(schema.domain)
      .where(and(eq(schema.domain.serviceId, serviceId), eq(schema.domain.generated, true)));
    for (const d of domains) {
      const next = await generatedHostname(service.slug, target.id);
      if (!next || next.hostname === d.hostname) continue;
      const [taken] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, next.hostname));
      if (!taken) await db.update(schema.domain).set({ hostname: next.hostname, https: next.https, forceHttps: next.https }).where(eq(schema.domain.id, d.id));
    }

    // Tunnel domains follow the service when the new server has a tunnel to the same Cloudflare account.
    const tunneled = await db
      .select()
      .from(schema.domain)
      .where(and(eq(schema.domain.serviceId, serviceId), isNotNull(schema.domain.tunnelId)));
    if (tunneled.length) {
      const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
      const touched = new Set<string>();
      for (const d of tunneled) {
        const [old] = await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, d.tunnelId!));
        const [next] = old
          ? await db
              .select()
              .from(schema.cloudflareTunnel)
              .where(and(eq(schema.cloudflareTunnel.serverId, target.id), eq(schema.cloudflareTunnel.cloudflareAccountId, old.cloudflareAccountId)))
          : [];
        if (old) touched.add(old.id);
        if (next && d.cloudflareZoneId) {
          const cf = await Cloudflare.forAccount(next.cloudflareAccountId);
          await cf.upsertTunnelRecord(d.cloudflareZoneId, d.hostname, next.cfTunnelId).catch(() => {});
          await db.update(schema.domain).set({ tunnelId: next.id }).where(eq(schema.domain.id, d.id));
          touched.add(next.id);
        } else {
          await db.update(schema.domain).set({ tunnelId: null }).where(eq(schema.domain.id, d.id));
        }
      }
      for (const id of touched) await syncTunnelIngress(id).catch(() => {});
    }
    // Domains that want a tunnel pick up any tunnel of the new server whose account owns their zone.
    const { reattachOnServer } = await import("@/server/cloudflare/tunnels");
    await reattachOnServer(target.id).catch(() => {});

    const deploymentId = await queueDeployment(serviceId, "redeploy", { userId: ctx.user.id });
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.moved",
      targetType: "service",
      targetId: serviceId,
      message: `Moved ${service.name} from ${source?.name ?? "another server"} to ${target.name}${service.runtime.volumes.length || service.type !== "app" ? ". Data volumes stay on the old server" : ""}`,
    });
    return { deploymentId };
  });
}

export async function deleteService(serviceId: string, removeVolumes: boolean, password?: string | null) {
  return act(async () => {
    const ctx = await requirePermission("services.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    await requireDeleteProof(ctx, password);
    // The DNS records Serve made for its domains go with it (teardownServices).
    const warning = await teardownServices([service], removeVolumes, { userId: ctx.user.id });
    await logActivity({ userId: ctx.user.id, projectId: service.projectId, action: "service.deleted", message: `Deleted ${service.name}` });
    return warning ? { warning } : null;
  });
}

/* -------------------------------------------------------------------------- */
/*                                 Variables                                  */
/* -------------------------------------------------------------------------- */

/** `keep`: keep the stored value of that key (the editor did not receive it). */
type VarInput = { key: string; value: string; buildTime: boolean; runtime: boolean; literal?: boolean; multiline?: boolean; keep?: string };

/** Variables as the forms send them: names and values with a size cap, at most a few hundred. */
const varsSchema = z
  .array(
    z.object({
      key: z.string().max(200),
      value: z.string().max(256 * 1024),
      buildTime: z.boolean().default(true),
      runtime: z.boolean().default(true),
      literal: z.boolean().default(false),
      multiline: z.boolean().default(false),
      keep: z.string().max(200).optional(),
    }),
  )
  .max(500);

async function writeEnvVars(serviceId: string, vars: VarInput[]) {
  const keys = new Set<string>();
  for (const v of vars) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(v.key)) throw new UserError(`"${v.key}" is not a valid variable name.`);
    if (keys.has(v.key)) throw new UserError(`${v.key} is defined twice.`);
    keys.add(v.key);
  }
  await db.transaction(async (tx) => {
    await tx.delete(schema.envVar).where(eq(schema.envVar.serviceId, serviceId));
    if (vars.length) {
      await tx.insert(schema.envVar).values(
        vars.map((v) => ({
          id: newId(),
          serviceId,
          key: v.key,
          value: encrypt(v.value),
          buildTime: v.buildTime,
          runtime: v.runtime,
          literal: v.literal ?? false,
          multiline: v.multiline ?? false,
        })),
      );
    }
  });
}

export async function saveEnvVars(serviceId: string, input: VarInput[], redeploy: boolean) {
  return act(async () => {
    const ctx = await requirePermission("variables.edit");
    // The redeploy is a deployment: it needs that permission too, checked before anything is saved.
    if (redeploy && !ctx.can("services.deploy")) throw new UserError(cannotMessage("services.deploy"));
    const vars = varsSchema.parse(input);
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (hasHostAccess(service.runtime)) assertHostAccess(ctx, "Changing the variables of a service that has host-level access");
    const stored = await db.select({ key: schema.envVar.key, value: schema.envVar.value }).from(schema.envVar).where(eq(schema.envVar.serviceId, serviceId));
    const { decryptOrNull } = await import("@/server/crypto");
    const next = vars
      .map((v) => {
        const flags = { buildTime: v.buildTime, runtime: v.runtime, literal: v.literal, multiline: v.multiline };
        if (v.keep === undefined) return { key: v.key.trim(), value: v.value, ...flags };
        const kept = stored.find((s) => s.key === v.keep);
        if (!kept) throw new UserError(`${v.keep} no longer exists. Reload the page.`);
        return { key: v.key.trim(), value: decryptOrNull(kept.value) ?? "", ...flags };
      })
      .filter((v) => v.key);
    // A compose file a Root admin allowed host options for: its variables can point those options
    // anywhere (a bind source of ${DATA_DIR}), so only Root admins change the ones it uses.
    if (service.compose?.hostAccess && !(ctx.isInstanceAdmin && ctx.isRoot) && composeSecurityIssues(service.compose.content).length) {
      // Also the ones they reference: DATA_DIR=${{BASE}} changes with BASE.
      const { hostStackReachOf } = await import("@/server/services/variables");
      const used = [...(await hostStackReachOf(service, ctx.org.id))].filter((k) => k.startsWith("own:")).map((k) => k.slice(4));
      const before = new Map(stored.map((v) => [v.key, decryptOrNull(v.value) ?? ""]));
      const after = new Map(next.map((v) => [v.key, v.value]));
      const changed = used.filter((k) => before.get(k) !== after.get(k));
      if (changed.length) throw new UserError(`This compose file uses host options, so only admins of the Root organization can change ${changed.slice(0, 3).join(", ")}.`);
    }
    await writeEnvVars(serviceId, next);
    let deploymentId: string | null = null;
    if (redeploy && service.status !== "idle") deploymentId = await queueDeployment(serviceId, "redeploy", { userId: ctx.user.id });
    return { deploymentId };
  });
}

/**
 * Variables of one replica (number from 1), on top of the service's variables. `keep` keeps a
 * stored value the editor did not receive. An empty list removes the replica's variables.
 */
export async function saveReplicaVars(serviceId: string, replica: number, input: { key: string; value: string; keep?: string }[], redeploy: boolean) {
  return act(async () => {
    const ctx = await requirePermission("variables.edit");
    // The redeploy is a deployment: it needs that permission too, checked before anything is saved.
    if (redeploy && !ctx.can("services.deploy")) throw new UserError(cannotMessage("services.deploy"));
    const vars = varsSchema.parse(input);
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type !== "app") throw new UserError("Only apps have replicas.");
    if (!Number.isInteger(replica) || replica < 1) throw new UserError("Unknown replica.");
    await db.transaction(async (tx) => {
      // Locked, so two replica cards saved at the same moment both keep their change.
      const [row] = await tx.select({ replicaVars: schema.service.replicaVars }).from(schema.service).where(eq(schema.service.id, serviceId)).for("update");
      const stored = row?.replicaVars?.[replica] ?? {};
      const next: Record<string, string> = {};
      for (const v of vars) {
        const key = v.key.trim();
        if (!key) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new UserError(`"${key}" is not a valid variable name.`);
        if (Object.hasOwn(next, key)) throw new UserError(`${key} is defined twice.`);
        if (v.keep !== undefined) {
          if (!Object.hasOwn(stored, v.keep)) throw new UserError(`${v.keep} no longer exists. Reload the page.`);
          next[key] = stored[v.keep];
        } else next[key] = encrypt(v.value);
      }
      const all = { ...(row?.replicaVars ?? {}) };
      if (Object.keys(next).length) all[replica] = next;
      else delete all[replica];
      await tx
        .update(schema.service)
        .set({ replicaVars: Object.keys(all).length ? all : null })
        .where(eq(schema.service.id, serviceId));
    });
    let deploymentId: string | null = null;
    if (redeploy && service.status !== "idle") deploymentId = await queueDeployment(serviceId, "redeploy", { userId: ctx.user.id });
    return { deploymentId };
  });
}

/**
 * Variables only pull request previews get, replacing the service's variables with the same name.
 * `keep` keeps a stored value the editor did not receive. Open previews get the change at once.
 */
export async function savePreviewVars(serviceId: string, input: { key: string; value: string; keep?: string }[]) {
  return act(async () => {
    const ctx = await requirePermission("variables.edit");
    const vars = varsSchema.parse(input);
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type !== "app" || service.parentServiceId) throw new UserError("Only apps with pull request previews have preview variables.");
    let before: Record<string, string> = {};
    let after: Record<string, string> = {};
    await db.transaction(async (tx) => {
      const [row] = await tx.select({ previewVars: schema.service.previewVars }).from(schema.service).where(eq(schema.service.id, serviceId)).for("update");
      before = row?.previewVars ?? {};
      const next: Record<string, string> = {};
      for (const v of vars) {
        const key = v.key.trim();
        if (!key) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new UserError(`"${key}" is not a valid variable name.`);
        if (Object.hasOwn(next, key)) throw new UserError(`${key} is defined twice.`);
        if (v.keep !== undefined) {
          if (!Object.hasOwn(before, v.keep)) throw new UserError(`${v.keep} no longer exists. Reload the page.`);
          next[key] = before[v.keep];
        } else next[key] = encrypt(v.value);
      }
      after = next;
      await tx
        .update(schema.service)
        .set({ previewVars: Object.keys(next).length ? next : null })
        .where(eq(schema.service.id, serviceId));
    });
    const { syncPreviewVars } = await import("@/server/services/previews");
    await syncPreviewVars(service, before, after);
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "service.preview-vars",
      targetType: "service",
      targetId: service.id,
      message: `Saved preview variables of ${service.name}`,
    });
    return { deploymentId: null as string | null };
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Domains                                   */
/* -------------------------------------------------------------------------- */

const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((h) => h.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
  // The proxy's server name table holds names up to about 110 characters: a longer one fails its whole config.
  .pipe(
    z
      .string()
      .max(100, "Use a domain of at most 100 characters.")
      .regex(/^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/, "Enter a valid domain like app.example.com"),
  );

const domainSchema = z.object({
  hostname: hostnameSchema,
  port: z.number().int().min(1).max(65535).nullable().optional(),
  composeService: z.string().nullable().optional(),
  https: z.boolean().default(true),
  forceHttps: z.boolean().default(true),
  redirectTo: z.string().trim().nullable().optional(),
  certificateId: z.string().nullable().optional(),
  cloudflare: z.object({ accountId: z.string(), zoneId: z.string(), proxied: z.boolean(), createRecord: z.boolean() }).nullable().optional(),
  /** Route through this Cloudflare Tunnel instead of the server's public IP. */
  tunnelId: z.string().nullable().optional(),
});

/** A certificate of this organization stored on `serverId`: the proxy there can only serve its own files. */
async function certificateOnServer(certificateId: string, orgId: string, serverId: string) {
  const [cert] = await db
    .select({ serverId: schema.certificate.serverId })
    .from(schema.certificate)
    .where(and(eq(schema.certificate.id, certificateId), eq(schema.certificate.organizationId, orgId)));
  if (!cert) throw new UserError("Certificate not found.");
  if (cert.serverId !== serverId) throw new UserError("That certificate is stored on another server. Upload it for this service's server to use it here.");
}

export async function addDomain(serviceId: string, input: z.input<typeof domainSchema>) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type === "database") throw new UserError("Databases are reached over TCP, not domains. Enable a public port instead.");
    const data = domainSchema.parse(input);
    data.redirectTo = safeRedirectUrl(data.redirectTo);
    if (service.type === "compose" && !data.composeService && !data.redirectTo) throw new UserError("Pick which compose service receives traffic.");
    const [taken] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, data.hostname));
    // A database on the domain would lose it: the proxy would claim the name and its certificate.
    const [databaseOnIt] = await db
      .select({ id: schema.service.id })
      .from(schema.service)
      .where(and(eq(schema.service.type, "database"), dsql`lower(${schema.service.database}->>'domain') = ${data.hostname}`));
    if (taken || databaseOnIt) throw new UserError("That domain is already connected to a service.");
    await assertNotDashboardHost(ctx, data.hostname);
    await assertNotStatusHost(data.hostname);
    // Other organizations than Root prove they control the domain first (DNS TXT record or their Cloudflare zone).
    const ownership = await domainOwnership({ id: ctx.org.id, isRoot: ctx.isRoot }, data.hostname);
    if (!ownership.verified) throw new UserError(ownershipMessage(data.hostname, ownership));
    await requireRoom(ctx.org.id, { domains: 1 });
    if (data.certificateId) await certificateOnServer(data.certificateId, ctx.org.id, service.serverId);

    let recordId: string | null = null;
    let warning: string | null = null;
    let tunnel: typeof schema.cloudflareTunnel.$inferSelect | null = null;
    let tunnelZoneId: string | null = null;
    if (data.tunnelId) {
      if (!ctx.isAdmin) throw new UserError("Only organization admins can route domains through a tunnel.");
      [tunnel] = await db
        .select()
        .from(schema.cloudflareTunnel)
        .where(and(eq(schema.cloudflareTunnel.id, data.tunnelId), eq(schema.cloudflareTunnel.organizationId, ctx.org.id)));
      if (!tunnel) throw new UserError("Tunnel not found.");
      if (tunnel.serverId !== service.serverId) throw new UserError("That tunnel belongs to another server than this service.");
      if (data.hostname.startsWith("*.")) throw new UserError("Wildcard domains cannot route through a tunnel. Add each hostname.");
      const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
      const zone = await cf.zoneFor(data.hostname).catch(() => null);
      if (!zone) throw new UserError(`${data.hostname} is not in a zone of the tunnel's Cloudflare account.`);
      try {
        recordId = (await cf.upsertTunnelRecord(zone.id, data.hostname, tunnel.cfTunnelId)).id;
        tunnelZoneId = zone.id;
      } catch (e) {
        throw new UserError(`Could not point ${data.hostname} at the tunnel: ${(e as Error).message}`);
      }
      // Cloudflare terminates HTTPS; the tunnel reaches the proxy over plain HTTP.
      data.https = false;
      data.forceHttps = false;
      data.cloudflare = null;
    }
    if (data.cloudflare) {
      const [account] = await db
        .select({ id: schema.cloudflareAccount.id })
        .from(schema.cloudflareAccount)
        .where(and(eq(schema.cloudflareAccount.id, data.cloudflare.accountId), eq(schema.cloudflareAccount.organizationId, ctx.org.id)));
      if (!account) throw new UserError("Cloudflare account not found.");
      if (data.cloudflare.createRecord) {
        if (!ctx.isAdmin) throw new UserError("Only organization admins can create DNS records.");
        const cfCheck = await Cloudflare.forAccount(account.id);
        const zone = await cfCheck.zone(data.cloudflare.zoneId).catch(() => null);
        if (!zone || (data.hostname !== zone.name && !data.hostname.endsWith(`.${zone.name}`))) {
          throw new UserError("That domain is not part of the selected Cloudflare zone.");
        }
        const ip = await serverPublicIp(service.serverId);
        if (!ip) throw new UserError("Set the public IP of this service's server before creating DNS records.");
        const cf = await Cloudflare.forAccount(account.id);
        try {
          const record = await cf.upsertARecord(data.cloudflare.zoneId, data.hostname, ip, data.cloudflare.proxied);
          recordId = record?.id ?? null;
          if (!record) warning = `${data.hostname} already has an A record pointing at this server. Serve left it as it is, including its Cloudflare proxy setting.`;
        } catch (e) {
          warning = `DNS record not created: ${(e as Error).message}`;
        }
      }
    }

    const [domain] = await db
      .insert(schema.domain)
      .values({
        id: newId(),
        serviceId,
        hostname: data.hostname,
        port: data.port ?? null,
        composeService: data.composeService ?? null,
        https: data.https,
        forceHttps: data.https && data.forceHttps,
        redirectTo: data.redirectTo ?? null,
        certificateId: data.certificateId ?? null,
        cloudflareAccountId: tunnel?.cloudflareAccountId ?? data.cloudflare?.accountId ?? null,
        cloudflareZoneId: tunnelZoneId ?? data.cloudflare?.zoneId ?? null,
        cloudflareRecordId: recordId,
        tunnelId: tunnel?.id ?? null,
        wantsTunnel: !!tunnel,
      })
      .returning();
    if (tunnel) {
      const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
      await syncTunnelIngress(tunnel.id).catch((e) => {
        warning = `Tunnel route not updated: ${(e as Error).message}`;
      });
    }
    if (domain.https && !data.certificateId) await ensureCertificateFor(domain, ctx.org.id);
    await syncServiceProxy(serviceId).catch((e) => {
      warning = `Proxy not updated: ${(e as Error).message}`;
    });
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "domain.added",
      targetType: "service",
      targetId: serviceId,
      message: `Added ${data.hostname} to ${service.name}`,
    });
    return { id: domain.id, warning };
  });
}

const domainUpdateSchema = z.object({
  port: z.number().int().min(1).max(65535).nullable().optional(),
  composeService: z.string().nullable().optional(),
  https: z.boolean().optional(),
  forceHttps: z.boolean().optional(),
  redirectTo: z.string().trim().nullable().optional(),
  certificateId: z.string().nullable().optional(),
  /** The A record in a Cloudflare zone of the organization (public IP route): kept and proxied or not, or removed. */
  dns: z.object({ accountId: z.string(), zoneId: z.string(), record: z.boolean(), proxied: z.boolean() }).optional(),
});

/**
 * Switch how a domain is reached: through a Cloudflare Tunnel of the service's server, or
 * the server's public IP (null). Serve rewrites the DNS record it manages accordingly.
 */
export async function setDomainRoute(domainId: string, tunnelId: string | null) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    if (!ctx.isAdmin) throw new UserError("Only organization admins can change how a domain is routed.");
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    const { service } = await serviceInOrg(domain.serviceId, ctx.org.id);
    if (domain.tunnelId === tunnelId && (tunnelId || !domain.wantsTunnel)) return null;
    const previousTunnel = domain.tunnelId;
    const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
    let warning: string | null = null;

    if (tunnelId) {
      const [tunnel] = await db
        .select()
        .from(schema.cloudflareTunnel)
        .where(and(eq(schema.cloudflareTunnel.id, tunnelId), eq(schema.cloudflareTunnel.organizationId, ctx.org.id)));
      if (!tunnel) throw new UserError("Tunnel not found.");
      if (tunnel.serverId !== service.serverId) throw new UserError("That tunnel belongs to another server than this service.");
      if (domain.hostname.startsWith("*.")) throw new UserError("Wildcard domains cannot route through a tunnel.");
      const cf = await Cloudflare.forAccount(tunnel.cloudflareAccountId);
      const zone = await cf.zoneFor(domain.hostname).catch(() => null);
      if (!zone) throw new UserError(`${domain.hostname} is not in a zone of the tunnel's Cloudflare account.`);
      let recordId: string;
      try {
        recordId = (await cf.upsertTunnelRecord(zone.id, domain.hostname, tunnel.cfTunnelId)).id;
      } catch (e) {
        throw new UserError(`Could not point ${domain.hostname} at the tunnel: ${(e as Error).message}`);
      }
      await db
        .update(schema.domain)
        .set({
          tunnelId,
          wantsTunnel: true,
          tunnelError: null,
          https: false,
          forceHttps: false,
          cloudflareAccountId: tunnel.cloudflareAccountId,
          cloudflareZoneId: zone.id,
          cloudflareRecordId: recordId,
        })
        .where(eq(schema.domain.id, domainId));
      // The DNS and the database already say "tunnel": finish the other syncs, then report.
      await syncTunnelIngress(tunnelId).catch((e) => {
        warning = `The tunnel's routes were not updated: ${(e as Error).message}. Use Sync routes on the tunnel, or edit the domain again.`;
      });
    } else {
      const ip = await serverPublicIp(service.serverId);
      if (!ip) throw new UserError("This server has no public IP set. Add it in the server's settings first.");
      let recordId = domain.cloudflareRecordId;
      if (domain.cloudflareAccountId && domain.cloudflareZoneId) {
        const cf = await Cloudflare.forAccount(domain.cloudflareAccountId);
        // Serve's own CNAME to the tunnel must go before an A record can exist for the name.
        const [oldTunnel] = previousTunnel ? await db.select().from(schema.cloudflareTunnel).where(eq(schema.cloudflareTunnel.id, previousTunnel)) : [];
        if (domain.cloudflareRecordId) await cf.deleteDnsRecord(domain.cloudflareZoneId, domain.cloudflareRecordId).catch(() => {});
        try {
          const record = await cf.upsertARecord(domain.cloudflareZoneId, domain.hostname, ip, true);
          recordId = record?.id ?? null;
          if (!record) warning = `${domain.hostname} already has an A record pointing at ${ip}. Serve left it as it is, including its Cloudflare proxy setting.`;
        } catch (e) {
          // Put the tunnel record back so DNS matches what the database still says.
          if (oldTunnel) await cf.upsertTunnelRecord(domain.cloudflareZoneId, domain.hostname, oldTunnel.cfTunnelId).catch(() => {});
          throw new UserError(`Could not point ${domain.hostname} at ${ip}: ${(e as Error).message}`);
        }
      }
      const [updated] = await db
        .update(schema.domain)
        .set({ tunnelId: null, wantsTunnel: false, tunnelError: null, https: true, forceHttps: true, cloudflareRecordId: recordId })
        .where(eq(schema.domain.id, domainId))
        .returning();
      await ensureCertificateFor(updated, ctx.org.id);
    }
    if (previousTunnel) await syncTunnelIngress(previousTunnel).catch(() => {});
    await syncServiceProxy(domain.serviceId);
    return { warning };
  });
}

/** Reconnect a domain that waits for a tunnel to a tunnel of its server, right now. */
export async function reconnectDomainTunnel(domainId: string) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    if (!ctx.isAdmin) throw new UserError("Only organization admins can change how a domain is routed.");
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    const { service } = await serviceInOrg(domain.serviceId, ctx.org.id);
    if (domain.tunnelId) return null;
    if (!domain.wantsTunnel) throw new UserError("This domain does not use a tunnel. Choose Cloudflare Tunnel in Edit.");
    // A manual retry clears the stored failure first.
    await db.update(schema.domain).set({ tunnelError: null }).where(eq(schema.domain.id, domainId));
    const { reattachOnServer } = await import("@/server/cloudflare/tunnels");
    const result = await reattachOnServer(service.serverId, { domainId });
    if (result.reconnected.includes(domain.hostname)) return null;
    const failed = result.failed.find((f) => f.hostname === domain.hostname);
    if (failed) throw new UserError(`Could not reconnect ${domain.hostname}: ${failed.error}`);
    if (!result.tunnels) throw new UserError("This server has no Cloudflare Tunnel. Create one in Integrations → Cloudflare; the domain reconnects by itself.");
    throw new UserError(`${domain.hostname} is not in a zone of any Cloudflare account with a tunnel on this server.`);
  });
}

/** Makes a domain the service's main one (SERVE_PUBLIC_URL). Applies on the next deploy. */
export async function setPrimaryDomain(domainId: string) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    await serviceInOrg(domain.serviceId, ctx.org.id);
    if (domain.redirectTo) throw new UserError("A redirect domain cannot be the primary domain.");
    await db.transaction(async (tx) => {
      await tx.update(schema.domain).set({ primary: false }).where(eq(schema.domain.serviceId, domain.serviceId));
      await tx.update(schema.domain).set({ primary: true }).where(eq(schema.domain.id, domainId));
    });
    return null;
  });
}

export async function updateDomain(domainId: string, input: z.input<typeof domainUpdateSchema>) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    const { service } = await serviceInOrg(domain.serviceId, ctx.org.id);
    const { dns, ...data } = domainUpdateSchema.parse(input);
    if (data.redirectTo !== undefined) data.redirectTo = safeRedirectUrl(data.redirectTo);
    if (domain.primary && data.redirectTo) throw new UserError("The primary domain cannot become a redirect. Make another domain primary first.");
    if (data.certificateId) await certificateOnServer(data.certificateId, ctx.org.id, service.serverId);
    // Tunnel domains get HTTPS from Cloudflare; a certificate at the proxy is never needed.
    if (domain.tunnelId) {
      data.https = false;
      data.forceHttps = false;
    }
    let warning: string | null = null;
    const record: Partial<typeof schema.domain.$inferInsert> = {};
    // The DNS record of a domain on the public IP route (a tunnel's CNAME is setDomainRoute's).
    if (dns && !domain.tunnelId) {
      if (!ctx.isAdmin) throw new UserError("Only organization admins can change DNS records.");
      const [account] = await db
        .select({ id: schema.cloudflareAccount.id })
        .from(schema.cloudflareAccount)
        .where(and(eq(schema.cloudflareAccount.id, dns.accountId), eq(schema.cloudflareAccount.organizationId, ctx.org.id)));
      if (!account) throw new UserError("Cloudflare account not found.");
      const cf = await Cloudflare.forAccount(account.id);
      const zone = await cf.zone(dns.zoneId).catch(() => null);
      if (!zone || (domain.hostname !== zone.name && !domain.hostname.endsWith(`.${zone.name}`))) throw new UserError("That domain is not part of the selected Cloudflare zone.");
      if (dns.record) {
        const ip = await serverPublicIp(service.serverId);
        if (!ip) throw new UserError("Set the public IP of this service's server before creating DNS records.");
        try {
          const made = await cf.upsertARecord(dns.zoneId, domain.hostname, ip, dns.proxied);
          Object.assign(record, { cloudflareAccountId: account.id, cloudflareZoneId: dns.zoneId, cloudflareRecordId: made?.id ?? null });
          if (!made) warning = `${domain.hostname} already has an A record pointing at ${ip}. Serve left it as it is, including its Cloudflare proxy setting.`;
        } catch (e) {
          warning = `DNS record not changed: ${(e as Error).message}`;
        }
      } else if (domain.cloudflareRecordId && domain.cloudflareZoneId && domain.cloudflareAccountId) {
        const own = await Cloudflare.forAccount(domain.cloudflareAccountId);
        await own
          .removeDnsRecord(domain.cloudflareZoneId, domain.cloudflareRecordId)
          .then(() => Object.assign(record, { cloudflareRecordId: null }))
          .catch((e: Error) => (warning = `DNS record not removed: ${e.message}`));
      }
    }
    const [updated] = await db
      .update(schema.domain)
      .set({ ...data, ...record })
      .where(eq(schema.domain.id, domainId))
      .returning();
    if (updated.https && !updated.certificateId) await ensureCertificateFor(updated, ctx.org.id);
    await syncServiceProxy(domain.serviceId);
    return warning ? { warning } : null;
  });
}

/** Whether the A record Serve made for a domain is proxied by Cloudflare (orange cloud); null without one. */
export async function domainRecordState(domainId: string) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    await serviceInOrg(domain.serviceId, ctx.org.id);
    if (!domain.cloudflareRecordId || !domain.cloudflareZoneId || !domain.cloudflareAccountId || domain.tunnelId) return null;
    const cf = await Cloudflare.forAccount(domain.cloudflareAccountId);
    const found = (await cf.dnsRecords(domain.cloudflareZoneId, { name: domain.hostname }).catch(() => [])).find((r) => r.id === domain.cloudflareRecordId);
    return found ? { proxied: found.proxied } : null;
  });
}

/**
 * Give a domain another name: the new one is added with the given settings (ownership, DNS record,
 * tunnel, certificate, exactly as when adding), then the old one is removed with the DNS record Serve
 * made for it. Primary stays primary. Nothing changes when the new name cannot be added.
 */
export async function replaceDomain(domainId: string, input: z.input<typeof domainSchema>) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const [old] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!old) throw new UserError("Domain not found.");
    await serviceInOrg(old.serviceId, ctx.org.id);
    // Checked before anything changes: the primary domain's place cannot go to a redirect.
    if (old.primary && input.redirectTo?.trim()) throw new UserError("The primary domain cannot become a redirect. Make another domain primary first.");
    const added = await addDomain(old.serviceId, input);
    if (!added.ok) throw new UserError(added.error);
    const warnings = [added.data.warning];
    if (old.primary) {
      const primary = await setPrimaryDomain(added.data.id);
      if (!primary.ok) warnings.push(`${input.hostname} is not the primary domain: ${primary.error}`);
    }
    const removed = await removeDomain(old.id, !!old.cloudflareRecordId);
    warnings.push(removed.ok ? (removed.data?.warning ?? null) : `${old.hostname} is still connected: ${removed.error}. Remove it from the list.`);
    const warning = warnings.filter(Boolean).join(" ");
    return { id: added.data.id, warning: warning || null };
  });
}

export async function removeDomain(domainId: string, deleteDns: boolean) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    const { service } = await serviceInOrg(domain.serviceId, ctx.org.id);
    const leftovers: string[] = [];
    const { leftover, recordLeftovers } = await import("@/server/services/leftovers");
    if (deleteDns && domain.cloudflareAccountId && domain.cloudflareZoneId && domain.cloudflareRecordId) {
      await Cloudflare.forAccount(domain.cloudflareAccountId)
        .then((cf) => cf.removeDnsRecord(domain.cloudflareZoneId!, domain.cloudflareRecordId!))
        .catch(leftover(leftovers, `DNS record of ${domain.hostname}`));
    }
    await db.delete(schema.domain).where(eq(schema.domain.id, domainId));
    if (domain.tunnelId) {
      const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
      await syncTunnelIngress(domain.tunnelId).catch(leftover(leftovers, "Cloudflare Tunnel routes"));
    }
    await syncServiceProxy(domain.serviceId).catch(leftover(leftovers, `Proxy site of ${service.name}`));
    // The certificate Serve got for this name alone goes too, once nothing else uses it.
    const { retireCertificateFor } = await import("@/server/ssl/certificates");
    await retireCertificateFor(domain.hostname, service.serverId, ctx.org.id).catch(leftover(leftovers, `Certificate for ${domain.hostname}`));
    const warning = await recordLeftovers(leftovers, { projectId: service.projectId, userId: ctx.user.id });
    return warning ? { warning } : null;
  });
}

export async function generateDomain(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const generated = await generatedHostname(service.slug, service.serverId);
    if (!generated) throw new UserError("Set a wildcard domain or the public IP of this service's server first.");
    const [taken] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, generated.hostname));
    if (taken) throw new UserError("The generated domain is already in use.");
    let composeService: string | null = null;
    if (service.type === "compose") composeService = composeServiceNames(service.compose?.content ?? "")[0] ?? null;
    await addGeneratedDomain(serviceId, service.slug, ctx.org.id, null, composeService, service.serverId);
    await syncServiceProxy(serviceId).catch(() => {});
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Backups                                   */
/* -------------------------------------------------------------------------- */

/** Starts a backup of a database service, or of one backup target of a compose stack. */
const backupChoiceSchema = z.object({
  s3DestinationId: z.string().max(64).nullable().optional(),
  copies: z.array(z.string().max(64)).max(20).optional(),
  local: z.boolean().optional(),
  users: z.boolean().optional(),
  encrypt: z.boolean().optional(),
});

export async function createBackup(serviceId: string, target?: string | null, opts: { databases?: string[] | null; choice?: z.input<typeof backupChoiceSchema> } = {}) {
  return act(async () => {
    const ctx = await requirePermission("databases.backups");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type === "compose" || service.type === "app") {
      if (!target || !service.composeBackups?.[target]) throw new UserError("Add this backup first.");
    } else if (service.type !== "database") throw new UserError("Backups are available for databases and compose stacks.");
    else target = null;
    if (service.status !== "running") throw new UserError(service.type === "database" ? "Start the database before backing it up." : "Start the service before backing it up.");
    await requireNotOver(ctx.org.id, "backupStorage");
    const id = newId();
    // Chosen databases (a database service): checked now, so a typo fails here and not in the job.
    let databases: string[] | null = null;
    if (!target && opts.databases?.length) {
      const list = z.array(z.string().min(1).max(128)).parse(opts.databases);
      const { listDatabases } = await import("@/server/databases/list");
      const found = await listDatabases(service).catch(() => null);
      const missing = found
        ? list.filter(
            (d) =>
              !found.includes(d) &&
              d !== service.database?.database &&
              d !== ALL_DATABASES &&
              !d.startsWith(SKIP_PREFIX) &&
              !(d === "postgres" && service.database?.engine === "postgres"),
          )
        : [];
      if (missing.length) throw new UserError(`There is no database named ${missing[0]}.`);
      databases = [...new Set(list)];
    }
    // Settings for this backup only (a database service): buckets of this organization; only admins leave out encryption.
    const choice = !target && opts.choice ? backupChoiceSchema.parse(opts.choice) : undefined;
    if (choice) {
      // Other settings than the saved ones: only roles that may change those settings.
      if (Object.keys(choice).length && !ctx.can("services.manage")) throw new UserError("Your role can back up with the saved settings only.");
      const buckets = [choice.s3DestinationId, ...(choice.copies ?? [])].filter((b): b is string => !!b);
      if (buckets.length) {
        const own = await db
          .select({ id: schema.s3Destination.id })
          .from(schema.s3Destination)
          .where(and(inArray(schema.s3Destination.id, buckets), eq(schema.s3Destination.organizationId, ctx.org.id)));
        if (own.length !== new Set(buckets).size) throw new UserError("Choose S3 storage of this organization.");
      }
      // Whatever the setting is now: a passphrase set before the job runs must still apply.
      if (choice.encrypt === false && !ctx.isAdmin) throw new UserError("Only organization admins can back up without encryption.");
      if (choice.copies && choice.s3DestinationId) choice.copies = choice.copies.filter((c) => c !== choice.s3DestinationId);
    }
    await db.insert(schema.backup).values({ id, serviceId, target: target ?? null, trigger: "manual", databases });
    await enqueue("backup.run", { backupId: id, ...(choice ? { choice } : {}) }, { concurrencyKey: `backup:${serviceId}` });
    return { id };
  });
}

/** The databases a backup of this service can take, and the ones its backups take now. */
export async function backupDatabaseChoices(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("databases.backups");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const cfg = service.database;
    if (!cfg) throw new UserError("Not a database.");
    const { engines } = await import("@/server/databases/engines");
    if (!engines[cfg.engine].backupDatabasesCommand || service.status !== "running") return { supported: false, databases: [], selected: null, main: cfg.database };
    const { backupableDatabases } = await import("@/server/backups");
    const databases = (await backupableDatabases(service)) ?? [cfg.database];
    return { supported: true, databases, selected: cfg.backupDatabases ?? null, main: cfg.database, engine: cfg.engine };
  });
}

/** What a restore can choose from: the backup's databases and tables, and where else it can go. */
export async function restoreChoices(backupId: string, passphrase?: string) {
  return act(async () => {
    const ctx = await requirePermission("databases.backups");
    const [b] = await db.select().from(schema.backup).where(eq(schema.backup.id, backupId));
    if (b?.status !== "success") throw new UserError("Backup not found.");
    const { service } = await serviceInOrg(b.serviceId, ctx.org.id);
    const { backupContents } = await import("@/server/backups");
    // A backup that cannot be listed (the database is stopped, say) can still be restored whole.
    let unreadable: string | null = null;
    const contents = await backupContents(backupId, passphrase || null).catch((e: Error) => {
      unreadable = e.message.split("\n").at(-1)?.slice(0, 300) ?? e.message;
      return { databases: [], tables: false };
    });
    // Other database services of the same engine, in projects the member can reach.
    const others = b.target
      ? []
      : (
          await db
            .select({
              id: schema.service.id,
              name: schema.service.name,
              status: schema.service.status,
              database: schema.service.database,
              project: schema.project.name,
              projectId: schema.project.id,
            })
            .from(schema.service)
            .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
            .where(and(eq(schema.project.organizationId, ctx.org.id), eq(schema.service.type, "database")))
        )
          .filter((r) => r.id !== service.id && r.database?.engine === service.database?.engine && ctx.canAccessProject(r.projectId))
          .map((r) => ({ id: r.id, name: r.name, project: r.project, running: r.status === "running", database: r.database?.database ?? "" }));
    const encrypted = !!b.filename?.endsWith(".enc");
    // The databases on the server now: a backup's database can be restored into one of them.
    const { backupableDatabases } = await import("@/server/backups");
    const existing = !b.target && service.status === "running" ? ((await backupableDatabases(service).catch(() => null)) ?? []).filter((d) => !SYSTEM_DATABASES.has(d)) : [];
    return {
      ...contents,
      encrypted,
      existing,
      unreadable: unreadable as string | null,
      main: service.database?.database ?? "",
      service: { id: service.id, name: service.name },
      others,
    };
  });
}

/** A database name a restore may create: letters, digits, _ $ and -, not the engines' own. */
const RESTORE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/;
const SYSTEM_DATABASES = new Set(["mysql", "sys", "information_schema", "performance_schema", "postgres", "template0", "template1", "admin", "local", "config"]);

export async function restoreFromBackup(
  backupId: string,
  opts: { backupFirst?: boolean; users?: boolean; into?: string; databases?: string[]; renames?: Record<string, string>; tables?: string[]; passphrase?: string } = {},
) {
  return act(async () => {
    const ctx = await requirePermission("databases.backups");
    // Restoring overwrites live data: admins only, like the button.
    if (!ctx.isAdmin) throw new UserError("Only organization admins can restore backups.");
    const [b] = await db.select().from(schema.backup).where(eq(schema.backup.id, backupId));
    if (b?.status !== "success") throw new UserError("Backup not found.");
    const { service: source } = await serviceInOrg(b.serviceId, ctx.org.id);
    // Into another database service of the same engine, which the member can reach too.
    const service = opts.into && opts.into !== source.id ? (await serviceInOrg(opts.into, ctx.org.id)).service : source;
    if (service.id !== source.id && (b.target || service.type !== "database" || service.database?.engine !== source.database?.engine))
      throw new UserError("Restore into a database of the same kind.");
    for (const name of Object.values(opts.renames ?? {}))
      if (!RESTORE_NAME.test(name) || SYSTEM_DATABASES.has(name)) throw new UserError(`"${name}" cannot be a database name. Use letters, digits, _ and -.`);
    // Two databases of the backup never go into one: their tables would mix.
    if (!b.target && !opts.tables?.length) {
      const { backupContents } = await import("@/server/backups");
      const sources = opts.databases?.length ? opts.databases : ((await backupContents(b.id, opts.passphrase || null).catch(() => null))?.databases.map((d) => d.name) ?? []);
      const main = service.database?.database ?? "";
      const seen = new Map<string, string>();
      for (const from of sources) {
        const to = opts.renames?.[from] || from || main;
        const other = seen.get(to);
        if (other !== undefined) throw new UserError(`${other || main} and ${from || main} would both go into ${to}. Choose another database for one of them.`);
        seen.set(to, from);
      }
    }
    if (opts.tables?.length) {
      if ((opts.databases?.length ?? 0) > 1) throw new UserError("Choose one database to restore single tables from.");
      // ClickHouse: its dump names the original database inside each CREATE statement and its views,
      // so it cannot go into a temporary database to copy tables from, and rows put back into a live
      // table would run its materialized views again (doubling their target's rows).
      if (service.database?.engine === "clickhouse")
        throw new UserError(
          "Single tables cannot be restored for ClickHouse: its backups name the original database in every table and view, and putting a table's rows back would run its materialized views a second time. Restore the whole backup into another ClickHouse service and copy the table from there.",
        );
      if (!["postgres", "mysql", "mariadb"].includes(service.database?.engine ?? "")) throw new UserError("Single tables can be restored for Postgres, MySQL and MariaDB.");
      if (opts.tables.some((t) => !t || t.length > 200)) throw new UserError("A table name is not valid.");
    }
    const choice = {
      ...(service.id !== source.id ? { into: service.id } : {}),
      ...(opts.databases?.length ? { databases: opts.databases } : {}),
      ...(opts.renames && Object.keys(opts.renames).length ? { renames: opts.renames } : {}),
      ...(opts.tables?.length ? { tables: opts.tables } : {}),
      ...(opts.passphrase ? { passphrase: encrypt(opts.passphrase) } : {}),
    };
    if (service.status !== "running") throw new UserError(service.type === "database" ? "Start the database before restoring." : "Start the service before restoring.");
    // A restore marks its backup running when queued. A second one would run after it and replace
    // what it restored (or restore the same backup twice): one at a time per service.
    const started = await db.transaction(async (tx) => {
      await tx.execute(dsql`select pg_advisory_xact_lock(hashtext(${`serve-restore:${service.id}`}))`);
      const [busy] = await tx
        .select({ id: schema.backup.id })
        .from(schema.backup)
        .where(and(eq(schema.backup.serviceId, b.serviceId), eq(schema.backup.restoreStatus, "running")))
        .limit(1);
      if (busy) return false;
      await tx.update(schema.backup).set({ restoreStatus: "running" }).where(eq(schema.backup.id, backupId));
      return true;
    });
    if (!started) throw new UserError(`A restore of ${service.name} is already queued or running. Wait for it to finish.`);
    // Every restore takes a safety backup first and puts it back if the restore fails; backupFirst keeps it afterwards.
    const users = !!opts.users;
    await enqueue("backup.import", { backupId, backupFirst: !!opts.backupFirst, users, ...choice }, { concurrencyKey: `backup:${service.id}` });
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "backup.restore",
      targetType: "service",
      targetId: service.id,
      message: `Restoring ${service.name} from a backup`,
    });
    return null;
  });
}

/** Backup proof by hand: restores the backup into a throwaway database and counts what came back. */
export async function testBackup(backupId: string) {
  return act(async () => {
    const ctx = await requirePermission("databases.backups");
    const [b] = await db.select().from(schema.backup).where(eq(schema.backup.id, backupId));
    if (b?.status !== "success" || b.target) throw new UserError("Only database backups can be tested.");
    const { service } = await serviceInOrg(b.serviceId, ctx.org.id);
    if (b.verifyStatus === "running") throw new UserError("This backup is being tested already.");
    await db.update(schema.backup).set({ verifyStatus: "running", verifyError: null }).where(eq(schema.backup.id, backupId));
    await enqueue("backup.verify", { backupId }, { concurrencyKey: `backup-verify:${service.id}` });
    return null;
  });
}

export async function deleteBackup(backupId: string) {
  return act(async () => {
    const ctx = await requirePermission("databases.backups");
    const [b] = await db.select().from(schema.backup).where(eq(schema.backup.id, backupId));
    if (!b) throw new UserError("Backup not found.");
    if (b.restoreStatus === "running") throw new UserError("This backup is being restored. Delete it once the restore ends.");
    const { service } = await serviceInOrg(b.serviceId, ctx.org.id);
    const { deleteBackupFiles } = await import("@/server/backups");
    await deleteBackupFiles(b, b.target ? service.composeBackups?.[b.target]?.s3DestinationId : service.database?.s3DestinationId);
    await db.delete(schema.backup).where(eq(schema.backup.id, backupId));
    return null;
  });
}

/** Apply database config changes (version, public port) by recreating the container. */
export async function applyDatabaseChanges(serviceId: string) {
  return act(async () => {
    const ctx = await requirePermission("services.deploy");
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type !== "database") throw new UserError("Not a database.");
    if (service.database?.publicPort) {
      const { heldDatabasePorts } = await import("@/server/databases/public-ports");
      if ((await heldDatabasePorts(service.serverId, { serviceId, holder: "database" })).has(service.database.publicPort)) {
        throw new UserError("Another database (or a pooler or replica) on this server already uses that public port.");
      }
    }
    const id = await queueDeployment(serviceId, "redeploy", { userId: ctx.user.id });
    return { id };
  });
}

/** Latest deployments for a list of services (used by live cards). */
export async function checkDomainDns(domainId: string) {
  return act(async () => {
    const ctx = await requirePermission("projects.view");
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    const { service } = await serviceInOrg(domain.serviceId, ctx.org.id);
    const { domainDnsStatus } = await import("@/server/dns");
    // The app's other servers serve the domain too: a record pointing at one is not just wrong.
    const otherIds = service.type === "app" ? runServerIds(service.serverId, service.distribution).filter((id) => id !== service.serverId) : [];
    const others = otherIds.length
      ? (
          await Promise.all(
            (
              await db.select({ id: schema.server.id, name: schema.server.name }).from(schema.server).where(inArray(schema.server.id, otherIds))
            ).map(async (s) => ({
              name: s.name,
              ip: await serverPublicIp(s.id).catch(() => null),
            })),
          )
        ).flatMap((o) => (o.ip ? [{ name: o.name, ip: o.ip }] : []))
      : [];
    const [main] = await db.select({ name: schema.server.name }).from(schema.server).where(eq(schema.server.id, service.serverId));
    const ip = await serverPublicIp(service.serverId);
    const status = await domainDnsStatus(domain.hostname, ip, { tunnel: !!domain.tunnelId, organizationId: ctx.org.id, others });
    return { ...status, expected: ip, main: main?.name ?? null };
  });
}

/**
 * Point a domain's DNS at the app's main server, when its record points at another server the app
 * runs on (made by hand, or left from before a switch). Only through the connected Cloudflare
 * account of its zone, and only records that point at one of the app's servers.
 */
export async function pointDomainAtMain(domainId: string) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    const { service } = await serviceInOrg(domain.serviceId, ctx.org.id);
    if (domain.tunnelId) throw new UserError("This domain goes through a Cloudflare Tunnel: it has no record to point at a server.");
    const { domainCloudflare } = await import("@/server/cloudflare/domain-link");
    const link = await domainCloudflare(domain, ctx.org.id);
    if (!link) throw new UserError(`None of your connected Cloudflare accounts holds the zone of ${domain.hostname}. Connect it in Cloudflare, or change the record yourself.`);
    const ip = await serverPublicIp(service.serverId);
    if (!ip) throw new UserError("The main server has no public IP to point the domain at.");
    const otherIds = service.type === "app" ? runServerIds(service.serverId, service.distribution).filter((id) => id !== service.serverId) : [];
    const others = (await Promise.all(otherIds.map((id) => serverPublicIp(id).catch(() => null)))).filter((x): x is string => !!x && x !== ip);
    const { Cloudflare } = await import("@/server/cloudflare/api");
    const cf = await Cloudflare.forAccount(link.accountId);
    let moved = false;
    for (const from of others) {
      const r = await cf.moveARecords(link.zoneId, domain.hostname, from, ip);
      if (r.result !== "untouched") moved = true;
    }
    if (!moved) throw new UserError(`${domain.hostname} does not point at another server of this app. Change its record in Cloudflare yourself.`);
    await logActivity({
      userId: ctx.user.id,
      projectId: service.projectId,
      action: "domain.dns",
      targetType: "service",
      targetId: service.id,
      message: `Pointed ${domain.hostname} at ${ip} in Cloudflare`,
    });
    return null;
  });
}

export async function retryCertificate(domainId: string) {
  return act(async () => {
    const ctx = await requirePermission("domains.manage");
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    await serviceInOrg(domain.serviceId, ctx.org.id);
    const settings = await getSettings();
    if (!settings.acmeEmail) throw new UserError("Set a Let's Encrypt email in Server settings first.");
    const cert = await ensureCertificateFor(domain, ctx.org.id, { requestNow: true });
    if (cert && cert.status !== "active") {
      await enqueue("certificate.issue", { certificateId: cert.id }, { concurrencyKey: `cert:${cert.id}` });
    }
    return null;
  });
}
