import { requireOrg } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { serverOf } from "@/server/servers/context";
import { databaseCa } from "@/server/databases/tls";

export const dynamic = "force-dynamic";

/** The CA certificate clients use to verify this database's TLS certificate. */
export async function GET(_req: Request, ctx: RouteContext<"/api/services/[serviceId]/database/ca">) {
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  let service;
  try {
    ({ service } = await serviceInOrg(serviceId, org.org.id));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const ca = await databaseCa(await serverOf(service), service.id).catch(() => null);
  if (!ca) return new Response("TLS has not been set up for this database yet. Turn it on and apply.", { status: 404 });
  return new Response(ca, {
    headers: { "content-type": "application/x-pem-file", "content-disposition": `attachment; filename="${service.slug}-ca.crt"` },
  });
}
