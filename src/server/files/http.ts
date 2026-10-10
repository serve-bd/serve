import { Readable } from "node:stream";
import { z } from "zod";
import { readJsonLimited } from "@/server/http-body";
import { cleanPath, download, EDIT_MAX, extract, FilesError, filesStatus, listDir, makeDir, move, readText, remove, upload, writeText } from "./index";
import type { FilesTarget } from "./target";

/*
 * The dashboard's file manager requests, for a server or a service (the routes check who asks):
 *   GET  ?op=list&path=          the folder's entries (and a container's mounts)
 *   GET  ?op=read&path=          a text file for the editor, with its hash
 *   GET  ?op=download&path=      a file, or a folder as .tar.gz (&name=a&name=b: those entries of it)
 *   PUT  ?path=&replace=1        the body becomes the file (streamed, never held in memory);
 *        &extract=1              or a .tar.gz unpacked into the folder at path
 *   POST {op: "save" | "mkdir" | "move" | "delete", ...}
 */

const json = (data: unknown, status = 200) => Response.json(data, { status });

export function filesErrorResponse(e: unknown) {
  if (e instanceof FilesError) return json({ error: e.message }, filesStatus(e.code));
  const message = (e as Error)?.message ?? String(e);
  return json({ error: `Could not reach the files: ${message}` }, 502);
}

/** Content-Disposition for any file name (non-ASCII names in filename*). */
export function attachment(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function downloadResponse(target: FilesTarget, path: string, signal: AbortSignal, names: string[] = []) {
  const d = await download(target.place, path, signal, names);
  await target.log(names.length ? `Downloaded ${names.length} items of ${d.path} ${target.where}` : `Downloaded ${d.path} ${target.where}`);
  return new Response(Readable.toWeb(d.stream) as ReadableStream, {
    headers: {
      "content-type": d.type === "dir" ? "application/gzip" : "application/octet-stream",
      "content-disposition": attachment(d.filename),
      // Files of /proc and /sys say 0 bytes and still have content: no length for those.
      ...(d.type === "file" && d.size > 0 ? { "content-length": String(d.size) } : {}),
      "cache-control": "no-store",
    },
  });
}

/** The body becomes the file at `path`; with `unpack`, the body is a .tar.gz unpacked into the folder at `path`. */
export async function uploadRequest(target: FilesTarget, path: string, request: Request, opts: { replace: boolean; unpack?: boolean }) {
  if (!request.body) throw new FilesError(5, "Send the file as the request body.");
  const clean = cleanPath(path);
  const body = Readable.fromWeb(request.body as import("node:stream/web").ReadableStream);
  const mode = opts.replace ? "replace" : "new";
  if (opts.unpack) await extract(target.place, clean, body, mode, request.signal);
  else await upload(target.place, clean, body, mode, request.signal);
  await target.log(opts.unpack ? `Uploaded a folder into ${clean} ${target.where}` : `Uploaded ${clean} ${target.where}`);
  return { path: clean };
}

const action = z.discriminatedUnion("op", [
  z.object({ op: z.literal("save"), path: z.string(), content: z.string().max(EDIT_MAX), hash: z.string().nullable() }),
  z.object({ op: z.literal("mkdir"), path: z.string() }),
  z.object({ op: z.literal("move"), from: z.string(), to: z.string() }),
  z.object({ op: z.literal("delete"), path: z.string() }),
]);

export async function changeFiles(target: FilesTarget, body: z.output<typeof action>) {
  switch (body.op) {
    case "save": {
      const r = await writeText(target.place, body.path, body.content, body.hash);
      await target.log(`${body.hash ? "Edited" : "Created"} ${body.path} ${target.where}`);
      return r;
    }
    case "mkdir": {
      const path = await makeDir(target.place, body.path);
      await target.log(`Created the folder ${path} ${target.where}`);
      return { path };
    }
    case "move": {
      const path = await move(target.place, body.from, body.to);
      await target.log(`Moved ${body.from} to ${path} ${target.where}`);
      return { path };
    }
    case "delete":
      await remove(target.place, body.path);
      await target.log(`Deleted ${body.path} ${target.where}`);
      return { ok: true };
  }
}

export async function listWithMounts(target: FilesTarget, path: string) {
  const [listing, mounts] = await Promise.all([listDir(target.place, path), target.mounts().catch(() => [])]);
  return { ...listing, mounts };
}

/** The dashboard route's handler, once the route has found the target. */
export async function handleFiles(request: Request, target: FilesTarget): Promise<Response> {
  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "/";
  try {
    if (request.method === "GET") {
      const op = url.searchParams.get("op");
      if (op === "list") return json(await listWithMounts(target, path));
      if (op === "read") return json(await readText(target.place, path));
      if (op === "download") return await downloadResponse(target, path, request.signal, url.searchParams.getAll("name"));
      return json({ error: "Unknown operation" }, 400);
    }
    if (request.method === "PUT")
      return json(await uploadRequest(target, path, request, { replace: url.searchParams.get("replace") === "1", unpack: url.searchParams.get("extract") === "1" }));
    if (request.method === "POST") {
      const parsed = action.safeParse(await readJsonLimited(request, EDIT_MAX * 4, null));
      if (!parsed.success) return json({ error: "Invalid request" }, 400);
      return json(await changeFiles(target, parsed.data));
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return filesErrorResponse(e);
  }
}

export { action as filesAction };
