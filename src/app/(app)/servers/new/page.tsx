import { redirect } from "next/navigation";
import { desc, eq, isNull } from "drizzle-orm";
import { canAddServers, ownerFor } from "@/server/servers/access";
import { env } from "@/server/env";
import { tunnelPort } from "@/server/tunnel";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { AddServer } from "./add-server";

export const metadata = { title: "Add server" };

export default async function NewServerPage() {
  const ctx = await requireOrg();
  if (!canAddServers(ctx)) redirect("/servers");
  // The new server belongs to this organization (the instance in Root), and so do the keys it can use.
  const owner = ownerFor(ctx);
  const keys = await db
    .select({ id: schema.privateKey.id, name: schema.privateKey.name, publicKey: schema.privateKey.publicKey, fingerprint: schema.privateKey.fingerprint })
    .from(schema.privateKey)
    .where(owner ? eq(schema.privateKey.organizationId, owner) : isNull(schema.privateKey.organizationId))
    .orderBy(desc(schema.privateKey.createdAt));
  const [local] = await db.select({ publicIp: schema.server.publicIp }).from(schema.server).where(eq(schema.server.isLocal, true));
  // The address a server without a public IP connects out to: this machine's public IP by default.
  // Never a loopback address: the other machine would connect to itself.
  const fromUrl = new URL(env.appUrl).hostname;
  const tunnel = { address: local?.publicIp ?? (/^(localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/.test(fromUrl) ? "" : fromUrl), port: tunnelPort() };
  return (
    <>
      <PageHeader title="Add server" breadcrumbs={[{ label: "Servers", href: "/servers" }, { label: "Add server" }]} />
      <PageBody>
        <AddServer keys={keys} tunnel={tunnel} />
      </PageBody>
    </>
  );
}
