import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "@/server/env";

const globalForDb = globalThis as unknown as {
  sql?: postgres.Sql;
};

export const sql =
  globalForDb.sql ??
  postgres(env.databaseUrl.startsWith("build-placeholder") ? "postgres://build@127.0.0.1:1/build" : env.databaseUrl, {
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idle_timeout: 30,
    onnotice: () => {},
  });

if (process.env.NODE_ENV !== "production") globalForDb.sql = sql;

export const db = drizzle(sql, { schema, casing: "snake_case" });
export type DB = typeof db;
export { schema };
