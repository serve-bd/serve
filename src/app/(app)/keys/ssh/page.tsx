import { desc, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { redirect } from "next/navigation";
import { requireOrg } from "@/server/auth";
import { KeysView } from "./keys-view";

export const metadata = { title: "SSH keys" };

export default async function KeysPage() {
  // SSH keys reach servers, which belong to the whole instance.
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) redirect("/keys/api-tokens");
  const keys = await db
    .select({
      id: schema.privateKey.id,
      name: schema.privateKey.name,
      description: schema.privateKey.description,
      publicKey: schema.privateKey.publicKey,
      fingerprint: schema.privateKey.fingerprint,
      createdAt: schema.privateKey.createdAt,
      servers: sql<string[]>`coalesce((select array_agg(s.name order by s.name) from server s where s.private_key_id = "private_key"."id"), '{}')`,
    })
    .from(schema.privateKey)
    .orderBy(desc(schema.privateKey.createdAt));
  return <KeysView keys={keys.map((k) => ({ ...k, createdAt: k.createdAt.toISOString() }))} />;
}
