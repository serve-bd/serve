import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { AddServer } from "./add-server";

export const metadata = { title: "Add server" };

export default async function NewServerPage() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) redirect("/");
  const keys = await db
    .select({ id: schema.privateKey.id, name: schema.privateKey.name, publicKey: schema.privateKey.publicKey, fingerprint: schema.privateKey.fingerprint })
    .from(schema.privateKey)
    .orderBy(desc(schema.privateKey.createdAt));
  return (
    <>
      <PageHeader title="Add server" breadcrumbs={[{ label: "Servers", href: "/servers" }, { label: "Add server" }]} />
      <PageBody>
        <AddServer keys={keys} />
      </PageBody>
    </>
  );
}
