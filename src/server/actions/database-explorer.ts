"use server";

import crypto from "node:crypto";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { decrypt } from "@/server/crypto";
import { logActivity } from "@/server/activity";
import type { schema } from "@/server/db";
import { serviceInOrg } from "@/server/services/access";
import { serverOf } from "@/server/servers/context";
import { execCommand } from "@/server/services/exec";
import { databaseContainer } from "@/server/databases/container";
import { databaseCreds } from "@/server/databases/options";
import {
  type Cell,
  type CellEdit,
  cleanError,
  type ColumnInfo,
  editCellScript,
  changesScript,
  staleChange,
  type TableChanges,
  COUNT_CAP,
  ExplorerInputError,
  explorerFamily,
  FILTER_OPS,
  framed,
  type IndexInfo,
  type KeyInfo,
  type KeyValue,
  kvBytes,
  kvCommandScript,
  kvKeyScript,
  kvKeyspaceScript,
  kvScanScript,
  MAX_OUTPUT,
  MAX_QUERY_BYTES,
  MONGO_READ_OPS,
  MONGO_WRITE_OPS,
  type MongoInput,
  type MongoOp,
  mongoScript,
  type Overview,
  PAGE_SIZE,
  parseChQuery,
  parseChRows,
  parseEditCount,
  parseKeyspace,
  parseKvKey,
  parseKvReply,
  parseKvScan,
  parseMongo,
  parseMyQuery,
  parseMyRows,
  parsePgQuery,
  parsePgRows,
  parseSqlOverview,
  parseSqlStructure,
  pipelineWrites,
  QUERY_LIMIT,
  QUERY_TIMEOUT,
  type QueryResult,
  readableEjson,
  type RowsPage,
  type Structure,
  sqlScripts,
  tokenizeCommand,
  checkKvCommand,
  unframe,
} from "@/server/databases/explorer";

type Service = typeof schema.service.$inferSelect;
type DatabaseService = Service & { database: NonNullable<Service["database"]> };

export type ExplorerOverview = Overview & { engine: string; family: "sql" | "mongo" | "kv" };
export type DocumentsPage = { documents: string[]; total: number | null; totalCapped: boolean };
export type ExplorerQueryResult = { result: QueryResult | null; error: string | null; ms: number };
export type { Cell, ColumnInfo, IndexInfo, KeyInfo, KeyValue, QueryResult, RowsPage, Structure };

/** Browsing and querying data is like opening a shell on the database: the console permission. */
async function explorerService(serviceId: string) {
  const ctx = await requirePermission("console.access");
  const { service } = await serviceInOrg(serviceId, ctx.org.id);
  if (service.type !== "database" || !service.database) throw new UserError("Not a database.");
  return { ctx, service: service as DatabaseService };
}

const MAX_SCRIPT_BYTES = 125_000;
const credsOf = (service: DatabaseService) => databaseCreds(service.database, decrypt(service.database.password));
const nonce = () => crypto.randomBytes(8).toString("hex");

/** Runs a script inside the database container; the password never shows in what comes back. */
async function runInDatabase(service: DatabaseService, body: string[], timeoutSeconds = QUERY_TIMEOUT) {
  if (service.status !== "running") throw new UserError(`${service.name} is not running. Start it to see its data.`);
  const password = decrypt(service.database.password);
  const script = framed(body, nonce(), timeoutSeconds);
  // The script is one argument of the exec, and Linux takes at most 128 KB for one.
  if (Buffer.byteLength(script, "utf8") > MAX_SCRIPT_BYTES) throw new UserError("This is too long to run here. Shorten the query or the values in it.");
  const { docker } = await serverOf(service);
  const started = Date.now();
  let res;
  try {
    const container = await databaseContainer(docker, service);
    res = await execCommand(container.id, script, { docker, timeoutSeconds: timeoutSeconds + 15, maxOutput: Math.ceil(MAX_OUTPUT * 1.4) + 65_536 });
  } catch (e) {
    throw new UserError(`Could not reach the database container: ${(e as Error).message}`);
  }
  const ms = Date.now() - started;
  const out = res.timedOut ? null : unframe(res.output);
  if (!out) {
    if (res.timedOut) throw new UserError(`The database did not answer within ${timeoutSeconds} seconds.`);
    throw new UserError(`The database container did not answer as expected: ${res.output.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
  }
  const redact = (s: string) => (password ? s.replaceAll(password, "***") : s);
  return { stdout: redact(out.stdout), stderr: redact(out.stderr), code: out.code, truncated: out.truncated, ms };
}

/** Output of a script that must succeed; the engine's own error otherwise. */
async function runOk(service: DatabaseService, body: string[]) {
  const r = await runInDatabase(service, body);
  if (r.code === 124 || r.code === 143) throw new UserError(`The database did not answer within ${QUERY_TIMEOUT} seconds.`);
  if (r.code !== 0) throw new UserError(cleanError(service.database.engine, r.stderr) || `The database refused (exit code ${r.code}).`);
  return r;
}

/** Input errors from the script builders, shown as they are. */
function scripted<T>(build: () => T): T {
  try {
    return build();
  } catch (e) {
    if (e instanceof ExplorerInputError) throw new UserError(e.message);
    throw e;
  }
}

const nameSchema = z.string().max(1024);
const refSchema = z.object({ database: nameSchema, schema: nameSchema.nullable().optional(), table: nameSchema.min(1) });
const rowsSchema = refSchema.extend({
  page: z.number().int().min(0).max(1_000_000).default(0),
  sort: z
    .object({ column: nameSchema.min(1), desc: z.boolean() })
    .nullable()
    .optional(),
  filter: z
    .object({ column: nameSchema, op: z.enum(FILTER_OPS as [string, ...string[]]), value: z.string().max(10_000).optional() })
    .nullable()
    .optional(),
  /** The order without a sort: the primary key, so pages stay put. */
  order: z.array(nameSchema.min(1)).max(32).optional(),
  /** MongoDB: a filter and a sort as Extended JSON. */
  mongoFilter: z.string().max(MAX_QUERY_BYTES).optional(),
  mongoSort: z.string().max(10_000).optional(),
});

function sqlEngine(service: DatabaseService) {
  const engine = service.database.engine;
  if (engine !== "postgres" && engine !== "mysql" && engine !== "mariadb" && engine !== "clickhouse") throw new UserError("Not a SQL database.");
  return engine;
}

function databaseNumber(database: string) {
  const n = Number(database || "0");
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new UserError("Unknown database number.");
  return n;
}

function mongoResult<T>(stdout: string, truncated: boolean): T {
  if (truncated) throw new UserError("The answer was too large to show. Narrow the filter or use a projection.");
  const r = parseMongo<T>(stdout);
  if ("error" in r && r.error) throw new UserError(r.error);
  return r as T;
}

/** Databases (or Redis database numbers) and the tables or collections of one of them. */
export async function explorerOverview(serviceId: string, database?: string | null) {
  return act(async (): Promise<ExplorerOverview> => {
    const { service } = await explorerService(serviceId);
    const engine = service.database.engine;
    const family = explorerFamily(engine);
    const c = credsOf(service);
    if (family === "kv") {
      const r = await runOk(service, kvKeyspaceScript(engine, c));
      const reply = parseKvReply(r.stdout);
      if ("error" in reply) throw new UserError(reply.error);
      return { engine, family, databases: parseKeyspace(r.stdout), database: String(databaseNumber(database ?? "0")), schemas: [], tables: [] };
    }
    const name = nameSchema.parse(database || c.database);
    if (family === "mongo") {
      const r = await runOk(service, mongoScript(c, { op: "overview", db: name }));
      const data = mongoResult<{ databases: Overview["databases"]; tables: Omit<Overview["tables"][number], "schema">[] }>(r.stdout, r.truncated);
      return {
        engine,
        family,
        databases: data.databases.filter((d) => !["local", "config"].includes(d.name)).sort((a, b) => a.name.localeCompare(b.name)),
        database: name,
        schemas: [],
        tables: data.tables.map((t) => ({ ...t, schema: null })).sort((a, b) => a.name.localeCompare(b.name)),
      };
    }
    const r = await runOk(service, sqlScripts(sqlEngine(service), c).overview(name));
    return { engine, family, ...parseSqlOverview(engine, r.stdout, name) };
  });
}

/** Columns and indexes of a table (for MongoDB, the fields seen in its first documents). */
export async function explorerStructure(serviceId: string, input: z.input<typeof refSchema>) {
  return act(async (): Promise<Structure> => {
    const { service } = await explorerService(serviceId);
    const ref = refSchema.parse(input);
    const c = credsOf(service);
    if (explorerFamily(service.database.engine) === "mongo") {
      const r = await runOk(service, mongoScript(c, { op: "structure", db: ref.database, collection: ref.table }));
      const data = mongoResult<{ found: boolean; indexes?: { name: string; key: string; unique: boolean }[]; fields?: Record<string, Record<string, number>> }>(
        r.stdout,
        r.truncated,
      );
      if (!data.found) throw new UserError(`There is no collection named ${ref.table}.`);
      return {
        columns: Object.entries(data.fields ?? {}).map(([name, types]) => ({
          name,
          type: Object.keys(types).join(", "),
          nullable: "null" in types,
          default: null,
          primaryKey: name === "_id",
        })),
        indexes: (data.indexes ?? []).map((i) => ({
          name: i.name,
          definition: readableEjson(i.key).replace(/\s+/g, " "),
          unique: i.unique || i.name === "_id_",
          primary: i.name === "_id_",
        })),
      };
    }
    const engine = sqlEngine(service);
    const r = await runOk(
      service,
      scripted(() => sqlScripts(engine, c).structure({ database: ref.database, schema: ref.schema ?? null, name: ref.table })),
    );
    const structure = parseSqlStructure(engine, r.stdout);
    if (!structure) throw new UserError(`There is no table named ${ref.table}.`);
    return structure;
  });
}

/** A page of rows, sorted and filtered (for MongoDB, documents as Extended JSON). */
export async function explorerRows(serviceId: string, input: z.input<typeof rowsSchema>) {
  return act(async (): Promise<RowsPage | DocumentsPage> => {
    const { service } = await explorerService(serviceId);
    const req = rowsSchema.parse(input);
    const c = credsOf(service);
    if (explorerFamily(service.database.engine) === "mongo") {
      const r = await runOk(
        service,
        mongoScript(c, { op: "documents", db: req.database, collection: req.table, filter: req.mongoFilter, sort: req.mongoSort, skip: req.page * PAGE_SIZE, limit: PAGE_SIZE }),
      );
      const data = mongoResult<{ docs: string[]; total: number }>(r.stdout, r.truncated);
      return { documents: data.docs.map(readableEjson), total: Math.min(data.total, COUNT_CAP), totalCapped: data.total > COUNT_CAP };
    }
    const engine = sqlEngine(service);
    const marker = `SERVE_NULL_${nonce()}`;
    const filter = req.filter ? { column: req.filter.column, op: req.filter.op as (typeof FILTER_OPS)[number], value: req.filter.value } : null;
    const r = await runOk(
      service,
      scripted(() =>
        sqlScripts(engine, c).rows({ database: req.database, schema: req.schema ?? null, name: req.table, order: req.order }, req.page, req.sort ?? null, filter, marker),
      ),
    );
    return engine === "postgres" ? parsePgRows(r.stdout, marker, r.truncated) : engine === "clickhouse" ? parseChRows(r.stdout, r.truncated) : parseMyRows(r.stdout, r.truncated);
  });
}

/** Redis / Valkey keys matching a pattern, a page at a time (cursor "0" starts; "0" back means the end). */
export async function explorerKeys(serviceId: string, input: { database: string; pattern?: string; cursor?: string }) {
  return act(async () => {
    const { service } = await explorerService(serviceId);
    if (explorerFamily(service.database.engine) !== "kv") throw new UserError("Keys are for Redis and Valkey.");
    const pattern = z
      .string()
      .max(1024)
      .parse(input.pattern ?? "*");
    const r = await runOk(
      service,
      scripted(() => kvScanScript(service.database.engine, credsOf(service), databaseNumber(input.database), input.cursor ?? "0", pattern)),
    );
    try {
      return parseKvScan(r.stdout);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  });
}

/** One key: its type, TTL, size and a page of its value. */
export async function explorerKey(serviceId: string, input: { database: string; key: string; at?: string }) {
  return act(async (): Promise<KeyValue> => {
    const { service } = await explorerService(serviceId);
    if (explorerFamily(service.database.engine) !== "kv") throw new UserError("Keys are for Redis and Valkey.");
    const key = z
      .string()
      .min(1)
      .max(64 * 1024)
      .parse(input.key);
    const r = await runOk(
      service,
      scripted(() => kvKeyScript(service.database.engine, credsOf(service), databaseNumber(input.database), kvBytes(key), input.at ?? "0")),
    );
    try {
      return parseKvKey(r.stdout, key);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  });
}

const querySchema = z.object({
  database: nameSchema,
  query: z.string(),
  /** On unless turned off: the query runs where it cannot change data. */
  readOnly: z.boolean().default(true),
  /** MongoDB: the collection, the operation and (for distinct) the field. */
  collection: nameSchema.optional(),
  operation: z.enum([...MONGO_READ_OPS, ...MONGO_WRITE_OPS] as [MongoOp, ...MongoOp[]]).optional(),
  field: nameSchema.optional(),
});

/**
 * Runs a query (SQL, a Redis command, or a MongoDB operation). Errors of the database come back as
 * `error`, with the time taken; read only mode is enforced by the database where it can be.
 */
export async function explorerQuery(serviceId: string, input: z.input<typeof querySchema>) {
  return act(async (): Promise<ExplorerQueryResult> => {
    const { ctx, service } = await explorerService(serviceId);
    const req = querySchema.parse(input);
    if (Buffer.byteLength(req.query, "utf8") > MAX_QUERY_BYTES) throw new UserError(`Queries are limited to ${MAX_QUERY_BYTES / 1024} KB.`);
    const engine = service.database.engine;
    const family = explorerFamily(engine);
    const c = credsOf(service);
    const marker = `serve_rc_${nonce()}`;
    let body: string[];
    let parse: (stdout: string, truncated: boolean) => QueryResult;
    if (family === "kv") {
      const args = scripted(() => tokenizeCommand(req.query));
      const refused = checkKvCommand(args, req.readOnly);
      if (refused) throw new UserError(refused);
      body = scripted(() => kvCommandScript(engine, c, databaseNumber(req.database), args));
      parse = (stdout) => {
        const reply = parseKvReply(stdout);
        if ("error" in reply) throw new EngineError(reply.error);
        if ("text" in reply) return { kind: "text", text: reply.text };
        return { kind: "value", value: JSON.stringify(reply.value, null, 2) ?? "null" };
      };
    } else if (family === "mongo") {
      const op = req.operation ?? "find";
      if (!req.collection) throw new UserError("Choose a collection.");
      if (req.readOnly && !MONGO_READ_OPS.includes(op)) throw new UserError(`${op} changes data, so it is not allowed in read only mode. Allow changes to run it.`);
      if (op === "aggregate" && req.readOnly) {
        let pipeline: unknown;
        try {
          pipeline = JSON.parse(req.query || "[]");
        } catch (e) {
          throw new UserError(`The pipeline is not valid JSON: ${(e as Error).message}`);
        }
        if (pipelineWrites(pipeline)) throw new UserError("$out and $merge write to a collection, so they are not allowed in read only mode. Allow changes to use them.");
      }
      if (op === "distinct" && !req.field) throw new UserError("Name the field to list the values of.");
      const mongoInput: MongoInput = { op, db: req.database, collection: req.collection, query: req.query, field: req.field, limit: QUERY_LIMIT, readOnly: req.readOnly };
      body = mongoScript(c, mongoInput);
      parse = (stdout, truncated) => {
        if (truncated) throw new EngineError("The answer was too large to show. Narrow the query or use a projection.");
        const r = parseMongo<{ docs?: string[]; more?: boolean; count?: number; affected?: number; message?: string }>(stdout);
        if ("error" in r && r.error) throw new EngineError(r.error);
        const data = r as { docs?: string[]; more?: boolean; count?: number; affected?: number; message?: string };
        if (data.docs) return { kind: "documents", documents: data.docs.map(readableEjson), truncated: !!data.more };
        if (data.count !== undefined) return { kind: "value", value: String(data.count) };
        return { kind: "done", affected: data.affected ?? null, message: data.message ?? null };
      };
    } else {
      const sql = sqlEngine(service);
      body = scripted(() => sqlScripts(sql, c).query(req.database, req.query, { readOnly: req.readOnly, timeoutSeconds: QUERY_TIMEOUT }, marker));
      parse = (stdout, truncated) =>
        sql === "postgres" ? parsePgQuery(stdout, marker, truncated) : sql === "clickhouse" ? parseChQuery(stdout, truncated) : parseMyQuery(stdout, marker, truncated);
    }

    if (!req.readOnly) {
      const text = req.query.replace(/\s+/g, " ").trim();
      await logActivity({
        userId: ctx.user.id,
        organizationId: ctx.org.id,
        projectId: service.projectId,
        action: "database.query",
        targetType: "service",
        targetId: service.id,
        message: `Ran a query that can change data in ${service.name}${family === "mongo" ? ` (${req.operation ?? "find"} on ${req.collection})` : ""}: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`,
      });
    }

    const r = await runInDatabase(service, body);
    if (r.code === 124 || r.code === 143) return { result: null, error: `The query did not finish within ${QUERY_TIMEOUT} seconds.`, ms: r.ms };
    if (r.code !== 0) return { result: null, error: cleanError(engine, r.stderr) || `The database refused (exit code ${r.code}).`, ms: r.ms };
    try {
      return { result: parse(r.stdout, r.truncated), error: null, ms: r.ms };
    } catch (e) {
      if (e instanceof EngineError) return { result: null, error: e.message, ms: r.ms };
      throw e;
    }
  });
}

class EngineError extends Error {}

const editSchema = z.object({
  database: nameSchema,
  schema: nameSchema.nullable().optional(),
  table: nameSchema.min(1),
  key: z
    .array(z.object({ column: nameSchema.min(1), value: z.string().max(10_000) }))
    .min(1)
    .max(32),
  column: nameSchema.min(1),
  value: z
    .string()
    .max(MAX_QUERY_BYTES / 2)
    .nullable(),
});

/** Types whose values the rows show as hex or text that would not write back as they read. */
const NOT_EDITABLE = /blob|binary|^bit\b|geometry|point|polygon|linestring/i;

/** Sets one value of one row, found by its primary key. */
export async function explorerEditCell(serviceId: string, input: z.input<typeof editSchema>) {
  return act(async () => {
    const { ctx, service } = await explorerService(serviceId);
    const edit = editSchema.parse(input) as CellEdit;
    const engine = sqlEngine(service);
    if (engine === "clickhouse") throw new UserError("Rows of ClickHouse tables are changed with ALTER TABLE … UPDATE, in the Query tab.");
    const c = credsOf(service);
    const ref = { database: edit.database, schema: engine === "postgres" ? (edit.schema ?? "public") : null, name: edit.table };
    const structure = parseSqlStructure(
      engine,
      (
        await runOk(
          service,
          scripted(() => sqlScripts(engine, c).structure(ref)),
        )
      ).stdout,
    );
    if (!structure) throw new UserError(`There is no table named ${edit.table}.`);
    const primary = structure.columns.filter((col) => col.primaryKey);
    if (!primary.length) throw new UserError("Only rows of a table with a primary key can be changed here. Use the Query tab.");
    const keyColumns = new Set(edit.key.map((k) => k.column));
    if (keyColumns.size !== primary.length || primary.some((col) => !keyColumns.has(col.name)))
      throw new UserError("The key does not match the primary key of the table. Refresh the rows.");
    if (primary.some((col) => NOT_EDITABLE.test(col.type))) throw new UserError("Rows with a binary primary key are changed in the Query tab.");
    const column = structure.columns.find((col) => col.name === edit.column);
    if (!column) throw new UserError(`There is no column named ${edit.column}.`);
    if (column.primaryKey) throw new UserError("Values of the primary key are changed in the Query tab.");
    if (NOT_EDITABLE.test(column.type)) throw new UserError(`Values of type ${column.type} are changed in the Query tab.`);
    if (edit.value === null && !column.nullable) throw new UserError(`${edit.column} cannot be NULL.`);
    const r = await runOk(
      service,
      scripted(() => editCellScript(engine, c, { ...edit, schema: ref.schema })),
    );
    if (!parseEditCount(r.stdout)) throw new UserError("No row has this key any more. Refresh the rows and try again.");
    const key = edit.key.map((k) => `${k.column} = ${k.value.length > 60 ? `${k.value.slice(0, 60)}…` : k.value}`).join(", ");
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.row-edited",
      targetType: "service",
      targetId: service.id,
      message: `Changed ${edit.column} of the row ${key} in ${edit.table} (${service.name})`,
    });
    return null;
  });
}

const keySchema = z
  .array(z.object({ column: nameSchema.min(1), value: z.string().max(10_000) }))
  .min(1)
  .max(32);
const valuesSchema = z.record(nameSchema.min(1), z.string().max(MAX_QUERY_BYTES).nullable());
const changesSchema = z.object({
  database: nameSchema,
  schema: nameSchema.nullable().optional(),
  table: nameSchema.min(1),
  updates: z
    .array(z.object({ key: keySchema, values: valuesSchema }))
    .max(500)
    .default([]),
  inserts: z
    .array(z.object({ values: valuesSchema }))
    .max(500)
    .default([]),
  deletes: z
    .array(z.object({ key: keySchema }))
    .max(500)
    .default([]),
});

/**
 * Saves edits, new rows and deleted rows of one table together, in one transaction: all of
 * them or, when one row changed or went since it was shown, none.
 */
export async function explorerSaveChanges(serviceId: string, input: z.input<typeof changesSchema>) {
  return act(async () => {
    const { ctx, service } = await explorerService(serviceId);
    const req = changesSchema.parse(input);
    const engine = sqlEngine(service);
    if (engine === "clickhouse") throw new UserError("Rows of ClickHouse tables are changed with ALTER TABLE … UPDATE, in the Query tab.");
    const total = req.updates.length + req.inserts.length + req.deletes.length;
    if (!total) throw new UserError("There are no changes to save.");
    if (total > 500) throw new UserError("Save at most 500 changes at once.");
    const c = credsOf(service);
    const ref = { database: req.database, schema: engine === "postgres" ? (req.schema ?? "public") : null, name: req.table };
    const structure = parseSqlStructure(
      engine,
      (
        await runOk(
          service,
          scripted(() => sqlScripts(engine, c).structure(ref)),
        )
      ).stdout,
    );
    if (!structure) throw new UserError(`There is no table named ${req.table}.`);
    const byName = new Map(structure.columns.map((col) => [col.name, col]));
    const primary = structure.columns.filter((col) => col.primaryKey);
    const checkKey = (key: { column: string }[]) => {
      if (!primary.length) throw new UserError("Only rows of a table with a primary key can be changed here. Use the Query tab.");
      const names = new Set(key.map((k) => k.column));
      if (names.size !== primary.length || primary.some((col) => !names.has(col.name)))
        throw new UserError("A row's key does not match the primary key of the table. Refresh the rows.");
      if (primary.some((col) => NOT_EDITABLE.test(col.type))) throw new UserError("Rows with a binary primary key are changed in the Query tab.");
    };
    const checkValues = (values: Record<string, string | null>, insert: boolean) => {
      for (const [name, value] of Object.entries(values)) {
        const col = byName.get(name);
        if (!col) throw new UserError(`There is no column named ${name}.`);
        if (!insert && col.primaryKey) throw new UserError("Values of the primary key are changed in the Query tab.");
        if (NOT_EDITABLE.test(col.type)) throw new UserError(`Values of type ${col.type} are changed in the Query tab.`);
        if (value === null && !col.nullable) throw new UserError(`${name} cannot be NULL.`);
      }
    };
    for (const u of req.updates) {
      checkKey(u.key);
      checkValues(u.values, false);
    }
    for (const d of req.deletes) checkKey(d.key);
    for (const i of req.inserts) checkValues(i.values, true);
    const changes: TableChanges = { database: req.database, schema: ref.schema, table: req.table, updates: req.updates, inserts: req.inserts, deletes: req.deletes };
    const r = await runInDatabase(
      service,
      scripted(() => changesScript(engine, c, changes)),
    );
    const output = `${r.stdout}\n${r.stderr}`;
    if (r.code === 124 || r.code === 143) throw new UserError(`The database did not answer within ${QUERY_TIMEOUT} seconds. Nothing was saved.`);
    const stale = staleChange(engine, output);
    if (stale !== null) {
      const what = stale <= req.updates.length ? `changed row ${stale}` : `deleted row ${stale - req.updates.length}`;
      throw new UserError(`Nothing was saved: the ${what} changed or went since it was shown. Refresh the rows.`);
    }
    if (r.code !== 0 || !r.stdout.includes("SERVE_SAVED")) {
      // The MariaDB client prints the failed statement before its error: the error line says why.
      const line = /^ERROR \d+[^\n]*/m.exec(output)?.[0];
      throw new UserError(`Nothing was saved. ${line ?? (cleanError(service.database.engine, r.stderr) || `The database refused (exit code ${r.code}).`)}`);
    }
    const parts = [
      req.updates.length && `changed ${req.updates.length} row${req.updates.length === 1 ? "" : "s"}`,
      req.inserts.length && `added ${req.inserts.length}`,
      req.deletes.length && `deleted ${req.deletes.length}`,
    ].filter(Boolean);
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.rows-changed",
      targetType: "service",
      targetId: service.id,
      message: `In ${req.table} (${service.name}): ${parts.join(", ")}`,
    });
    return { updated: req.updates.length, inserted: req.inserts.length, deleted: req.deletes.length };
  });
}

const documentSchema = z.object({ database: nameSchema, collection: nameSchema.min(1), id: z.string().min(1).max(10_000), document: z.string().max(MAX_QUERY_BYTES) });

/** Replaces one MongoDB document (found by its _id) with an edited one. */
export async function explorerEditDocument(serviceId: string, input: z.input<typeof documentSchema>) {
  return act(async () => {
    const { ctx, service } = await explorerService(serviceId);
    if (explorerFamily(service.database.engine) !== "mongo") throw new UserError("Documents are for MongoDB.");
    const req = documentSchema.parse(input);
    const r = await runOk(
      service,
      mongoScript(credsOf(service), { op: "replace", db: req.database, collection: req.collection, id: req.id, query: req.document, readOnly: false }),
    );
    const data = mongoResult<{ affected: number }>(r.stdout, r.truncated);
    if (!data.affected) throw new UserError("This document is gone. Refresh the documents.");
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      projectId: service.projectId,
      action: "database.document-edited",
      targetType: "service",
      targetId: service.id,
      message: `Changed the document ${req.id.replace(/\s+/g, "").slice(0, 80)} in ${req.collection} (${service.name})`,
    });
    return null;
  });
}
