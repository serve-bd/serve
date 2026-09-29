import path from "node:path";
import type { ServerCtx } from "@/server/servers/context";
import type { VolumeMount } from "./types";

/** File name used on the server for a file mount's content. */
export function fileMountName(source: string) {
  return source.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "file";
}

/** Host path of a file mount's content on the server. */
export function fileMountHostPath(serviceDir: string, source: string) {
  return path.posix.join(serviceDir, "files", fileMountName(source));
}

/**
 * Writes file mounts and creates missing host directories on the service's server,
 * right before its containers start.
 */
export async function prepareMounts(ctx: ServerCtx, serviceId: string, volumes: VolumeMount[], log?: (line: string) => void) {
  const dir = ctx.paths.service(serviceId);
  for (const v of volumes) {
    if (v.kind === "file") {
      const changed = await ctx.fs.writeIfChanged(fileMountHostPath(dir, v.source), v.content ?? "");
      if (changed) log?.(`Wrote ${v.mountPath}`);
    } else if (v.kind === "bind" && v.create && v.hostType !== "file") {
      if (!(await ctx.fs.exists(v.source))) {
        await ctx.fs.mkdir(v.source);
        log?.(`Created ${v.source}`);
      }
    }
  }
}
