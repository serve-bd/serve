import { z } from "zod";
import type { ApiAuth } from "@/server/api-auth";
import { loadService } from "../data";
import { ApiError, type ApiRoute, type Need, route } from "../router";

/*
 * Files on a server or in a service's container (serve upload, serve download), with the same
 * checks as the dashboard's Files pages and the terminal: a server's files for admins who manage
 * it, a service's files with the Console permission (host-level access: Root admins only).
 * Uploads and downloads are streamed, so files of any size go through.
 */

const pathQuery = { path: z.string().min(1).max(4096).default("/") };
const pick = {
  container: z.string().max(200).optional(),
  replica: z.coerce.number().int().min(1).optional(),
};

const yesNo = z.enum(["0", "1", "true", "false"]).optional();

const changeBody = z.discriminatedUnion("op", [
  z.object({ op: z.literal("mkdir"), path: z.string().max(4096) }),
  z.object({ op: z.literal("move"), from: z.string().max(4096), to: z.string().max(4096) }),
  z.object({ op: z.literal("delete"), path: z.string().max(4096) }),
]);

async function guard<T>(run: () => Promise<T>): Promise<T> {
  const { FilesError, filesStatus } = await import("@/server/files");
  try {
    return await run();
  } catch (e) {
    if (e instanceof FilesError) throw new ApiError(filesStatus(e.code), e.message);
    if (e instanceof ApiError) throw e;
    throw new ApiError(502, `Could not reach the files: ${(e as Error).message}`);
  }
}

type Target = Awaited<ReturnType<typeof import("@/server/files/target").serverTarget>>;

/** The routes of one kind of place: a server, or a service. */
function filesRoutes(
  base: string,
  what: string,
  needs: Need[],
  target: (auth: ApiAuth, params: Record<string, string>, query: { container?: string; replica?: number }) => Promise<Target>,
  withPick: boolean,
): ApiRoute[] {
  // Typed as the service form: a server's routes simply never get these.
  const q = (withPick ? pick : {}) as typeof pick;
  const which = withPick ? " ?container= picks the container (a compose service, container name or id) and ?replica= the replica; the first running one otherwise." : "";
  return [
    route({
      method: "GET",
      path: `${base}/files`,
      tag: "Files",
      summary: `List a folder ${what}`,
      description: `The entries of the folder at ?path= (absolute; default /): name, type (dir, file, link, other), size, mtime (ms), mode, owner, group, and where a link points.${which}`,
      needs,
      query: z.object({ ...pathQuery, ...q }),
      handler: async ({ auth, params, query }) =>
        guard(async () => {
          const { listWithMounts } = await import("@/server/files/http");
          return listWithMounts(await target(auth, params, query), query.path);
        }),
    }),
    route({
      method: "GET",
      path: `${base}/files/content`,
      tag: "Files",
      summary: `Download a file or folder ${what}`,
      description: `The file at ?path=, or a folder as a .tar.gz, streamed. Content-Disposition carries its name.${which}`,
      needs,
      produces: "application/octet-stream",
      query: z.object({ path: z.string().min(1).max(4096), ...q }),
      handler: async ({ auth, params, query, request }) =>
        guard(async () => {
          const { downloadResponse } = await import("@/server/files/http");
          return downloadResponse(await target(auth, params, query), query.path, request.signal);
        }),
    }),
    route({
      method: "PUT",
      path: `${base}/files/content`,
      tag: "Files",
      summary: `Upload a file ${what}`,
      description: `The request body becomes the file at ?path= (absolute, in an existing folder), streamed to it. An existing file is kept unless ?replace=1; then it is replaced, keeping its owner and mode. A new file gets the folder's owner. With ?extract=1 the body is a .tar.gz unpacked into the existing folder at ?path= (one request for a whole folder): an entry that exists already stops it before anything is written, unless ?replace=1 merges it in (files overwritten, the others kept).${which}`,
      needs,
      query: z.object({ path: z.string().min(1).max(4096), replace: yesNo, extract: yesNo, ...q }),
      handler: async ({ auth, params, query, request }) =>
        guard(async () => {
          const { uploadRequest } = await import("@/server/files/http");
          const yes = (v?: string) => v === "1" || v === "true";
          return uploadRequest(await target(auth, params, query), query.path, request, { replace: yes(query.replace), unpack: yes(query.extract) });
        }),
    }),
    route({
      method: "POST",
      path: `${base}/files`,
      tag: "Files",
      summary: `Create a folder, move or delete ${what}`,
      description: `{op:"mkdir", path}, {op:"move", from, to} (rename: the same folder, a new name) or {op:"delete", path} (a folder with everything in it).${which}`,
      needs,
      query: z.object({ ...q }),
      body: changeBody,
      handler: async ({ auth, params, query, body }) =>
        guard(async () => {
          const { changeFiles } = await import("@/server/files/http");
          return changeFiles(await target(auth, params, query), body);
        }),
    }),
  ];
}

async function org() {
  const { requireOrg } = await import("@/server/auth");
  return requireOrg();
}

export const fileRoutes: ApiRoute[] = [
  ...filesRoutes(
    "/servers/{serverId}",
    "on a server",
    ["admin", "console.access"],
    async (_auth, params) => {
      const { serverTarget } = await import("@/server/files/target");
      return serverTarget(await org(), params.serverId);
    },
    false,
  ),
  ...filesRoutes(
    "/services/{serviceId}",
    "in a service",
    ["console.access"],
    async (auth, params, query) => {
      const { service } = await loadService(auth, params.serviceId);
      const { serviceTarget } = await import("@/server/files/target");
      return serviceTarget(await org(), service, { target: query.container ?? null, replica: query.replica ?? null });
    },
    true,
  ),
];
