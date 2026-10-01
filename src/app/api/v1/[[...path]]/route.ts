import { handleApi } from "@/server/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path?: string[] }> };

const handle = async (request: Request, ctx: Ctx) => handleApi(request, ((await ctx.params).path ?? []).join("/"));

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
