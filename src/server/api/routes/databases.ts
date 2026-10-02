import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import * as databases from "@/server/actions/databases";
import * as branches from "@/server/actions/database-branches";
import * as dbUsers from "@/server/actions/database-users";
import * as explorer from "@/server/actions/database-explorer";
import { FILTER_OPS, MONGO_READ_OPS, MONGO_WRITE_OPS } from "@/server/databases/explorer";
import { databasePublicEndpoint } from "@/server/databases/public-url";
import { saveDatabaseDomain } from "@/server/actions/database-domains";
import * as tasks from "@/server/actions/tasks";
import * as monitoring from "@/server/actions/monitoring";
import { setMaintenance } from "@/server/actions/maintenance";
import { applyDatabaseChanges } from "@/server/actions/services";
import { iso, loadService } from "../data";
import { ApiError, type ApiRoute, assertCan, route, unwrap } from "../router";

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
      const endpoint = secrets ? await databasePublicEndpoint(service, auth.organizationId) : null;
      if (endpoint) {
        const { databaseUrl } = await import("@/server/databases/options");
        const { decryptOrNull } = await import("@/server/crypto");
        publicUrl = databaseUrl(cfg, { username: cfg.username, password: decryptOrNull(cfg.password) ?? "", database: cfg.database }, endpoint.host, endpoint.port, {
          public: true,
          verified: endpoint.verified,
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
    description: "Without password a new one is generated. Choosing the password needs variables.view-secrets too. Services that use it get the new value on their next deploy.",
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
      'via "direct": the database gets its own public port and speaks TLS with the domain\'s certificate. via "tunnel": reached through a Cloudflare Tunnel, no port opened. hostname null takes it off its domain. allow (direct only): the addresses or ranges let through its port, empty for everyone; left out keeps the list.',
    needs: ["domains.manage"],
    body: z.object({
      hostname: z.string().nullable(),
      via: z.enum(["direct", "tunnel"]).default("direct"),
      allow: z.array(z.string().max(100)).max(200).nullable().optional(),
    }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return unwrap(saveDatabaseDomain(params.serviceId, body.hostname, body.via, { allow: body.allow }));
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
          personalDataHidden: b.scrubbed,
          sourceBranchId: b.sourceBranchId,
          allDatabases: b.allDatabases,
          extraDatabases: b.extraDatabases,
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
    description:
      "A copy of the database inside the same container, with a user of its own. hidePersonalData: true runs the database's branch clean-up SQL on every copy (PUT /services/{serviceId}/branches/cleanup-sql). sourceBranchId copies another ready branch instead of the main database; a copy of a branch with personal data hidden hides it too. allDatabases: true also copies every other database of the server as <database>__<branch>, reached by the same login and by ${{db.branches.<name>.databases.<database>.DATABASE_URL}}.",
    needs: ["services.manage"],
    body: z.object({ name: z.string(), hidePersonalData: z.boolean().optional(), sourceBranchId: z.string().nullable().optional(), allDatabases: z.boolean().optional() }),
    status: 202,
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return (
        (await unwrap(
          branches.createDatabaseBranch(params.serviceId, body.name, {
            hidePersonalData: body.hidePersonalData,
            sourceBranchId: body.sourceBranchId,
            allDatabases: body.allDatabases,
          }),
        )) ?? { ok: true }
      );
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/branches/cleanup-sql",
    tag: "Databases",
    summary: "Set the clean-up SQL that hides personal data in branches",
    description: "It runs on the copy of every branch made with hidePersonalData, for example \"UPDATE users SET email = id || '@example.com';\". null removes it.",
    needs: ["services.manage"],
    body: z.object({ sql: z.string().nullable() }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return (await unwrap(branches.saveBranchCleanupSql(params.serviceId, body.sql))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/branches/{branchId}/reset",
    tag: "Databases",
    summary: "Copy the data into a branch again, from the main database or its source branch",
    needs: ["services.manage"],
    status: 202,
    handler: async ({ params }) => (await unwrap(branches.resetDatabaseBranch(params.branchId))) ?? { ok: true },
  }),
  route({
    method: "DELETE",
    path: "/branches/{branchId}",
    tag: "Databases",
    summary: "Delete a database branch",
    description: "?children=true also deletes the branches copied from it, and the ones copied from those. Without it they stay, and copy the main data on their next reset.",
    needs: ["services.manage"],
    query: z.object({ children: z.enum(["true", "false"]).optional() }),
    handler: async ({ params, query }) => (await unwrap(branches.deleteDatabaseBranch(params.branchId, { withChildren: query.children === "true" }))) ?? { ok: true },
  }),

  // Users
  route({
    method: "GET",
    path: "/services/{serviceId}/users",
    tag: "Databases",
    summary: "List the users of a database",
    description:
      "The logins inside a running PostgreSQL, MySQL, MariaDB or MongoDB database, read from the database. managed: made by Serve, which knows its access and password. protectedReason: Serve's own login, a branch's login or one built into the database; these are not changed here.",
    needs: ["projects.view"],
    handler: async ({ auth, params }) => {
      await databaseOf(auth, params.serviceId);
      return await unwrap(dbUsers.listDatabaseUsers(params.serviceId));
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/users",
    tag: "Databases",
    summary: "Add a database user",
    description:
      "access: read, readwrite or owner, on each of databases. Leave out password and Serve makes one. Returns the password and the connection URLs. Needs variables.view-secrets too.",
    needs: ["services.manage", "variables.view-secrets"],
    body: z.object({ username: z.string(), password: z.string().optional(), access: z.enum(["read", "readwrite", "owner"]), databases: z.array(z.string()).min(1) }),
    status: 201,
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return { user: await unwrap(dbUsers.createDatabaseUser(params.serviceId, body)) };
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/users/{username}/connection",
    tag: "Databases",
    summary: "Password and connection URLs of a database user Serve made",
    needs: ["projects.view", "variables.view-secrets"],
    handler: async ({ auth, params }) => {
      await databaseOf(auth, params.serviceId);
      return { user: await unwrap(dbUsers.databaseUserUrls(params.serviceId, params.username)) };
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/users/{username}/access",
    tag: "Databases",
    summary: "Change the access of a database user",
    description: "The new access replaces the old one on every database.",
    needs: ["services.manage"],
    body: z.object({ access: z.enum(["read", "readwrite", "owner"]), databases: z.array(z.string()).min(1) }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return (await unwrap(dbUsers.setDatabaseUserAccess(params.serviceId, params.username, body.access, body.databases))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/users/{username}/password",
    tag: "Databases",
    summary: "Change the password of a database user",
    description: "Leave out password and Serve makes one. Returns the new password and connection URLs.",
    needs: ["services.manage", "variables.view-secrets"],
    body: z.object({ password: z.string().optional() }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return { user: await unwrap(dbUsers.changeDatabaseUserPassword(params.serviceId, params.username, body.password)) };
    },
  }),
  route({
    method: "DELETE",
    path: "/services/{serviceId}/users/{username}",
    tag: "Databases",
    summary: "Delete a database user",
    description: "On PostgreSQL, objects the user made are given to the main login first.",
    needs: ["services.manage"],
    handler: async ({ auth, params }) => {
      await databaseOf(auth, params.serviceId);
      return (await unwrap(dbUsers.deleteDatabaseUser(params.serviceId, params.username))) ?? { ok: true };
    },
  }),

  // Data
  route({
    method: "GET",
    path: "/services/{serviceId}/data",
    tag: "Databases",
    summary: "Databases and tables of a database service",
    description:
      "Read from the running database: its databases (Redis and Valkey: database numbers with keys) and the tables or collections of one of them, with estimated row counts and sizes. database: the one to list (the main database when left out). Like the console, this needs console.access.",
    needs: ["projects.view", "console.access"],
    query: z.object({ database: z.string().optional() }),
    handler: async ({ auth, params, query }) => {
      await databaseOf(auth, params.serviceId);
      return await unwrap(explorer.explorerOverview(params.serviceId, query.database));
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/data/structure",
    tag: "Databases",
    summary: "Columns and indexes of a table",
    description: "schema: PostgreSQL only (public when left out). For MongoDB, the fields seen in the first 100 documents of the collection, with their types.",
    needs: ["projects.view", "console.access"],
    query: z.object({ database: z.string(), schema: z.string().optional(), table: z.string() }),
    handler: async ({ auth, params, query }) => {
      await databaseOf(auth, params.serviceId);
      return await unwrap(explorer.explorerStructure(params.serviceId, query));
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/data/rows",
    tag: "Databases",
    summary: "A page of rows of a table",
    description: `50 rows per page (page counts from 0), sorted by one column (else by the columns of order, like the primary key) and filtered by one condition (op: ${FILTER_OPS.join(", ")}). Values come back as text, null for NULL. total counts up to 10000 matching rows (totalCapped: more). For MongoDB, mongoFilter and mongoSort are Extended JSON and documents come back as Extended JSON text, with versions (one per document) to send back when replacing one. Reads only.`,
    needs: ["projects.view", "console.access"],
    body: z.object({
      database: z.string(),
      schema: z.string().nullable().optional(),
      table: z.string(),
      page: z.number().int().min(0).default(0),
      sort: z
        .object({ column: z.string(), desc: z.boolean().default(false) })
        .nullable()
        .optional(),
      filter: z
        .object({ column: z.string(), op: z.enum(FILTER_OPS as [string, ...string[]]), value: z.string().optional() })
        .nullable()
        .optional(),
      order: z.array(z.string()).optional(),
      mongoFilter: z.string().optional(),
      mongoSort: z.string().optional(),
    }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return await unwrap(explorer.explorerRows(params.serviceId, body));
    },
  }),
  route({
    method: "PATCH",
    path: "/services/{serviceId}/data/rows",
    tag: "Databases",
    summary: "Change one value of a row",
    description:
      "PostgreSQL, MySQL and MariaDB. The row is found by its whole primary key (key: each column with the value the row shows); value null sets NULL. original: the value the row showed in column; when it holds another one now, nothing is changed. Values of the primary key and binary values are changed with a query instead. Needs services.manage too. Written to the activity log.",
    needs: ["projects.view", "console.access", "services.manage"],
    body: z.object({
      database: z.string(),
      schema: z.string().nullable().optional(),
      table: z.string(),
      key: z.array(z.object({ column: z.string(), value: z.string() })).min(1),
      column: z.string(),
      value: z.string().nullable(),
      original: z.string().nullable().optional(),
    }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return (await unwrap(explorer.explorerEditCell(params.serviceId, body))) ?? { ok: true };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/data/changes",
    tag: "Databases",
    summary: "Save changed, new and deleted rows of a table together",
    description:
      "PostgreSQL, MySQL and MariaDB, in one transaction: all of them or none. updates and deletes find each row by its whole primary key (key: each column with the value the row shows); values maps columns to new values (null sets NULL). inserts give the columns to set; the others get their defaults. original (updates and deletes): the values the row showed, for some or all of its columns. When a row went, or holds other values than original, nothing is saved. At most 500 changes. Needs services.manage too. Written to the activity log.",
    needs: ["projects.view", "console.access", "services.manage"],
    body: z.object({
      database: z.string(),
      schema: z.string().nullable().optional(),
      table: z.string(),
      updates: z
        .array(
          z.object({
            key: z.array(z.object({ column: z.string(), value: z.string() })).min(1),
            values: z.record(z.string(), z.string().nullable()),
            original: z.record(z.string(), z.string().nullable()).optional(),
          }),
        )
        .optional(),
      inserts: z.array(z.object({ values: z.record(z.string(), z.string().nullable()) })).optional(),
      deletes: z
        .array(z.object({ key: z.array(z.object({ column: z.string(), value: z.string() })).min(1), original: z.record(z.string(), z.string().nullable()).optional() }))
        .optional(),
    }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return await unwrap(explorer.explorerSaveChanges(params.serviceId, body));
    },
  }),
  route({
    method: "PUT",
    path: "/services/{serviceId}/data/documents",
    tag: "Databases",
    summary: "Replace a MongoDB document",
    description:
      'id: the _id of the document as Extended JSON (like {"$oid": "…"} or 42). document: the new document as Extended JSON; its _id, if given, must stay the same. version: the version of the document as the documents page gave it (versions, in the order of documents); when the document holds something else now, nothing is changed. Needs services.manage too. Written to the activity log.',
    needs: ["projects.view", "console.access", "services.manage"],
    body: z.object({ database: z.string(), collection: z.string(), id: z.string(), document: z.string(), version: z.string().optional() }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      return (await unwrap(explorer.explorerEditDocument(params.serviceId, body))) ?? { ok: true };
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/data/keys",
    tag: "Databases",
    summary: "Redis or Valkey keys matching a pattern",
    description:
      "About 100 keys per call with their type, TTL (milliseconds; -1 never expires) and size. Pass the cursor of the answer to get the next keys; cursor 0 means there are no more.",
    needs: ["projects.view", "console.access"],
    query: z.object({ database: z.string().default("0"), pattern: z.string().optional(), cursor: z.string().optional() }),
    handler: async ({ auth, params, query }) => {
      await databaseOf(auth, params.serviceId);
      return await unwrap(explorer.explorerKeys(params.serviceId, query));
    },
  }),
  route({
    method: "GET",
    path: "/services/{serviceId}/data/key",
    tag: "Databases",
    summary: "The value of a Redis or Valkey key",
    description:
      "Its type, TTL and size, and up to 50 entries of its value (strings: the first 64 KB). at: where to continue, from next of the answer (0: the start). A key that is not UTF-8 is given in its quoted form, as the key list shows it.",
    needs: ["projects.view", "console.access"],
    query: z.object({ database: z.string().default("0"), key: z.string(), at: z.string().optional() }),
    handler: async ({ auth, params, query }) => {
      await databaseOf(auth, params.serviceId);
      return { key: await unwrap(explorer.explorerKey(params.serviceId, query)) };
    },
  }),
  route({
    method: "POST",
    path: "/services/{serviceId}/data/query",
    tag: "Databases",
    summary: "Run a query",
    description: `SQL for PostgreSQL, MySQL, MariaDB and ClickHouse; a command for Redis and Valkey (like GET "my key"); for MongoDB, an operation (${[...MONGO_READ_OPS, ...MONGO_WRITE_OPS].join(", ")}) on collection with query as Extended JSON (find and count: a filter; aggregate: a pipeline; distinct: a filter, with field; insert: documents; update: { filter, update }; delete: a filter). readOnly (true unless set to false) runs it where it cannot change data: a read-only transaction of one statement, readonly=2 on ClickHouse, read commands on Redis. At most 1000 rows, 30 seconds. An error of the database comes back as error with status 200. Queries with readOnly false need services.manage too, and are written to the activity log.`,
    needs: ["projects.view", "console.access"],
    body: z.object({
      database: z.string(),
      query: z.string(),
      readOnly: z.boolean().default(true),
      collection: z.string().optional(),
      operation: z.enum([...MONGO_READ_OPS, ...MONGO_WRITE_OPS] as [string, ...string[]]).optional(),
      field: z.string().optional(),
    }),
    handler: async ({ auth, params, body }) => {
      await databaseOf(auth, params.serviceId);
      if (!body.readOnly) assertCan(auth, "services.manage");
      return await unwrap(explorer.explorerQuery(params.serviceId, body as Parameters<typeof explorer.explorerQuery>[1]));
    },
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
