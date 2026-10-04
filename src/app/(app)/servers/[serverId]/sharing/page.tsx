import { asc, count, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { AccessCard } from "../server-settings";
import { loadServer } from "../_lib/load";

export const metadata = { title: "Sharing" };

export default async function SharingPage(props: PageProps<"/servers/[serverId]/sharing">) {
  const { serverId } = await props.params;
  const { row, ctx } = await loadServer(serverId);
  if (!ctx.isInstanceAdmin)
    return (
      <p className="px-1 text-[13px] text-muted">This server belongs to {ctx.org.name}. Only this organization deploys to it, unless a Root admin shares it with another one.</p>
    );
  const [orgs, [{ services }]] = await Promise.all([
    db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).orderBy(asc(schema.organization.createdAt)),
    db.select({ services: count() }).from(schema.service).where(eq(schema.service.serverId, serverId)),
  ]);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <AccessCard
        server={{
          id: row.id,
          name: row.name,
          isLocal: row.isLocal,
          organizationIds: row.organizationIds,
          ownerOrganizationId: row.ownerOrganizationId,
          services,
          tunnel: !!row.tunnel,
        }}
        organizations={orgs}
      />
    </div>
  );
}
