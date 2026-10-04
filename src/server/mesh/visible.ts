import type { OrgContext } from "@/server/auth";
import type { ServerMesh } from "@/server/db/schema";
import { listedInOrg, serverAllowsOrg } from "@/server/servers/ownership";

type Ctx = Pick<OrgContext, "isInstanceAdmin" | "isAdmin" | "isRoot" | "org">;

export type MeshServerRow = {
  id: string;
  name: string;
  mesh: ServerMesh | null;
  meshIndex: number | null;
  ownerOrganizationId: string | null;
  organizationIds: string[] | null;
};

export type MeshNetworkRow = { id: string; name: string; organizationId: string | null; servers: { id: string; name: string; joined: boolean }[] };

export const meshJoined = (s: Pick<MeshServerRow, "mesh" | "meshIndex">) => !!s.mesh?.enabled && s.meshIndex !== null;

/**
 * The private networks and servers an organization sees (the Private networks page and the API).
 * In Root every network and server; in another organization its own networks and servers.
 * A server shared with it sits in networks of its owner, which are not shown; servers shared with
 * it are listed too once they joined the private network (their owner joins them), so its admins
 * can add them to its networks.
 */
export function visibleNetworks<S extends MeshServerRow, N extends MeshNetworkRow>(ctx: Ctx, allNetworks: N[], allServers: S[]) {
  const servers = allServers.filter(
    (s) =>
      (listedInOrg(ctx, s) && (ctx.isRoot || s.ownerOrganizationId === ctx.org.id)) ||
      (!ctx.isRoot && s.ownerOrganizationId !== ctx.org.id && serverAllowsOrg(s, ctx.org.id) && meshJoined(s)),
  );
  const networks =
    ctx.isInstanceAdmin && ctx.isRoot
      ? allNetworks
      : allNetworks.filter((n) => n.organizationId === ctx.org.id).map((n) => ({ ...n, servers: n.servers.filter((s) => servers.some((x) => x.id === s.id)) }));
  const isShared = (s: S) => !ctx.isRoot && s.ownerOrganizationId !== ctx.org.id;
  return { networks, servers, isShared };
}
