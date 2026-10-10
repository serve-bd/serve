import { requireOrg } from "@/server/auth";
import { env } from "@/server/env";
import { crossSiteRequest } from "@/lib/same-origin";
import { filesErrorResponse, handleFiles } from "@/server/files/http";
import { serviceTarget } from "@/server/files/target";
import { serviceInOrg } from "@/server/services/access";
import { cannotMessage } from "@/lib/permissions";

export const dynamic = "force-dynamic";

/**
 * A service's files (see src/server/files/http.ts), read from one of its running containers:
 * ?container= picks it (a key from GET /api/services/{id}/exec, as the console), the first one otherwise.
 */
async function handle(request: Request, ctx: RouteContext<"/api/services/[serviceId]/files">) {
  // Outside the proxy matcher (uploads would be buffered), so its cross-site check is done here.
  if (crossSiteRequest(request, env.appUrl)) return Response.json({ error: "Cross-site request refused." }, { status: 403 });
  const { serviceId } = await ctx.params;
  const org = await requireOrg();
  if (!org.can("console.access")) return Response.json({ error: cannotMessage("console.access") }, { status: 403 });
  let service;
  try {
    ({ service } = await serviceInOrg(serviceId, org.org.id));
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const url = new URL(request.url);
  try {
    return await handleFiles(request, await serviceTarget(org, service, { target: url.searchParams.get("container") }));
  } catch (e) {
    return filesErrorResponse(e);
  }
}

export { handle as GET, handle as PUT, handle as POST };
