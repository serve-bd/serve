import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { env } from "@/server/env";
import { tunnelPort } from "@/server/tunnel";
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
  const [local] = await db.select({ publicIp: schema.server.publicIp }).from(schema.server).where(eq(schema.server.isLocal, true));
  // The address a server without a public IP connects out to: this machine's public IP by default.
  const tunnel = { address: local?.publicIp ?? new URL(env.appUrl).hostname, port: tunnelPort() };
  return (
    <>
      <PageHeader title="Add server" breadcrumbs={[{ label: "Servers", href: "/servers" }, { label: "Add server" }]} />
      <PageBody>
        <AddServer keys={keys} tunnel={tunnel} />
      </PageBody>
    </>
  );
}
