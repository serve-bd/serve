import "dotenv/config";
import { createAccount } from "@/server/accounts";
import { db, schema, sql } from "@/server/db";
import { newId } from "@/server/id";
import { getSetting } from "@/server/settings";

async function main() {
  const [email, password, role = "admin"] = process.argv.slice(2);
  const user = await createAccount({ name: "Test User", email, password });
  const root = await getSetting("rootOrganizationId");
  if (root) await db.insert(schema.member).values({ id: newId(), organizationId: root, userId: user.id, role: role as "admin" });
  console.log("created", user.id);
  await sql.end();
}
main().catch(async (e) => {
  console.error(e.message);
  await sql.end();
  process.exit(1);
});
