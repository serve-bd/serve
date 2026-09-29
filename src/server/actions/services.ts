"use server";

import { and, isNotNull, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireOrg, requireOrgAdmin } from "@/server/auth";
import { db, schema, sql } from "@/server/db";
import { encrypt, randomPassword } from "@/server/crypto";
import { newId } from "@/server/id";
import { CANCEL_CHANNEL, enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { projectInOrg, serviceInOrg } from "@/server/services/access";
import { generatedHostname, newWebhookSecret, queueDeployment, uniqueServiceSlug } from "@/server/services/create";
import { defaultBuild, defaultRuntime, type BuildConfig, type RuntimeConfig, type SourceConfig } from "@/server/services/types";
import { engines } from "@/server/databases/engines";
import { resolveTemplate, templateVarValue } from "@/server/services/custom-templates";
import { normalizeRepoUrl } from "@/server/deploy/git";
import { registerRepoWebhook, syncRepoWebhook } from "@/server/git/repo-webhooks";
import { composeServiceNames, parseCompose } from "@/server/deploy/compose";
import { removeServiceProxy, syncServiceProxy } from "@/server/proxy/nginx";
import { ensureCertificateFor } from "@/server/ssl/certificates";
import { Cloudflare } from "@/server/cloudflare/api";
import { getSettings } from "@/server/settings";
import { teardownServices } from "@/server/services/teardown";
import { composeSecurityIssues, safeRedirectUrl } from "@/server/security";
import type { OrgContext } from "@/server/auth";
import { requestServiceControl } from "@/server/services/control";
import { resolveServerForOrg, serverPublicIp } from "@/server/servers/access";
import { HOSTNAME_RE } from "@/lib/hostname";
import { CAPABILITIES } from "@/server/deploy/options";
import { volumeSchema } from "@/server/services/volume-schema";

async function assertEnvironment(projectId: string, environmentId: string) {
  const [env] = await db
    .select()
    .from(schema.environment)
    .where(and(eq(schema.environment.id, environmentId), eq(schema.environment.projectId, projectId)));
  if (!env) throw new UserError("Environment not found.");
  return env;
}

async function assertCredential(credentialId: string | null | undefined, orgId: string) {
  if (!credentialId) return;
  const [cred] = await db
    .select({ id: schema.gitCredential.id })
    .from(schema.gitCredential)
    .where(and(eq(schema.gitCredential.id, credentialId), eq(schema.gitCredential.organizationId, orgId)));
  if (!cred) throw new UserError("Git credential not found.");
}

/** Host-level options (bind mounts, host ports, privileged compose keys) are reserved for server admins. */
function assertHostAccess(ctx: OrgContext, what: string) {
  if (!ctx.isInstanceAdmin) throw new UserError(`${what} is only available to admins of the Root organization.`);
}

function assertSafeCompose(ctx: OrgContext, content: string) {
  const issues = composeSecurityIssues(content);
  if (issues.length && !ctx.isInstanceAdmin) {
    throw new UserError(`This compose file uses options that can access the host: ${issues.slice(0, 3).join("; ")}.`);
  }
}

async function addGeneratedDomain(serviceId: string, slug: string, organizationId: string, port?: number | null, composeService?: string | null, serverId?: string) {
  const generated = await generatedHostname(slug, serverId);
  if (!generated) return;
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

const envVarInput = z.array(z.object({ key: z.string(), value: z.string() })).optional();

const appSchema = z.object({
  projectId: z.string(),
  environmentId: z.string(),
  name: z.string().trim().min(1, "Enter a name").max(60),
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("git"),
      repository: z.string().trim().min(3, "Enter a repository URL"),
      branch: z.string().trim().min(1).default("main"),
      credentialId: z.string().nullable().optional(),
    }),
    z.object({
      type: z.literal("image"),
      image: z.string().trim().min(1, "Enter an image"),
      registryUsername: z.string().trim().optional().nullable(),
      registryPassword: z.string().optional().nullable(),
    }),
  ]),
  build: z
    .object({
      builder: z.enum(["auto", "dockerfile", "nixpacks", "static"]).default("auto"),
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
  /** Services are never deployed on creation unless the caller asks (e.g. the API). */
  deploy: z.boolean().default(false),
  /** Server to run on; defaults to the server Serve runs on. */
  serverId: z.string().nullable().optional(),
});

export async function createAppService(input: z.input<typeof appSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const data = appSchema.parse(input);
    await projectInOrg(data.projectId, ctx.org.id);
    await assertEnvironment(data.projectId, data.environmentId);

    if (data.source.type === "git") await assertCredential(data.source.credentialId, ctx.org.id);
    const server = await resolveServerForOrg(data.serverId, ctx.org.id);

    const source: SourceConfig =
      data.source.type === "git"
        ? { type: "git", repository: normalizeRepoUrl(data.source.repository), branch: data.source.branch, credentialId: data.source.credentialId ?? null }
        : {
            type: "image",
            image: data.source.image,
            registryUsername: data.source.registryUsername || null,
            registryPassword: data.source.registryPassword ? encrypt(data.source.registryPassword) : null,
          };

    const id = newId();
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
      build: data.source.type === "git" ? { ...defaultBuild(), ...(data.build as Partial<BuildConfig>) } : null,
      runtime: defaultRuntime(data.port ?? null),
      webhookSecret: newWebhookSecret(),
    });
    await writeEnvVars(
      id,
      (data.envVars ?? []).filter((v) => v.key.trim()).map((v) => ({ ...v, buildTime: false, runtime: true })),
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
  name: z.string().trim().min(1).max(60),
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
  password: z.string().min(8).optional(),
  serverId: z.string().nullable().optional(),
});

export async function createDatabaseService(input: z.input<typeof dbSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const data = dbSchema.parse(input);
    await projectInOrg(data.projectId, ctx.org.id);
    await assertEnvironment(data.projectId, data.environmentId);
    const server = await resolveServerForOrg(data.serverId, ctx.org.id);
    const engine = engines[data.engine];
    const version = data.version && engine.versions.includes(data.version) ? data.version : engine.defaultVersion;
    const id = newId();
    await db.insert(schema.service).values({
      id,
      projectId: data.projectId,
      environmentId: data.environmentId,
      serverId: server.id,
      name: data.name,
      slug: await uniqueServiceSlug(data.name),
      type: "database",
      runtime: { ...defaultRuntime(engine.port), restartPolicy: "unless-stopped" },
      database: {
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
      message: `Created ${engine.label} database ${data.name}`,
    });
    return { id };
  });
}

const composeSchema = z.object({
  deploy: z.boolean().default(false),
  projectId: z.string(),
  environmentId: z.string(),
  name: z.string().trim().min(1).max(60),
  mode: z.enum(["inline", "git"]),
  content: z.string().optional(),
  path: z.string().optional(),
  source: z.object({ repository: z.string().trim().min(3), branch: z.string().trim().default("main"), credentialId: z.string().nullable().optional() }).optional(),
  template: z.string().optional(),
  /** Values chosen on the configure step; anything missing is generated from the template. */
  vars: z.record(z.string(), z.string().max(4000)).optional(),
  serverId: z.string().nullable().optional(),
});

export async function createComposeService(input: z.input<typeof composeSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
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
      if (!template || template.custom || template.hostAccess) assertSafeCompose(ctx, content);
    } else if (!data.source) throw new UserError("Enter a repository.");
    await assertCredential(data.source?.credentialId, ctx.org.id);
    const server = await resolveServerForOrg(data.serverId, ctx.org.id);
    if (!server.isLocal && server.info && (server.info as { compose?: string | null }).compose === null) {
      throw new UserError(`${server.name} has no Docker Compose. Install the compose plugin there first.`);
    }
    if (data.mode === "git") content = "";

    const id = newId();
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
      runtime: defaultRuntime(null),
      compose: { mode: data.mode, content, path: data.path || "docker-compose.yml", template: template?.id ?? null },
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
            port: template.expose.port,
            composeService: template.expose.service,
          })
          .returning();
        if (domain.https) await ensureCertificateFor(domain, ctx.org.id);
      }
      const vars = template.vars.map((v) => ({
        key: v.key,
        value: data.vars?.[v.key] ?? templateVarValue(v, !!generated),
        buildTime: false,
        runtime: true,
      }));
      await writeEnvVars(id, vars);
    }
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
  name: z.string().trim().min(1).max(60).optional(),
  /** Extra private hostname; "" or null removes it. */
  hostname: z.string().trim().toLowerCase().max(63).nullable().optional(),
  autoDeploy: z.boolean().optional(),
  previewsEnabled: z.boolean().optional(),
  source: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("git"), repository: z.string().trim().min(3), branch: z.string().trim().min(1), credentialId: z.string().nullable().optional() }),
      z.object({
        type: z.literal("image"),
        image: z.string().trim().min(1),
        registryUsername: z.string().nullable().optional(),
        registryPassword: z.string().nullable().optional(),
      }),
    ])
    .optional(),
  build: z
    .object({
      builder: z.enum(["auto", "dockerfile", "nixpacks", "static"]),
      rootDir: z.string(),
      dockerfile: z.string(),
      installCommand: z.string().nullable(),
      buildCommand: z.string().nullable(),
      startCommand: z.string().nullable(),
      publishDir: z.string().nullable(),
      target: z.string().nullable(),
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
      replicas: z.number().int().min(1).max(20),
      command: z.string().nullable(),
      healthcheckPath: z.string().nullable(),
      healthcheckTimeout: z.number().int().min(10).max(1800).nullable(),
      restartPolicy: z.enum(["always", "unless-stopped", "on-failure", "no"]),
      cpuLimit: z.number().min(0.05).max(256).nullable(),
      memoryLimit: z
        .number()
        .int()
        .min(16)
        .max(1024 * 1024)
        .nullable(),
      volumes: z.array(volumeSchema).max(50),
      ports: z.array(
        z.object({
          host: z.number().int().min(1).max(65535),
          container: z.number().int().min(1).max(65535),
          protocol: z.enum(["tcp", "udp"]),
          bindAddress: z.enum(["0.0.0.0", "127.0.0.1"]).optional(),
        }),
      ),
      preDeployCommand: z.string().max(4000).nullable(),
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
      privileged: z.boolean(),
      capAdd: z.array(z.enum(CAPABILITIES)).max(20),
    })
    .partial()
    .optional(),
  database: z
    .object({
      version: z.string(),
      publicPort: z.number().int().min(1024).max(65535).nullable(),
      publicBind: z.enum(["0.0.0.0", "127.0.0.1"]).optional(),
      backupSchedule: z.string().nullable(),
      backupRetention: z.number().int().min(1).max(365),
      backupRetentionS3: z.number().int().min(1).max(3650).nullable(),
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
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const data = updateSchema.parse(input);
    const patch: Partial<typeof schema.service.$inferInsert> = {};
    if (data.name) patch.name = data.name;
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
      }
      patch.hostname = hostname;
    }
    if (data.autoDeploy !== undefined) patch.autoDeploy = data.autoDeploy;
    if (data.previewsEnabled !== undefined) patch.previewsEnabled = data.previewsEnabled;
    if (data.source) {
      if (data.source.type === "git") {
        await assertCredential(data.source.credentialId, ctx.org.id);
        patch.source = { type: "git", repository: normalizeRepoUrl(data.source.repository), branch: data.source.branch, credentialId: data.source.credentialId ?? null };
      } else {
        const prev = service.source?.type === "image" ? service.source : null;
        patch.source = {
          type: "image",
          image: data.source.image,
          registryUsername: data.source.registryUsername || null,
          registryPassword:
            data.source.registryPassword === undefined ? (prev?.registryPassword ?? null) : data.source.registryPassword ? encrypt(data.source.registryPassword) : null,
        };
      }
    }
    if (data.build) patch.build = { ...defaultBuild(), ...service.build, ...data.build } as BuildConfig;
    if (data.runtime) {
      const runtime = { ...service.runtime, ...data.runtime } as RuntimeConfig;
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
      if (data.runtime.labels?.some((l) => l.key.startsWith("serve."))) throw new UserError("Labels starting with serve. are reserved.");
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
      if (data.database.s3DestinationId) {
        const [dest] = await db
          .select({ id: schema.s3Destination.id })
          .from(schema.s3Destination)
          .where(and(eq(schema.s3Destination.id, data.database.s3DestinationId), eq(schema.s3Destination.organizationId, ctx.org.id)));
        if (!dest) throw new UserError("Backup storage not found.");
      }
      patch.database = { ...service.database, ...data.database };
    }
    if (data.compose && service.compose) {
      if (data.compose.content !== undefined && service.compose.mode === "inline") {
        try {
          parseCompose(data.compose.content);
        } catch (e) {
          throw new UserError(`The compose file is not valid: ${(e as Error).message}`);
        }
        assertSafeCompose(ctx, data.compose.content);
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
    await db.update(schema.service).set(patch).where(eq(schema.service.id, serviceId));
    if (data.source) await syncRepoWebhook(service.source, serviceId);
    if (data.runtime?.port !== undefined) await syncServiceProxy(serviceId).catch(() => {});
    return null;
  });
}

export async function regenerateWebhookSecret(serviceId: string) {
  return act(async () => {
    const ctx = await requireOrg();
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

export async function deployService(serviceId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type === "app" && !service.source) throw new UserError("Connect a source before deploying.");
    const id = await queueDeployment(serviceId, "manual", { userId: ctx.user.id });
    return { id };
  });
}

/** Deploy once without the build cache (fresh base images and layers). */
export async function deployWithoutCache(serviceId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type !== "app" || service.source?.type !== "git" || !service.build) throw new UserError("Only services built from a repository have a build cache.");
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
    const ctx = await requireOrg();
    const [dep] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
    if (!dep) throw new UserError("Deployment not found.");
    await serviceInOrg(dep.serviceId, ctx.org.id);
    const id = await queueDeployment(dep.serviceId, "redeploy", { userId: ctx.user.id });
    return { id };
  });
}

export async function rollbackTo(deploymentId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const [dep] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
    if (!dep) throw new UserError("Deployment not found.");
    const { service } = await serviceInOrg(dep.serviceId, ctx.org.id);
    if (service.type !== "app") throw new UserError("Rollbacks are available for apps.");
    if (dep.status !== "success" || !dep.image) throw new UserError("Only successful deployments can be restored.");
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
    const ctx = await requireOrg();
    const [dep] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, deploymentId));
    if (!dep) throw new UserError("Deployment not found.");
    await serviceInOrg(dep.serviceId, ctx.org.id);
    if (dep.status === "queued") {
      await db.update(schema.deployment).set({ status: "cancelled", finishedAt: new Date(), logs: "Cancelled before it started.\n" }).where(eq(schema.deployment.id, deploymentId));
    } else if (dep.status === "building" || dep.status === "deploying") {
      await sql.notify(CANCEL_CHANNEL, deploymentId);
    } else {
      throw new UserError("This deployment has already finished.");
    }
    return null;
  });
}

export async function serviceControl(serviceId: string, command: "stop" | "start" | "restart") {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    await requestServiceControl(service, command, ctx.user.id);
    return null;
  });
}

/**
 * Move a service to another server: its containers on the old server are
 * removed (data volumes stay there) and it is deployed fresh on the new one.
 */
export async function moveService(serviceId: string, serverId: string, opts: { force?: boolean } = {}) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.parentServiceId) throw new UserError("Preview deployments follow their parent service.");
    if (service.serverId === serverId) throw new UserError("The service already runs on that server.");
    const target = await resolveServerForOrg(serverId, ctx.org.id);
    const [source] = await db.select({ name: schema.server.name }).from(schema.server).where(eq(schema.server.id, service.serverId));
    if (service.type === "database" && !opts.force) {
      throw new UserError(
        `Moving a database starts it empty on ${target.name}. Its data stays in a volume on ${source?.name ?? "the old server"}. Back it up and restore it after the move.`,
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
      { serviceId, slug: service.slug, type: service.type, removeVolumes: false, environmentId: service.environmentId, serverId: service.serverId, keepFiles: true },
      { concurrencyKey: `service:${serviceId}` },
    );
    // Stop routing on the old server right away; the delete job also cleans it up.
    await removeServiceProxy(serviceId, service.serverId).catch(() => {});
    await db.update(schema.service).set({ serverId: target.id, status: "deploying" }).where(eq(schema.service.id, serviceId));

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

export async function deleteService(serviceId: string, removeVolumes: boolean) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const domains = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, serviceId));
    // Remove DNS records Serve created.
    for (const d of domains) {
      if (d.cloudflareAccountId && d.cloudflareZoneId && d.cloudflareRecordId) {
        await Cloudflare.forAccount(d.cloudflareAccountId)
          .then((cf) => cf.deleteDnsRecord(d.cloudflareZoneId!, d.cloudflareRecordId!))
          .catch(() => {});
      }
    }
    await teardownServices([service], removeVolumes);
    await logActivity({ userId: ctx.user.id, projectId: service.projectId, action: "service.deleted", message: `Deleted ${service.name}` });
    return null;
  });
}

/* -------------------------------------------------------------------------- */
/*                                 Variables                                  */
/* -------------------------------------------------------------------------- */

type VarInput = { key: string; value: string; buildTime: boolean; runtime: boolean };

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
      await tx.insert(schema.envVar).values(vars.map((v) => ({ id: newId(), serviceId, key: v.key, value: encrypt(v.value), buildTime: v.buildTime, runtime: v.runtime })));
    }
  });
}

export async function saveEnvVars(serviceId: string, vars: VarInput[], redeploy: boolean) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    await writeEnvVars(
      serviceId,
      vars.map((v) => ({ ...v, key: v.key.trim() })).filter((v) => v.key),
    );
    let deploymentId: string | null = null;
    if (redeploy && service.status !== "idle") deploymentId = await queueDeployment(serviceId, "redeploy", { userId: ctx.user.id });
    return { deploymentId };
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
  .pipe(z.string().regex(/^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/, "Enter a valid domain like app.example.com"));

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

export async function addDomain(serviceId: string, input: z.input<typeof domainSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type === "database") throw new UserError("Databases are reached over TCP, not domains. Enable a public port instead.");
    const data = domainSchema.parse(input);
    data.redirectTo = safeRedirectUrl(data.redirectTo);
    if (service.type === "compose" && !data.composeService && !data.redirectTo) throw new UserError("Pick which compose service receives traffic.");
    const [taken] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, data.hostname));
    if (taken) throw new UserError("That domain is already connected to a service.");
    if (data.certificateId) {
      const [cert] = await db
        .select({ id: schema.certificate.id })
        .from(schema.certificate)
        .where(and(eq(schema.certificate.id, data.certificateId), eq(schema.certificate.organizationId, ctx.org.id)));
      if (!cert) throw new UserError("Certificate not found.");
    }

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
          recordId = record.id;
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
});

/**
 * Switch how a domain is reached: through a Cloudflare Tunnel of the service's server, or
 * the server's public IP (null). Serve rewrites the DNS record it manages accordingly.
 */
export async function setDomainRoute(domainId: string, tunnelId: string | null) {
  return act(async () => {
    const ctx = await requireOrg();
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
          recordId = (await cf.upsertARecord(domain.cloudflareZoneId, domain.hostname, ip, true)).id;
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
    const ctx = await requireOrg();
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
    const ctx = await requireOrg();
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
    const ctx = await requireOrg();
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    await serviceInOrg(domain.serviceId, ctx.org.id);
    const data = domainUpdateSchema.parse(input);
    if (data.redirectTo !== undefined) data.redirectTo = safeRedirectUrl(data.redirectTo);
    if (data.certificateId) {
      const [cert] = await db
        .select({ id: schema.certificate.id })
        .from(schema.certificate)
        .where(and(eq(schema.certificate.id, data.certificateId), eq(schema.certificate.organizationId, ctx.org.id)));
      if (!cert) throw new UserError("Certificate not found.");
    }
    // Tunnel domains get HTTPS from Cloudflare; a certificate at the proxy is never needed.
    if (domain.tunnelId) {
      data.https = false;
      data.forceHttps = false;
    }
    const [updated] = await db.update(schema.domain).set(data).where(eq(schema.domain.id, domainId)).returning();
    if (updated.https && !updated.certificateId) await ensureCertificateFor(updated, ctx.org.id);
    await syncServiceProxy(domain.serviceId);
    return null;
  });
}

export async function removeDomain(domainId: string, deleteDns: boolean) {
  return act(async () => {
    const ctx = await requireOrg();
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    await serviceInOrg(domain.serviceId, ctx.org.id);
    if (deleteDns && domain.cloudflareAccountId && domain.cloudflareZoneId && domain.cloudflareRecordId) {
      const cf = await Cloudflare.forAccount(domain.cloudflareAccountId);
      await cf.deleteDnsRecord(domain.cloudflareZoneId, domain.cloudflareRecordId).catch(() => {});
    }
    await db.delete(schema.domain).where(eq(schema.domain.id, domainId));
    if (domain.tunnelId) {
      const { syncTunnelIngress } = await import("@/server/cloudflare/tunnels");
      await syncTunnelIngress(domain.tunnelId).catch(() => {});
    }
    await syncServiceProxy(domain.serviceId).catch(() => {});
    return null;
  });
}

export async function generateDomain(serviceId: string) {
  return act(async () => {
    const ctx = await requireOrg();
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

export async function createBackup(serviceId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type !== "database") throw new UserError("Backups are available for databases.");
    if (service.status !== "running") throw new UserError("Start the database before backing it up.");
    const id = newId();
    await db.insert(schema.backup).values({ id, serviceId, trigger: "manual" });
    await enqueue("backup.run", { backupId: id }, { concurrencyKey: `backup:${serviceId}` });
    return { id };
  });
}

export async function restoreFromBackup(backupId: string, opts: { backupFirst?: boolean } = {}) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const [b] = await db.select().from(schema.backup).where(eq(schema.backup.id, backupId));
    if (b?.status !== "success") throw new UserError("Backup not found.");
    const { service } = await serviceInOrg(b.serviceId, ctx.org.id);
    if (service.status !== "running") throw new UserError("Start the database before restoring.");
    await db.update(schema.backup).set({ restoreStatus: "running" }).where(eq(schema.backup.id, backupId));
    // With a safety backup, the import job takes the backup and restores only if it succeeded.
    if (opts.backupFirst) await enqueue("backup.import", { backupId, backupFirst: true }, { concurrencyKey: `backup:${b.serviceId}` });
    else await enqueue("backup.restore", { backupId }, { concurrencyKey: `backup:${b.serviceId}` });
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

export async function deleteBackup(backupId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const [b] = await db.select().from(schema.backup).where(eq(schema.backup.id, backupId));
    if (!b) throw new UserError("Backup not found.");
    const { service } = await serviceInOrg(b.serviceId, ctx.org.id);
    const { deleteBackupFiles } = await import("@/server/backups");
    await deleteBackupFiles(b, service.database?.s3DestinationId);
    await db.delete(schema.backup).where(eq(schema.backup.id, backupId));
    return null;
  });
}

/** Apply database config changes (version, public port) by recreating the container. */
export async function applyDatabaseChanges(serviceId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type !== "database") throw new UserError("Not a database.");
    if (service.database?.publicPort) {
      const clash = await db
        .select({ id: schema.service.id, database: schema.service.database })
        .from(schema.service)
        .where(and(eq(schema.service.type, "database"), ne(schema.service.id, serviceId), eq(schema.service.serverId, service.serverId)));
      if (clash.some((c) => c.database?.publicPort === service.database?.publicPort)) {
        throw new UserError("Another database on this server already uses that public port.");
      }
    }
    const id = await queueDeployment(serviceId, "redeploy", { userId: ctx.user.id });
    return { id };
  });
}

/** Latest deployments for a list of services (used by live cards). */
export async function latestDeployments(serviceIds: string[]) {
  const ctx = await requireOrg();
  if (!serviceIds.length) return [];
  const rows = await db
    .select({ d: schema.deployment })
    .from(schema.deployment)
    .innerJoin(schema.service, eq(schema.deployment.serviceId, schema.service.id))
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(inArray(schema.deployment.serviceId, serviceIds), eq(schema.project.organizationId, ctx.org.id)))
    .orderBy(desc(schema.deployment.createdAt))
    .limit(serviceIds.length * 3);
  return rows.map((r) => r.d);
}

export async function checkDomainDns(domainId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    const { service } = await serviceInOrg(domain.serviceId, ctx.org.id);
    const { domainDnsStatus } = await import("@/server/dns");
    return domainDnsStatus(domain.hostname, await serverPublicIp(service.serverId), { tunnel: !!domain.tunnelId });
  });
}

export async function retryCertificate(domainId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    await serviceInOrg(domain.serviceId, ctx.org.id);
    const settings = await getSettings();
    if (!settings.acmeEmail) throw new UserError("Set a Let's Encrypt email in Server settings first.");
    const cert = await ensureCertificateFor(domain, ctx.org.id);
    if (cert && cert.status !== "active") {
      await enqueue("certificate.issue", { certificateId: cert.id }, { concurrencyKey: `cert:${cert.id}` });
    }
    return null;
  });
}
