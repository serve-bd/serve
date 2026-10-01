import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import * as databases from "@/server/actions/databases";
import * as branches from "@/server/actions/database-branches";
import { saveDatabaseDomain } from "@/server/actions/database-domains";
import * as tasks from "@/server/actions/tasks";
import * as monitoring from "@/server/actions/monitoring";
import { setMaintenance } from "@/server/actions/maintenance";
import { applyDatabaseChanges } from "@/server/actions/services";
import { iso, loadService } from "../data";
import { ApiError, type ApiRoute, route, unwrap } from "../router";

const SECRET_KEYS = new Set(["PASSWORD", "DATABASE_URL", "REDIS_URL", "MONGO_URL", "POSTGRES_URL", "MYSQL_URL"]);

async function databaseOf(auth: Parameters<typeof loadService>[0], serviceId: string) {
  const row = await loadService(auth, serviceId);
  if (row.service.type !== "database" || !row.service.database) throw new ApiError(400, "Not a database.");
  return row;
}

async function taskOf(auth: Parameters<typeof loadService>[0], taskId: string) {
  const [task] = await db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.id, taskId));
  if (!task) throw new ApiError(404, "Task not found");
  await loadService(auth, task.serviceId).catch(() => {
    throw new ApiError(404, "Task not found");
  });
  return task;
}

const taskView = (t: typeof schema.scheduledTask.$inferSelect) => ({
  id: t.id,
  serviceId: t.serviceId,
  name: t.name,
  schedule: t.schedule,
  command: t.command,
  composeService: t.composeService,
  enabled: t.enabled,
  timeoutSeconds: t.timeoutSeconds,
  lastRunAt: iso(t.lastRunAt),
  lastStatus: t.lastStatus,
});

export const databaseRoutes: ApiRoute[] = [
  route({
    method: "GET",
    path: "/services/{serviceId}/connection",
    tag: "Databases",
    summary: "Connection details of a database",
    description:
      "Host, port, user, database and URLs on the private network, and the public URL when it has a public port or a domain. Passwords and URLs need variables.view-secrets; without it they are left out.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      const { service } = await databaseOf(auth, params.serviceId);
      const { providedVars } = await import("@/server/services/variables");
      const vars = providedVars(service);
      const secrets = auth.can("variables.view-secrets");
      const cfg = service.database!;
      let publicUrl: string | null = null;
      if (secrets && cfg.publicPort && cfg.publicBind !== "127.0.0.1") {
        const { databaseUrl } = await import("@/server/databases/options");
        const { decryptOrNull } = await import("@/server/crypto");
        const { serverPublicIp } = await import("@/server/servers/access");
        const host = cfg.domain && !cfg.domainTunnelId ? cfg.domain : await serverPublicIp(service.serverId);
        if (host)
          publicUrl = databaseUrl(cfg, { username: cfg.username, password: decryptOrNull(cfg.password) ?? "", database: cfg.database }, host, cfg.publicPort, {
            public: true,
            verified: !!cfg.domain && !!cfg.tls?.enabled,
          });
      }
      return {
        connection: {
          engine: cfg.engine,
          variables: Object.fromEntries(Object.entries(vars).filter(([k]) => secrets || !SECRET_KEYS.has(k))),
          publicPort: cfg.publicPort ?? null,
          domain: cfg.domain ?? null,
          publicUrl,
        },
      };
    },
  }),
  route({
    method: "PATCH",
    path: "/services/{serviceId}/database",
    tag: "Databases",
    summary: "Change database settings",
    description:
      "image, initdbArgs, hostAuthMethod, charset, collation, initScripts, customConfig, extraArgs, dataMountPath, tls, healthcheck, backupRetentionS3. The public port, IP allowlist, version and backup schedule are changed with PATCH /services/{serviceId} under database. apply: true restarts the database with the new settings.",
    needs: ["services.manage"],
    body: z.looseObject({ apply: z.boolean().optional() }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      const { apply, ...settings } = body as { apply?: boolean } & Record<string, unknown>;
      const r = await unwrap(databases.updateDatabaseSettings(params.serviceId, settings as never));
      if (apply) await unwrap(applyDatabaseChanges(params.serviceId));
      return r ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/database/apply",
    tag: "Databases",
    summary: "Restart a database with its saved settings",
    needs: ["services.deploy"],
    status: 202,
    handler: async ({ auth, params }) => {
      await databaseOf(auth, params.serviceId);
      return (await unwrap(applyDatabaseChanges(params.serviceId))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/database/password",
    tag: "Databases",
    summary: "Change the database password",
    description: "Without password a new one is generated. Services that use it get the new value on their next deploy.",
    needs: ["services.manage"],
    body: z.object({ password: z.string().optional() }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return (await unwrap(databases.changeDatabasePassword(params.serviceId, body.password))) ?? { ok: true };
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/database/dependents",
    tag: "Databases",
    summary: "Services that use this database",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await databaseOf(auth, params.serviceId);
      return { dependents: await unwrap(databases.databaseDependents(params.serviceId)) };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/database/domain",
    tag: "Databases",
    summary: "Put a database on a domain",
    description:
      'via "direct": the database gets its own public port and speaks TLS with the domain\'s certificate. via "tunnel": reached through a Cloudflare Tunnel, no port opened. hostname null takes it off its domain.',
    needs: ["domains.manage"],
    body: z.object({ hostname: z.string().nullable(), via: z.enum(["direct", "tunnel"]).default("direct") }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return unwrap(saveDatabaseDomain(params.serviceId, body.hostname, body.via));
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/database/import",
    tag: "Backups",
    summary: "Import a dump from a URL or S3 and restore it",
    description: 'source: {"kind":"url","url":"https://..."} or {"kind":"s3","destinationId":"...","key":"path/to/dump"}.',
    needs: ["databases.backups"],
    body: z.object({
      source: z.union([z.object({ kind: z.literal("url"), url: z.string() }), z.object({ kind: z.literal("s3"), destinationId: z.string(), key: z.string() })]),
      backupFirst: z.boolean().default(true),
      users: z.boolean().default(false),
    }),
    status: 202,
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return (await unwrap(databases.importBackupFromRemote(params.serviceId, body.source, body.backupFirst, body.users))) ?? { ok: true };
    },
  }),

  // Branches
  route({
    method: "GET",
    path: "/services/{serviceId}/branches",
    tag: "Databases",
    summary: "List database branches",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await databaseOf(auth, params.serviceId);
      const rows = await db.select().from(schema.databaseBranch).where(eq(schema.databaseBranch.serviceId, params.serviceId)).orderBy(asc(schema.databaseBranch.name));
      return {
        branches: rows.map((b) => ({
          id: b.id,
          name: b.name,
          database: b.database,
          username: b.username,
          status: b.status,
          error: b.error,
          sizeBytes: b.sizeBytes,
          copiedAt: iso(b.copiedAt),
          previewServiceId: b.previewServiceId,
          createdAt: iso(b.createdAt),
        })),
      };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/branches",
    tag: "Databases",
    summary: "Create a database branch",
    description: "A copy of the database inside the same container, with a user of its own.",
    needs: ["services.manage"],
    body: z.object({ name: z.string() }),
    status: 202,
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return (await unwrap(branches.createDatabaseBranch(params.serviceId, body.name))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/branches/{branchId}/reset",
    tag: "Databases",
    summary: "Copy the main database into a branch again",
    needs: ["services.manage"],
    status: 202,
    handler: async ({ params }) => (await unwrap(branches.resetDatabaseBranch(params.branchId))) ?? { ok: true },
  }),
  route({
    method: "DELETE",
    path: "/branches/{branchId}",
    tag: "Databases",
    summary: "Delete a database branch",
    needs: ["services.manage"],
    handler: async ({ params }) => (await unwrap(branches.deleteDatabaseBranch(params.branchId))) ?? { ok: true },
  }),

  // Scheduled tasks
  route({
    method: "GET",
    path: "/services/{serviceId}/tasks",
    tag: "Tasks",
    summary: "List scheduled tasks",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      const rows = await db.select().from(schema.scheduledTask).where(eq(schema.scheduledTask.serviceId, params.serviceId)).orderBy(asc(schema.scheduledTask.name));
      return { tasks: rows.map(taskView) };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/tasks",
    tag: "Tasks",
    summary: "Create a scheduled task",
    description: "A command run in the service's container on a cron schedule.",
    needs: ["services.manage"],
    body: z.looseObject({
      name: z.string(),
      schedule: z.string(),
      command: z.string(),
      composeService: z.string().nullable().optional(),
      timeoutSeconds: z.number().int().optional(),
    }),
    status: 201,
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return (await unwrap(tasks.saveTask(params.serviceId, null, body as never))) ?? { ok: true };
    },
  }),
  route({
    method: "PATCH",
    path: "/tasks/{taskId}",
    tag: "Tasks",
    summary: "Change a scheduled task",
    description: "enabled alone turns it on or off; other fields replace its settings.",
    needs: ["services.manage"],
    body: z.looseObject({ enabled: z.boolean().optional() }),
    handler: async ({ auth, params, body }) => {
      const task = await taskOf(auth, params.taskId);
      const { enabled, ...rest } = body as { enabled?: boolean } & Record<string, unknown>;
      if (Object.keys(rest).length)
        await unwrap(
          tasks.saveTask(task.serviceId, task.id, {
            name: task.name,
            schedule: task.schedule,
            command: task.command,
            composeService: task.composeService,
            timeoutSeconds: task.timeoutSeconds,
            ...rest,
          } as never),
        );
      if (enabled !== undefined) await unwrap(tasks.toggleTask(task.id, enabled));
      return { task: taskView(await taskOf(auth, task.id)) };
    },
  }),
  route({
    method: "DELETE",
    path: "/tasks/{taskId}",
    tag: "Tasks",
    summary: "Delete a scheduled task",
    needs: ["services.manage"],
    handler: async ({ auth, params }) => {
      await taskOf(auth, params.taskId);
      await unwrap(tasks.deleteTask(params.taskId));
      return { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/tasks/{taskId}/run",
    tag: "Tasks",
    summary: "Run a task now",
    needs: ["services.deploy"],
    status: 202,
    handler: async ({ auth, params }) => {
      await taskOf(auth, params.taskId);
      return (await unwrap(tasks.runTaskNow(params.taskId))) ?? { ok: true };
    },
  }),
  route({
    method: "GET",
    path: "/tasks/{taskId}/runs",
    tag: "Tasks",
    summary: "Recent runs of a task",
    needs: ["logs.view"],
    handler: async ({ auth, params }) => {
      await taskOf(auth, params.taskId);
      const rows = await db.select().from(schema.taskRun).where(eq(schema.taskRun.taskId, params.taskId)).orderBy(desc(schema.taskRun.startedAt)).limit(50);
      return {
        runs: rows.map((r) => ({
          id: r.id,
          trigger: r.trigger,
          status: r.status,
          exitCode: r.exitCode,
          output: r.output,
          startedAt: iso(r.startedAt),
          finishedAt: iso(r.finishedAt),
        })),
      };
    },
  }),

  // Monitoring and maintenance
  route({
    method: "PUT",
    path: "/services/{serviceId}/monitor",
    tag: "Monitoring",
    summary: "Set the uptime check of a service",
    description: 'kind "http" checks a URL; kind "container" checks that the containers run.',
    needs: ["services.manage"],
    body: z.looseObject({ enabled: z.boolean(), kind: z.enum(["http", "container"]), url: z.string().optional() }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return (await unwrap(monitoring.saveMonitor(params.serviceId, body as never))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/monitor/check",
    tag: "Monitoring",
    summary: "Run the uptime check now",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await loadService(auth, params.serviceId);
      return { result: await unwrap(monitoring.checkMonitorNow(params.serviceId)) };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/maintenance",
    tag: "Services",
    summary: "Turn the maintenance page on or off",
    description: "allow: IP addresses or ranges that still reach the app.",
    needs: ["services.deploy"],
    body: z.object({ enabled: z.boolean(), title: z.string().optional(), message: z.string().optional(), allow: z.array(z.string()).optional() }),
    handler: async ({ auth, params, body }) => {
      await loadService(auth, params.serviceId);
      return (await unwrap(setMaintenance(params.serviceId, body))) ?? { ok: true };
    },
  }),
];
