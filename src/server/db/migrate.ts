import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { db } from "./index";

export async function runMigrations() {
  const folder = process.env.SERVE_MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
  await migrate(db, { migrationsFolder: folder });
}
