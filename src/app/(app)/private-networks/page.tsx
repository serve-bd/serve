import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { canManageServer } from "@/server/servers/access";
import { db, schema } from "@/server/db";
import { meshNetworks } from "@/server/mesh";
import { meshServerAddress } from "@/lib/mesh";
import { getSettings } from "@/server/settings";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { PrivateNetworks } from "./private-networks";

export const metadata = { title: "Private networks" };

export default async function PrivateNetworksPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { view } = await props.searchParams;
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin && !ctx.isAdmin) redirect("/");
  const [allNetworks, allServers, settings] = await Promise.all([
    meshNetworks(),
    db
      .select({
        id: schema.server.id,
        name: schema.server.name,
        isLocal: schema.server.isLocal,
        status: schema.server.status,
        mesh: schema.server.mesh,
        meshIndex: schema.server.meshIndex,
        ownerOrganizationId: schema.server.ownerOrganizationId,
      })
      .from(schema.server)
      .orderBy(asc(schema.server.name)),
    getSettings(),
  ]);
  // Root admins see everything; an organization's admins see its own networks and servers.
  const servers = allServers.filter((s) => canManageServer(ctx, s));
  const networks = ctx.isInstanceAdmin
    ? allNetworks
    : allNetworks.filter((n) => n.organizationId === ctx.org.id).map((n) => ({ ...n, servers: n.servers.filter((s) => servers.some((x) => x.id === s.id)) }));
  return (
    <>
      <PageHeader
        title="Private networks"
        description="Servers in the same network reach each other's services by their private names, over encrypted WireGuard links. Servers in different networks stay apart."
      />
      <PageBody>
        <PrivateNetworks
          view={view === "canvas" ? "canvas" : "list"}
          positions={settings.networkCanvas}
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
