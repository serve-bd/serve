"use server";

import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireOrg, requireOrgAdmin } from "@/server/auth";
import { db, schema, sql } from "@/server/db";
import { encrypt, randomPassword, randomSecret } from "@/server/crypto";
import { newId } from "@/server/id";
import { CANCEL_CHANNEL, enqueue } from "@/server/queue";
import { logActivity } from "@/server/activity";
import { projectInOrg, serviceInOrg } from "@/server/services/access";
import { generatedHostname, newWebhookSecret, queueDeployment, uniqueServiceSlug } from "@/server/services/create";
import { defaultBuild, defaultRuntime, type BuildConfig, type RuntimeConfig, type SourceConfig } from "@/server/services/types";
import { engines } from "@/server/databases/engines";
import { getTemplate } from "@/server/services/templates";
import { normalizeRepoUrl } from "@/server/deploy/git";
import { composeServiceNames, parseCompose } from "@/server/deploy/compose";
import { syncServiceProxy } from "@/server/proxy/nginx";
import { ensureCertificateFor } from "@/server/ssl/certificates";
import { Cloudflare } from "@/server/cloudflare/api";
import { getSettings } from "@/server/settings";

async function assertEnvironment(projectId: string, environmentId: string) {
  const [env] = await db
    .select()
    .from(schema.environment)
    .where(and(eq(schema.environment.id, environmentId), eq(schema.environment.projectId, projectId)));
  if (!env) throw new UserError("Environment not found.");
  return env;
}

async function addGeneratedDomain(serviceId: string, slug: string, organizationId: string, port?: number | null, composeService?: string | null) {
  const generated = await generatedHostname(slug);
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
  deploy: z.boolean().default(true),
});

export async function createAppService(input: z.input<typeof appSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const data = appSchema.parse(input);
    await projectInOrg(data.projectId, ctx.org.id);
    await assertEnvironment(data.projectId, data.environmentId);

    if (data.source.type === "git" && data.source.credentialId) {
      const [cred] = await db
        .select({ id: schema.gitCredential.id })
        .from(schema.gitCredential)
        .where(and(eq(schema.gitCredential.id, data.source.credentialId), eq(schema.gitCredential.organizationId, ctx.org.id)));
      if (!cred) throw new UserError("Git credential not found.");
    }

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
      name: data.name,
      slug,
      type: "app",
      source,
      build: data.source.type === "git" ? { ...defaultBuild(), ...(data.build as Partial<BuildConfig>) } : null,
      runtime: defaultRuntime(data.port ?? null),
      webhookSecret: newWebhookSecret(),
    });
    await writeEnvVars(id, (data.envVars ?? []).filter((v) => v.key.trim()).map((v) => ({ ...v, buildTime: false, runtime: true })));
    await addGeneratedDomain(id, slug, ctx.org.id);
    if (data.deploy) await queueDeployment(id, "create", { userId: ctx.user.id });
    await logActivity({ userId: ctx.user.id, projectId: data.projectId, action: "service.created", targetType: "service", targetId: id, message: `Created ${data.name}` });
    return { id };
  });
}

const dbSchema = z.object({
  projectId: z.string(),
  environmentId: z.string(),
  name: z.string().trim().min(1).max(60),
  engine: z.enum(["postgres", "mysql", "mariadb", "mongodb", "redis", "valkey", "clickhouse"]),
  version: z.string().optional(),
  username: z.string().trim().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Use letters, numbers and underscores").optional(),
  database: z.string().trim().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Use letters, numbers and underscores").optional(),
  password: z.string().min(8).optional(),
});

export async function createDatabaseService(input: z.input<typeof dbSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const data = dbSchema.parse(input);
    await projectInOrg(data.projectId, ctx.org.id);
    await assertEnvironment(data.projectId, data.environmentId);
    const engine = engines[data.engine];
    const version = data.version && engine.versions.includes(data.version) ? data.version : engine.defaultVersion;
    const id = newId();
    await db.insert(schema.service).values({
      id,
      projectId: data.projectId,
      environmentId: data.environmentId,
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
    await queueDeployment(id, "create", { userId: ctx.user.id });
    await logActivity({ userId: ctx.user.id, projectId: data.projectId, action: "service.created", targetType: "service", targetId: id, message: `Created ${engine.label} database ${data.name}` });
    return { id };
  });
}

const composeSchema = z.object({
  projectId: z.string(),
  environmentId: z.string(),
  name: z.string().trim().min(1).max(60),
  mode: z.enum(["inline", "git"]),
  content: z.string().optional(),
  path: z.string().optional(),
  source: z
    .object({ repository: z.string().trim().min(3), branch: z.string().trim().default("main"), credentialId: z.string().nullable().optional() })
    .optional(),
  template: z.string().optional(),
});

export async function createComposeService(input: z.input<typeof composeSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const data = composeSchema.parse(input);
    await projectInOrg(data.projectId, ctx.org.id);
    await assertEnvironment(data.projectId, data.environmentId);

    const template = data.template ? getTemplate(data.template) : null;
    let content = template?.compose ?? data.content ?? "";
    if (data.mode === "inline") {
      try {
        parseCompose(content);
      } catch (e) {
        throw new UserError(`The compose file is not valid: ${(e as Error).message}`);
      }
    } else if (!data.source) throw new UserError("Enter a repository.");
    if (data.mode === "git") content = "";

    const id = newId();
    const slug = await uniqueServiceSlug(data.name);
    await db.insert(schema.service).values({
      id,
      projectId: data.projectId,
      environmentId: data.environmentId,
      name: data.name,
      slug,
      type: "compose",
      icon: template?.id ?? null,
      source:
        data.mode === "git" && data.source
          ? { type: "git", repository: normalizeRepoUrl(data.source.repository), branch: data.source.branch, credentialId: data.source.credentialId ?? null }
          : null,
      runtime: defaultRuntime(null),
      compose: { mode: data.mode, content, path: data.path || "docker-compose.yml", template: template?.id ?? null },
      webhookSecret: newWebhookSecret(),
    });

    if (template) {
      const generated = await generatedHostname(slug);
      if (generated) {
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
      const publicUrl = generated ? `${generated.https ? "https" : "http"}://${generated.hostname}` : "http://localhost";
      const vars = template.vars.map((v) => ({
        key: v.key,
        value: v.publicUrl
          ? publicUrl
          : v.generate === "password"
            ? randomPassword(24)
            : v.generate === "secret"
              ? randomSecret(32)
              : v.generate === "hex32"
                ? randomSecret(48).replace(/[^a-zA-Z0-9]/g, "").slice(0, 64)
                : (v.value ?? ""),
        buildTime: false,
        runtime: true,
      }));
      await writeEnvVars(id, vars);
    }
    await queueDeployment(id, "create", { userId: ctx.user.id });
    await logActivity({ userId: ctx.user.id, projectId: data.projectId, action: "service.created", targetType: "service", targetId: id, message: `Created ${template ? template.name : "compose stack"} ${data.name}` });
    return { id };
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Settings                                  */
/* -------------------------------------------------------------------------- */

const updateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  autoDeploy: z.boolean().optional(),
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
      memoryLimit: z.number().int().min(16).max(1024 * 1024).nullable(),
      volumes: z.array(
        z.object({
          source: z.string().trim().min(1),
          mountPath: z.string().trim().regex(/^\//, "Mount paths must be absolute"),
          kind: z.enum(["volume", "bind"]),
        }),
      ),
      ports: z.array(z.object({ host: z.number().int().min(1).max(65535), container: z.number().int().min(1).max(65535), protocol: z.enum(["tcp", "udp"]) })),
    })
    .partial()
    .optional(),
  database: z
    .object({
      version: z.string(),
      publicPort: z.number().int().min(1024).max(65535).nullable(),
      backupSchedule: z.string().nullable(),
      backupRetention: z.number().int().min(1).max(365),
      s3DestinationId: z.string().nullable(),
    })
    .partial()
    .optional(),
  compose: z.object({ content: z.string().optional(), path: z.string().optional() }).optional(),
});

export async function updateService(serviceId: string, input: z.input<typeof updateSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const data = updateSchema.parse(input);
    const patch: Partial<typeof schema.service.$inferInsert> = {};
    if (data.name) patch.name = data.name;
    if (data.autoDeploy !== undefined) patch.autoDeploy = data.autoDeploy;
    if (data.source) {
      if (data.source.type === "git") {
        patch.source = { type: "git", repository: normalizeRepoUrl(data.source.repository), branch: data.source.branch, credentialId: data.source.credentialId ?? null };
      } else {
        const prev = service.source?.type === "image" ? service.source : null;
        patch.source = {
          type: "image",
          image: data.source.image,
          registryUsername: data.source.registryUsername || null,
          registryPassword:
            data.source.registryPassword === undefined
              ? (prev?.registryPassword ?? null)
              : data.source.registryPassword
                ? encrypt(data.source.registryPassword)
                : null,
        };
      }
    }
    if (data.build) patch.build = { ...defaultBuild(), ...service.build, ...data.build } as BuildConfig;
    if (data.runtime) {
      const runtime = { ...service.runtime, ...data.runtime } as RuntimeConfig;
      if (runtime.replicas > 1 && runtime.ports.length) throw new UserError("Published host ports only work with a single replica.");
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
      }
      patch.compose = { ...service.compose, ...data.compose };
    }
    await db.update(schema.service).set(patch).where(eq(schema.service.id, serviceId));
    if (data.runtime?.port !== undefined) await syncServiceProxy(serviceId).catch(() => {});
    return null;
  });
}

export async function regenerateWebhookSecret(serviceId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    await serviceInOrg(serviceId, ctx.org.id);
    await db.update(schema.service).set({ webhookSecret: newWebhookSecret() }).where(eq(schema.service.id, serviceId));
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
    await logActivity({ userId: ctx.user.id, projectId: service.projectId, action: "deploy.rollback", targetType: "service", targetId: service.id, message: `Rolled back ${service.name}` });
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
      await db
        .update(schema.deployment)
        .set({ status: "cancelled", finishedAt: new Date(), logs: "Cancelled before it started.\n" })
        .where(eq(schema.deployment.id, deploymentId));
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
    if (command === "start") {
      const hasContainers = service.currentDeploymentId || service.type === "database";
      if (!hasContainers) {
        await queueDeployment(serviceId, "manual", { userId: ctx.user.id });
        return null;
      }
    }
    await db
      .update(schema.service)
      .set({ status: command === "stop" ? "stopped" : command === "restart" ? "restarting" : "deploying" })
      .where(eq(schema.service.id, serviceId));
    await enqueue(`service.${command}`, { serviceId }, { concurrencyKey: `service:${serviceId}` });
    await logActivity({ userId: ctx.user.id, projectId: service.projectId, action: `service.${command}`, targetType: "service", targetId: service.id, message: `${command === "stop" ? "Stopped" : command === "start" ? "Started" : "Restarted"} ${service.name}` });
    return null;
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
    await db
      .update(schema.deployment)
      .set({ status: "cancelled" })
      .where(and(eq(schema.deployment.serviceId, serviceId), eq(schema.deployment.status, "queued")));
    await db.delete(schema.service).where(eq(schema.service.id, serviceId));
    await enqueue("service.delete", { serviceId, slug: service.slug, type: service.type, removeVolumes });
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
      await tx.insert(schema.envVar).values(
        vars.map((v) => ({ id: newId(), serviceId, key: v.key, value: encrypt(v.value), buildTime: v.buildTime, runtime: v.runtime })),
      );
    }
  });
}

export async function saveEnvVars(serviceId: string, vars: VarInput[], redeploy: boolean) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    await writeEnvVars(serviceId, vars.map((v) => ({ ...v, key: v.key.trim() })).filter((v) => v.key));
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
  redirectTo: z.string().trim().url().nullable().optional(),
  certificateId: z.string().nullable().optional(),
  cloudflare: z
    .object({ accountId: z.string(), zoneId: z.string(), proxied: z.boolean(), createRecord: z.boolean() })
    .nullable()
    .optional(),
});

export async function addDomain(serviceId: string, input: z.input<typeof domainSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    if (service.type === "database") throw new UserError("Databases are reached over TCP, not domains. Enable a public port instead.");
    const data = domainSchema.parse(input);
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
    if (data.cloudflare) {
      const [account] = await db
        .select({ id: schema.cloudflareAccount.id })
        .from(schema.cloudflareAccount)
        .where(and(eq(schema.cloudflareAccount.id, data.cloudflare.accountId), eq(schema.cloudflareAccount.organizationId, ctx.org.id)));
      if (!account) throw new UserError("Cloudflare account not found.");
      if (data.cloudflare.createRecord) {
        const settings = await getSettings();
        if (!settings.serverIp) throw new UserError("Set the server IP in Server settings before creating DNS records.");
        const cf = await Cloudflare.forAccount(account.id);
        try {
          const record = await cf.upsertARecord(data.cloudflare.zoneId, data.hostname, settings.serverIp, data.cloudflare.proxied);
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
        cloudflareAccountId: data.cloudflare?.accountId ?? null,
        cloudflareZoneId: data.cloudflare?.zoneId ?? null,
        cloudflareRecordId: recordId,
      })
      .returning();
    if (domain.https && !data.certificateId) await ensureCertificateFor(domain, ctx.org.id);
    await syncServiceProxy(serviceId).catch((e) => {
      warning = `Proxy not updated: ${(e as Error).message}`;
    });
    await logActivity({ userId: ctx.user.id, projectId: service.projectId, action: "domain.added", targetType: "service", targetId: serviceId, message: `Added ${data.hostname} to ${service.name}` });
    return { id: domain.id, warning };
  });
}

const domainUpdateSchema = z.object({
  port: z.number().int().min(1).max(65535).nullable().optional(),
  composeService: z.string().nullable().optional(),
  https: z.boolean().optional(),
  forceHttps: z.boolean().optional(),
  redirectTo: z.string().trim().url().nullable().optional(),
  certificateId: z.string().nullable().optional(),
});

export async function updateDomain(domainId: string, input: z.input<typeof domainUpdateSchema>) {
  return act(async () => {
    const ctx = await requireOrg();
    const [domain] = await db.select().from(schema.domain).where(eq(schema.domain.id, domainId));
    if (!domain) throw new UserError("Domain not found.");
    await serviceInOrg(domain.serviceId, ctx.org.id);
    const data = domainUpdateSchema.parse(input);
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
    await syncServiceProxy(domain.serviceId).catch(() => {});
    return null;
  });
}

export async function generateDomain(serviceId: string) {
  return act(async () => {
    const ctx = await requireOrg();
    const { service } = await serviceInOrg(serviceId, ctx.org.id);
    const generated = await generatedHostname(service.slug);
    if (!generated) throw new UserError("Set a wildcard domain or the server IP in Server settings first.");
    const [taken] = await db.select({ id: schema.domain.id }).from(schema.domain).where(eq(schema.domain.hostname, generated.hostname));
    if (taken) throw new UserError("The generated domain is already in use.");
    let composeService: string | null = null;
    if (service.type === "compose") composeService = composeServiceNames(service.compose?.content ?? "")[0] ?? null;
    await addGeneratedDomain(serviceId, service.slug, ctx.org.id, null, composeService);
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

export async function restoreFromBackup(backupId: string) {
  return act(async () => {
    const ctx = await requireOrgAdmin();
    const [b] = await db.select().from(schema.backup).where(eq(schema.backup.id, backupId));
    if (!b || b.status !== "success") throw new UserError("Backup not found.");
    const { service } = await serviceInOrg(b.serviceId, ctx.org.id);
    await enqueue("backup.restore", { backupId }, { concurrencyKey: `backup:${b.serviceId}` });
    await logActivity({ userId: ctx.user.id, projectId: service.projectId, action: "backup.restore", targetType: "service", targetId: service.id, message: `Restoring ${service.name} from a backup` });
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
        .where(and(eq(schema.service.type, "database"), ne(schema.service.id, serviceId)));
      if (clash.some((c) => c.database?.publicPort === service.database?.publicPort)) {
        throw new UserError("Another database already uses that public port.");
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
