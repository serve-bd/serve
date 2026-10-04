import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { meshNetworks } from "@/server/mesh";
import { visibleNetworks } from "@/server/mesh/visible";
import { meshServerAddress } from "@/lib/mesh";
import { getSettings } from "@/server/settings";
import { PrivateNetworks } from "./private-networks";

export const metadata = { title: "Private networks" };

export default async function PrivateNetworksPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { view: asked } = await props.searchParams;
  // The address wins, then the choice from last time.
  const view = typeof asked === "string" ? asked : (await cookies()).get("serve-networks-view")?.value;
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
        organizationIds: schema.server.organizationIds,
      })
      .from(schema.server)
      .orderBy(asc(schema.server.name)),
    getSettings(),
  ]);
  const { networks, servers, isShared } = visibleNetworks(ctx, allNetworks, allServers);
  return (
    <PrivateNetworks
      view={view === "canvas" ? "canvas" : "list"}
      positions={settings.networkCanvas}
      canArrange={ctx.isInstanceAdmin}
      networks={networks}
      servers={servers.map((s) => ({
        id: s.id,
        name: s.name,
        joined: !!s.mesh?.enabled && s.meshIndex !== null,
        state: s.mesh?.enabled ? s.mesh.state : null,
        message: s.mesh?.enabled ? (s.mesh.message ?? null) : null,
        address: s.mesh?.enabled && s.meshIndex !== null ? meshServerAddress(s.meshIndex) : null,
        nat: !!s.mesh?.enabled && !s.mesh.endpoint,
        shared: isShared(s),
      }))}
    />
  );
}
