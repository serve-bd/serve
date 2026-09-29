import { desc, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { KeysView } from "./keys-view";

export const metadata = { title: "SSH keys" };

export default async function KeysPage() {
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
