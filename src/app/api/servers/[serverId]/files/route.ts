import { requireOrg } from "@/server/auth";
import { env } from "@/server/env";
import { crossSiteRequest } from "@/lib/same-origin";
import { filesErrorResponse, handleFiles } from "@/server/files/http";
import { serverTarget } from "@/server/files/target";

export const dynamic = "force-dynamic";

/** A server's files (see src/server/files/http.ts): for admins who manage the server, like its terminal. */
async function handle(request: Request, ctx: RouteContext<"/api/servers/[serverId]/files">) {
  // Outside the proxy matcher (uploads would be buffered), so its cross-site check is done here.
  if (crossSiteRequest(request, env.appUrl)) return Response.json({ error: "Cross-site request refused." }, { status: 403 });
  const { serverId } = await ctx.params;
  const org = await requireOrg();
  try {
    return await handleFiles(request, await serverTarget(org, serverId));
  } catch (e) {
    return filesErrorResponse(e);
  }
}

export { handle as GET, handle as PUT, handle as POST };
