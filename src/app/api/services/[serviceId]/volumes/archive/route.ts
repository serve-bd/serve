import { requirePermission } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { serverOf } from "@/server/servers/context";
import { listServiceContainers } from "@/server/docker/client";
import { Readable } from "node:stream";

export const dynamic = "force-dynamic";

/**
 * Downloads the contents of a mounted path as a tar archive, read from the running
 * container (works for local and remote servers). ?path=/var/lib/postgresql/data
 */
export async function GET(request: Request, ctx: RouteContext<"/api/services/[serviceId]/volumes/archive">) {
  const { serviceId } = await ctx.params;
  let org;
  try {
    org = await requirePermission("services.manage");
    if (!org.can("variables.view-secrets")) throw new Error("secrets");
  } catch {
    return new Response("Your role cannot download volume data.", { status: 403 });
  }
  let service;
  try {
    ({ service } = await serviceInOrg(serviceId, org.org.id));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const mountPath = new URL(request.url).searchParams.get("path") ?? "";
  if (!/^\/[^\0]*$/.test(mountPath)) return new Response("Choose a mount path.", { status: 400 });
  const server = await serverOf(service);
  // Compose stacks: ?container=<compose service> picks which service's container to read from.
  const composeName = new URL(request.url).searchParams.get("container");
  const [container] = (await listServiceContainers(service.id, false, server.docker)).filter(
    (c) => c.State === "running" && (!composeName || c.Labels["com.docker.compose.service"] === composeName),
  );
  if (!container) return new Response("Start the service first: the archive is read from its running container.", { status: 409 });
  try {
    const stream = (await server.docker.getContainer(container.Id).getArchive({ path: mountPath })) as unknown as NodeJS.ReadableStream;
    const name = `${service.slug}${mountPath.replace(/[^\w.-]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.tar`;
    return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
      headers: { "content-type": "application/x-tar", "content-disposition": `attachment; filename="${name}"` },
    });
  } catch (e) {
    return new Response(`Could not read ${mountPath}: ${(e as Error).message}`, { status: 404 });
  }
}
