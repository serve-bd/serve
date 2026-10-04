import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import type { ServerTailscale } from "@/server/db/schema";
import * as tailscale from "@/server/actions/tailscale";
import * as integrations from "@/server/actions/integrations";
import * as mesh from "@/server/actions/mesh";
import { iso } from "../data";
import { ApiError, type ApiRoute, route, unwrap } from "../router";

/*
 * How servers are reached: Tailscale (Root admins, like the dashboard), Cloudflare Tunnels
 * (integrations.manage) and private networks between servers (admins).
 */

async function orgContext() {
  const { requireOrg } = await import("@/server/auth");
  return requireOrg();
}

/* -------------------------------- Tailscale -------------------------------- */

/** The tailnet asked for, or the only one connected. */
async function tailnetId(asked: string | undefined) {
  if (asked) return asked;
  const rows = await db.select({ id: schema.tailscaleTailnet.id }).from(schema.tailscaleTailnet);
  if (rows.length === 1) return rows[0].id;
  if (!rows.length) throw new ApiError(409, "No tailnet is connected. Connect one in Integrations, Tailscale.");
  throw new ApiError(400, "Several tailnets are connected: pass tailnetId (see GET /tailscale/tailnets).");
}

/** What the API shows of a server's Tailscale state: never the join token's hash or the auth key. */
function tailscaleView(ts: ServerTailscale | null, tailnets: { id: string; name: string }[]) {
  if (!ts) return null;
  const joined = !!ts.address;
  return {
    tailnetId: ts.tailnetId,
    tailnet: tailnets.find((t) => t.id === ts.tailnetId)?.name ?? null,
    hostname: ts.hostname || null,
    only: ts.only,
    joined,
    /** A join command was made and has not run yet. */
    waitingForJoin: !joined && !!ts.tokenHash && !!ts.tokenExpiresAt && new Date(ts.tokenExpiresAt).getTime() > Date.now(),
    joinCommandExpiresAt: joined ? null : ts.tokenExpiresAt,
    address: ts.address,
    dnsName: ts.dnsName,
    online: ts.online,
    lastSeen: ts.lastSeen,
    joinedAt: ts.joinedAt,
    checkedAt: ts.checkedAt,
    error: ts.error,
  };
}

async function originOf(request: Request, asked?: string) {
  if (asked) return asked;
  const { publicBaseUrl } = await import("@/server/git/github-app");
  return (await publicBaseUrl().catch(() => "")) || new URL(request.url).origin;
}

/* ----------------------------- Cloudflare Tunnels ---------------------------- */

async function orgAccount(organizationId: string, accountId: string) {
  const [row] = await db
    .select({ id: schema.cloudflareAccount.id, name: schema.cloudflareAccount.name })
    .from(schema.cloudflareAccount)
    .where(and(eq(schema.cloudflareAccount.id, accountId), eq(schema.cloudflareAccount.organizationId, organizationId)));
  if (!row) throw new ApiError(404, "Cloudflare account not found");
  return row;
}

/* ----------------------------- Private networks ----------------------------- */

async function visibleMesh() {
  const ctx = await orgContext();
  const { meshNetworks } = await import("@/server/mesh");
  const { visibleNetworks } = await import("@/server/mesh/visible");
  const [allNetworks, allServers] = await Promise.all([
    meshNetworks(),
    db
      .select({
        id: schema.server.id,
        name: schema.server.name,
        status: schema.server.status,
        mesh: schema.server.mesh,
        meshIndex: schema.server.meshIndex,
        ownerOrganizationId: schema.server.ownerOrganizationId,
        organizationIds: schema.server.organizationIds,
      })
      .from(schema.server)
      .orderBy(asc(schema.server.name)),
  ]);
  return { ctx, ...visibleNetworks(ctx, allNetworks, allServers) };
}

/** A network this organization sees (another organization's answers 404, as if it did not exist). */
async function visibleNetwork(networkId: string) {
  const view = await visibleMesh();
  const network = view.networks.find((n) => n.id === networkId);
  if (!network) throw new ApiError(404, "Private network not found");
  return { ...view, network };
}

export const networkingRoutes: ApiRoute[] = [
  // Tailscale
  route({
    method: "GET",
    path: "/tailscale/tailnets",
    tag: "Tailscale",
    summary: "List connected tailnets",
    description: "With the servers in each. Credentials are not shown. Root admins only: servers join the instance's tailnet.",
    needs: ["instance"],
    handler: async () => {
      const { serversByTailnet, syncTailscale } = await import("@/server/tailscale");
      // Like the Integrations page: the tailnet as it is now, at most one check every 10 seconds.
      const stale = await db.select({ checkedAt: schema.tailscaleTailnet.checkedAt }).from(schema.tailscaleTailnet);
      if (stale.some((t) => !t.checkedAt || Date.now() - t.checkedAt.getTime() > 10_000)) await syncTailscale().catch(() => {});
      const [rows, byTailnet] = await Promise.all([db.select().from(schema.tailscaleTailnet).orderBy(asc(schema.tailscaleTailnet.createdAt)), serversByTailnet()]);
      return {
        tailnets: rows.map((t) => ({
          id: t.id,
          name: t.name,
          tailnet: t.tailnet,
          authType: t.authType,
          clientId: t.clientId,
          tag: t.tag,
          dnsSuffix: t.dnsSuffix,
          error: t.error,
          checkedAt: iso(t.checkedAt),
          createdAt: iso(t.createdAt),
          servers: (byTailnet.get(t.id) ?? []).map((s) => ({
            id: s.id,
            name: s.name,
            isLocal: s.isLocal,
            address: s.tailscale?.address ?? null,
            online: s.tailscale?.online ?? null,
            only: !!s.tailscale?.only,
          })),
        })),
      };
    },
  }),
  route({
    method: "GET",
    path: "/servers/{serverId}/tailscale",
    tag: "Tailscale",
    summary: "A server's Tailscale state",
    description: "null when the server does not use a tailnet. Root admins only.",
    needs: ["instance"],
    handler: async ({ params }) => {
      const [row] = await db
        .select({ id: schema.server.id, name: schema.server.name, tailscale: schema.server.tailscale, ownerOrganizationId: schema.server.ownerOrganizationId })
        .from(schema.server)
        .where(eq(schema.server.id, params.serverId));
      if (!row) throw new ApiError(404, "Server not found");
      const tailnets = await db.select({ id: schema.tailscaleTailnet.id, name: schema.tailscaleTailnet.name }).from(schema.tailscaleTailnet);
      // An organization's servers are reached at their public address, never through the instance's tailnet.
      return { server: { id: row.id, name: row.name }, canJoin: !row.ownerOrganizationId, tailscale: tailscaleView(row.tailscale, tailnets) };
    },
  }),
  route({
    method: "POST",
    path: "/servers/{serverId}/tailscale/join-command",
    tag: "Tailscale",
    summary: "Make a command that puts the server in a tailnet",
    description:
      "Run the command on the server; until it ran, Serve reaches the server as before. tailnetId: the tailnet (optional when only one is connected). origin: the dashboard address the server calls (this instance's address by default). Root admins only.",
    needs: ["instance"],
    body: z.object({ tailnetId: z.string().optional(), origin: z.string().url().optional() }),
    handler: async ({ params, body, request }) => unwrap(tailscale.tailscaleJoinCommand(params.serverId, await tailnetId(body.tailnetId), await originOf(request, body.origin))),
  }),
  route({
    method: "POST",
    path: "/servers/{serverId}/tailscale/connect",
    tag: "Tailscale",
    summary: "Put a server in a tailnet now",
    description:
      "Serve installs Tailscale and joins the server by itself (over SSH, or through the host for the dashboard's own machine). The server must be reachable. When it is in another tailnet already, the answer has moveNeeded: true: send force: true to move it. Root admins only.",
    needs: ["instance"],
    body: z.object({ tailnetId: z.string().optional(), force: z.boolean().optional() }),
    handler: async ({ params, body }) => unwrap(tailscale.connectThroughTailscale(params.serverId, await tailnetId(body.tailnetId), !!body.force)),
  }),
  route({
    method: "DELETE",
    path: "/servers/{serverId}/tailscale",
    tag: "Tailscale",
    summary: "Stop using Tailscale for a server",
    description: "Serve reaches it as before (its address or tunnel). removeDevice=true also takes the machine out of the tailnet. Root admins only.",
    needs: ["instance"],
    query: z.object({ removeDevice: z.enum(["true", "false"]).optional() }),
    handler: async ({ params, query }) => (await unwrap(tailscale.stopUsingTailscale(params.serverId, query.removeDevice === "true"))) ?? { ok: true },
  }),

  // Cloudflare Tunnels
  route({
    method: "GET",
    path: "/cloudflare/accounts/{accountId}/tunnels",
    tag: "Integrations",
    summary: "List the tunnels of a Cloudflare account",
    description: "One tunnel per server, with the domains routed through it (those of projects the token can reach).",
    needs: ["integrations.manage"],
    handler: async ({ auth, params }) => {
      const account = await orgAccount(auth.organizationId, params.accountId);
      const rows = await db
        .select({ tunnel: schema.cloudflareTunnel, serverName: schema.server.name })
        .from(schema.cloudflareTunnel)
        .innerJoin(schema.server, eq(schema.cloudflareTunnel.serverId, schema.server.id))
        .where(and(eq(schema.cloudflareTunnel.organizationId, auth.organizationId), eq(schema.cloudflareTunnel.cloudflareAccountId, account.id)))
        .orderBy(asc(schema.server.name));
      const routed = rows.length
        ? await db
            .select({
              tunnelId: schema.domain.tunnelId,
              hostname: schema.domain.hostname,
              serviceId: schema.service.id,
              serviceName: schema.service.name,
              projectId: schema.service.projectId,
            })
            .from(schema.domain)
            .innerJoin(schema.service, eq(schema.domain.serviceId, schema.service.id))
            .where(
              inArray(
                schema.domain.tunnelId,
                rows.map((r) => r.tunnel.id),
              ),
            )
        : [];
      const { getSettings } = await import("@/server/settings");
      const settings = await getSettings();
      return {
        tunnels: rows.map(({ tunnel: t, serverName }) => {
          const domains = routed.filter((d) => d.tunnelId === t.id);
          const visible = domains.filter((d) => auth.canAccessProject(d.projectId));
          return {
            id: t.id,
            accountId: t.cloudflareAccountId,
            serverId: t.serverId,
            serverName,
            name: t.name,
            cfTunnelId: t.cfTunnelId,
            status: t.status,
            statusMessage: t.statusMessage,
            /** The dashboard's own address runs through this tunnel. */
            dashboard: settings.dashboardTunnelId === t.id ? (settings.dashboardDomain ?? null) : null,
            domains: visible.map((d) => ({ hostname: d.hostname, serviceId: d.serviceId, serviceName: d.serviceName })).sort((a, b) => a.hostname.localeCompare(b.hostname)),
            /** Domains of projects this token cannot see. */
            otherDomains: domains.length - visible.length,
            createdAt: iso(t.createdAt),
            updatedAt: iso(t.updatedAt),
          };
        }),
      };
    },
  }),
  route({
    method: "POST",
    path: "/cloudflare/accounts/{accountId}/tunnels",
    tag: "Integrations",
    summary: "Create a tunnel from a server",
    description:
      "Runs a connector on the server; domains of that server can then route through Cloudflare without open ports. Domains that used a tunnel on the server before come back (reconnected, failed).",
    needs: ["integrations.manage"],
    body: z.object({ serverId: z.string().min(1) }),
    status: 201,
    handler: async ({ auth, params, body }) => {
      await orgAccount(auth.organizationId, params.accountId);
      return unwrap(integrations.enableTunnel(params.accountId, body.serverId));
    },
  }),
  route({
    method: "DELETE",
    path: "/cloudflare/accounts/{accountId}/tunnels/{tunnelId}",
    tag: "Integrations",
    summary: "Remove a tunnel",
    description: "Its domains stop working until a tunnel runs on the server again (they reconnect by themselves then).",
    needs: ["integrations.manage"],
    handler: async ({ auth, params }) => {
      await orgAccount(auth.organizationId, params.accountId);
      const [tunnel] = await db
        .select({ id: schema.cloudflareTunnel.id })
        .from(schema.cloudflareTunnel)
        .where(
          and(
            eq(schema.cloudflareTunnel.id, params.tunnelId),
            eq(schema.cloudflareTunnel.cloudflareAccountId, params.accountId),
            eq(schema.cloudflareTunnel.organizationId, auth.organizationId),
          ),
        );
      if (!tunnel) throw new ApiError(404, "Tunnel not found");
      return (await unwrap(integrations.disableTunnel(tunnel.id))) ?? { ok: true };
    },
  }),

  // Private networks
  route({
    method: "GET",
    path: "/private-networks",
    tag: "Servers",
    summary: "List private networks",
    description:
      "Networks between servers (WireGuard), with their servers, and the servers that can be put in them. In the Root organization every network; elsewhere the organization's own. A server is joined once it joined the private network from its own page.",
    needs: ["admin"],
    handler: async () => {
      const { networks, servers, isShared } = await visibleMesh();
      const { meshServerAddress } = await import("@/lib/mesh");
      const { meshJoined } = await import("@/server/mesh/visible");
      return {
        networks: networks.map((n) => ({ id: n.id, name: n.name, organizationId: n.organizationId, servers: n.servers })),
        servers: servers.map((s) => ({
          id: s.id,
          name: s.name,
          joined: meshJoined(s),
          state: s.mesh?.enabled ? s.mesh.state : null,
          message: s.mesh?.enabled ? (s.mesh.message ?? null) : null,
          address: meshJoined(s) ? meshServerAddress(s.meshIndex!) : null,
          shared: isShared(s),
        })),
      };
    },
  }),
  route({
    method: "POST",
    path: "/private-networks",
    tag: "Servers",
    summary: "Create a private network",
    description: "serverIds: servers to put in it (they must have joined the private network).",
    needs: ["admin"],
    body: z.object({ name: z.string(), serverIds: z.array(z.string()).optional() }),
    status: 201,
    handler: async ({ body }) => {
      if (body.serverIds?.length) {
        const { servers } = await visibleMesh();
        const { meshJoined } = await import("@/server/mesh/visible");
        for (const id of body.serverIds) {
          const s = servers.find((x) => x.id === id);
          if (!s) throw new ApiError(404, "Server not found");
          if (!meshJoined(s)) throw new ApiError(409, `${s.name} has not joined the private network yet. Join it from the server's Private network page first.`);
        }
      }
      return unwrap(mesh.createNetwork(body.name, body.serverIds ?? []));
    },
  }),
  route({
    method: "PATCH",
    path: "/private-networks/{networkId}",
    tag: "Servers",
    summary: "Rename a private network",
    needs: ["admin"],
    body: z.object({ name: z.string() }),
    handler: async ({ params, body }) => {
      await visibleNetwork(params.networkId);
      return (await unwrap(mesh.renameNetwork(params.networkId, body.name))) ?? { ok: true };
    },
  }),
  route({
    method: "DELETE",
    path: "/private-networks/{networkId}",
    tag: "Servers",
    summary: "Delete a private network",
    description: "Its servers stop reaching each other unless they share another network.",
    needs: ["admin"],
    handler: async ({ params }) => {
      await visibleNetwork(params.networkId);
      return (await unwrap(mesh.deleteNetwork(params.networkId))) ?? { ok: true };
    },
  }),
  route({
    method: "PUT",
    path: "/private-networks/{networkId}/members",
    tag: "Servers",
    summary: "Put a server in a private network, or take it out",
    description: "member: true puts it in (it must have joined the private network), false takes it out.",
    needs: ["admin"],
    body: z.object({ serverId: z.string().min(1), member: z.boolean() }),
    handler: async ({ params, body }) => {
      const { servers } = await visibleNetwork(params.networkId);
      const { meshJoined } = await import("@/server/mesh/visible");
      const server = servers.find((s) => s.id === body.serverId);
      // Taking out a server this organization no longer sees is left to the action's own checks.
      if (body.member) {
        if (!server) throw new ApiError(404, "Server not found");
        if (!meshJoined(server)) throw new ApiError(409, `${server.name} has not joined the private network yet. Join it from the server's Private network page first.`);
      }
      return (await unwrap(mesh.setNetworkMember(params.networkId, body.serverId, body.member))) ?? { ok: true };
    },
  }),
];
