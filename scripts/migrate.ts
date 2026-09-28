import "dotenv/config";
import { runMigrations } from "@/server/db/migrate";
import { sql } from "@/server/db";

runMigrations()
  .then(async () => {
    console.log("Migrations applied");
    await sql.end();
  })
  .catch(async (error) => {
    console.error(error);
    await sql.end();
    process.exit(1);
  });
