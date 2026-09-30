import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { meshNetworks } from "@/server/mesh";
import { meshServerAddress } from "@/lib/mesh";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { PrivateNetworks } from "./private-networks";

export const metadata = { title: "Private networks" };

export default async function PrivateNetworksPage() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) redirect("/");
  const [networks, servers] = await Promise.all([
    meshNetworks(),
    db
      .select({
        id: schema.server.id,
        name: schema.server.name,
        isLocal: schema.server.isLocal,
        status: schema.server.status,
        mesh: schema.server.mesh,
        meshIndex: schema.server.meshIndex,
      })
      .from(schema.server)
      .orderBy(asc(schema.server.name)),
  ]);
  return (
    <>
      <PageHeader
        title="Private networks"
        description="Servers in the same network reach each other's services by their private names, over encrypted WireGuard links. Servers in different networks stay apart."
      />
      <PageBody>
        <PrivateNetworks
          networks={networks}
          servers={servers.map((s) => ({
            id: s.id,
            name: s.name,
            joined: !!s.mesh?.enabled && s.meshIndex !== null,
            state: s.mesh?.enabled ? s.mesh.state : null,
            message: s.mesh?.enabled ? (s.mesh.message ?? null) : null,
            address: s.mesh?.enabled && s.meshIndex !== null ? meshServerAddress(s.meshIndex) : null,
            nat: !!s.mesh?.enabled && !s.mesh.endpoint,
          }))}
        />
      </PageBody>
    </>
  );
}
