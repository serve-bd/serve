import Link from "next/link";
import { asc, sql } from "drizzle-orm";
import { Plus } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { canAddServers, listedServerIds, serversForOrg } from "@/server/servers/access";
import { serverAllowsOrg } from "@/server/servers/ownership";
import { db, schema } from "@/server/db";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ServerList } from "./server-list";

export const metadata = { title: "Servers" };

export default async function ServersPage() {
  const ctx = await requireOrg();
  const managed = new Set(await listedServerIds(ctx));
  const all = await db
    .select({
      id: schema.server.id,
      name: schema.server.name,
      description: schema.server.description,
      host: schema.server.host,
      tunnel: sql<boolean>`${schema.server.tunnel} is not null`,
      // Reached at this address while it uses a tailnet.
      tailnetAddress: sql<string | null>`case when ${schema.server.tailscale}->>'tailnetId' is not null then ${schema.server.tailscale}->>'address' end`,
      port: schema.server.port,
      username: schema.server.username,
      isLocal: schema.server.isLocal,
      status: schema.server.status,
      statusMessage: schema.server.statusMessage,
      info: schema.server.info,
      publicIp: schema.server.publicIp,
      lastSeenAt: schema.server.lastSeenAt,
      mesh: sql<boolean>`coalesce((${schema.server.mesh}->>'enabled')::boolean, false)`,
      services: sql<number>`(select count(*)::int from service s where s.server_id = "server"."id")`,
      running: sql<number>`(select count(*)::int from service s where s.server_id = "server"."id" and s.status = 'running')`,
      alerts: sql<number>`(select count(*)::int from incident i where i.server_id = "server"."id" and i.resolved_at is null)`,
      owner: sql<string | null>`(select o.name from organization o where o.id = "server"."owner_organization_id")`,
    })
    .from(schema.server)
    .orderBy(sql`${schema.server.isLocal} desc`, asc(schema.server.createdAt));
  // In Root every server; in another organization only the servers available to it.
  const rows = all.filter((r) => managed.has(r.id)).map((r) => ({ ...r, owner: ctx.isInstanceAdmin ? r.owner : null }));
  // Servers shared with this organization that it deploys to but does not manage: shown read-only,
  // with only its own services counted.
  const shared = await db
    .select({
      id: schema.server.id,
      name: schema.server.name,
      description: schema.server.description,
      status: schema.server.status,
      ownerOrganizationId: schema.server.ownerOrganizationId,
      organizationIds: schema.server.organizationIds,
      services: sql<number>`(select count(*)::int from service s join project p on p.id = s.project_id where s.server_id = "server"."id" and p.organization_id = ${ctx.org.id})`,
      running: sql<number>`(select count(*)::int from service s join project p on p.id = s.project_id where s.server_id = "server"."id" and p.organization_id = ${ctx.org.id} and s.status = 'running')`,
    })
    .from(schema.server)
    .orderBy(asc(schema.server.createdAt))
    .then((list) =>
      list
        .filter((r) => !managed.has(r.id) && serverAllowsOrg(r, ctx.org.id))
        .map(({ ownerOrganizationId, organizationIds: _i, ...r }) => ({ ...r, own: ownerOrganizationId === ctx.org.id || (ctx.isRoot && !ownerOrganizationId) })),
    );

  return (
    <>
      <PageHeader
        title="Servers"
        description={
          !canAddServers(ctx) ? (
            <>Servers {ctx.org.name} deploys to. Admins add and manage them.</>
          ) : ctx.isRoot ? (
            <>Machines you deploy to. Add a server over SSH and everything it needs is installed.</>
          ) : (
            <>Servers {ctx.org.name} brings. Only this organization deploys to them, unless a Root admin shares one. Add a server over SSH and everything it needs is installed.</>
          )
        }
        actions={
          canAddServers(ctx) && (
            <Link href="/servers/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
              <Plus /> Add server
            </Link>
          )
        }
      />
      <PageBody>
        <ServerList
          servers={rows.map((r) => ({ ...r, lastSeenAt: r.lastSeenAt?.toISOString() ?? null }))}
          shared={shared}
          canAdd={canAddServers(ctx)}
          defaultServerId={(await serversForOrg(ctx.org.id)).find((s) => s.isDefault)?.id ?? null}
        />
      </PageBody>
    </>
  );
}
