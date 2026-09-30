import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, sql } from "drizzle-orm";
import { Plus } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { canAddServers, managedServerIds } from "@/server/servers/access";
import { db, schema } from "@/server/db";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ServerList } from "./server-list";
import { ProductName } from "@/components/brand";

export const metadata = { title: "Servers" };

export default async function ServersPage() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin && !ctx.isAdmin) redirect("/");
  const managed = new Set(await managedServerIds(ctx));
  const all = await db
    .select({
      id: schema.server.id,
      name: schema.server.name,
      description: schema.server.description,
      host: schema.server.host,
      tunnel: sql<boolean>`${schema.server.tunnel} is not null`,
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
  // Root admins see every server; an organization's admins see the servers it brought.
  const rows = all.filter((r) => managed.has(r.id)).map((r) => ({ ...r, owner: ctx.isInstanceAdmin ? r.owner : null }));

  return (
    <>
      <PageHeader
        title="Servers"
        description={
          ctx.isRoot ? (
            <>
              Machines <ProductName /> deploys to. Add a server over SSH and <ProductName /> installs what it needs.
            </>
          ) : (
            <>
              Servers {ctx.org.name} brings. Only this organization deploys to them, unless a Root admin shares one. Add a server over SSH and <ProductName /> installs what it
              needs.
            </>
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
        <ServerList servers={rows.map((r) => ({ ...r, lastSeenAt: r.lastSeenAt?.toISOString() ?? null }))} />
      </PageBody>
    </>
  );
}
