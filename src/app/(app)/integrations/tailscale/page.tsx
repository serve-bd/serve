import { asc, eq } from "drizzle-orm";
import { LockKeyhole } from "lucide-react";
import { requireOrg } from "@/server/auth";
import { db, schema } from "@/server/db";
import { serversByTailnet, syncTailscale } from "@/server/tailscale";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { Card, EmptyState } from "@/components/ui/misc";
import { Tailnets, type TailnetItem } from "./tailnets";

export const metadata = { title: "Tailscale" };

export default async function TailscalePage() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) {
    return (
      <>
        <PageHeader title="Tailscale" />
        <PageBody>
          <Card>
            <EmptyState
              icon={<LockKeyhole />}
              title="Only Root admins manage Tailscale"
              description="Servers join the instance's tailnet, so its connection belongs to the Root organization."
            />
          </Card>
        </PageBody>
      </>
    );
  }
  // Opening the page shows the tailnet as it is now, not as of the worker's last check (a check per visit, not more than one every 10 seconds).
  const stale = await db.select({ checkedAt: schema.tailscaleTailnet.checkedAt }).from(schema.tailscaleTailnet);
  if (stale.some((t) => !t.checkedAt || Date.now() - t.checkedAt.getTime() > 10_000)) await syncTailscale().catch(() => {});
  const [rows, byTailnet, [local]] = await Promise.all([
    db.select().from(schema.tailscaleTailnet).orderBy(asc(schema.tailscaleTailnet.createdAt)),
    serversByTailnet(),
    db.select({ id: schema.server.id, name: schema.server.name, tailscale: schema.server.tailscale }).from(schema.server).where(eq(schema.server.isLocal, true)),
  ]);
  const tailnets: TailnetItem[] = rows.map((t) => ({
    id: t.id,
    name: t.name,
    tailnet: t.tailnet,
    authType: t.authType,
    clientId: t.clientId,
    tag: t.tag,
    dnsSuffix: t.dnsSuffix,
    error: t.error,
    checkedAt: t.checkedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    servers: (byTailnet.get(t.id) ?? [])
      .filter((s) => !s.isLocal)
      .map((s) => ({
        id: s.id,
        name: s.name,
        address: s.tailscale?.address ?? null,
        online: s.tailscale?.online ?? null,
        // Removing the tailnet: one with a public address or a tunnel goes back to it; the others become unreachable.
        fallback: !s.tailscale?.only,
      })),
  }));
  const localTs = local?.tailscale;
  return (
    <Tailnets
      tailnets={tailnets}
      local={
        local
          ? {
              id: local.id,
              name: local.name,
              tailnetId: localTs?.tailnetId ?? null,
              address: localTs?.address ?? null,
              dnsName: localTs?.dnsName ?? null,
              error: localTs?.error ?? null,
            }
          : null
      }
      root={ctx.isRoot}
    />
  );
}
