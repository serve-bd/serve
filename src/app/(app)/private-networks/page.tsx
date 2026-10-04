import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { requireOrg } from "@/server/auth";
import { listedInOrg, serverAllowsOrg } from "@/server/servers/access";
import { db, schema } from "@/server/db";
import { meshNetworks } from "@/server/mesh";
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
  // In Root every network and server; in another organization its own networks and servers.
  // A server shared with it sits in networks of its owner, which this page does not show.
  // Servers shared with it are listed too once they joined the private network (their owner joins them),
  // so its admins can add them to its networks.
  const joined = (s: (typeof allServers)[number]) => !!s.mesh?.enabled && s.meshIndex !== null;
  const servers = allServers.filter(
    (s) =>
      (listedInOrg(ctx, s) && (ctx.isRoot || s.ownerOrganizationId === ctx.org.id)) ||
      (!ctx.isRoot && s.ownerOrganizationId !== ctx.org.id && serverAllowsOrg(s, ctx.org.id) && joined(s)),
  );
  const isShared = (s: (typeof allServers)[number]) => !ctx.isRoot && s.ownerOrganizationId !== ctx.org.id;
  const networks =
    ctx.isInstanceAdmin && ctx.isRoot
      ? allNetworks
      : allNetworks.filter((n) => n.organizationId === ctx.org.id).map((n) => ({ ...n, servers: n.servers.filter((s) => servers.some((x) => x.id === s.id)) }));
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
