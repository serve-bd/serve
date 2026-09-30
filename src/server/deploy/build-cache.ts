import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/server/env";
import { scopeCacheMounts } from "@/server/security";
import { replaceFile } from "./files";

/** Cache mount prefix of an organization. Keyed with the instance secret, so no one can aim at another organization's caches. */
export function buildCacheScope(organizationId: string | null) {
  return `serve-${crypto
    .createHmac("sha256", env.encryptionKey)
    .update(`build-cache:${organizationId ?? "-"}`)
    .digest("hex")
    .slice(0, 20)}`;
}

/**
 * Rewrites the cache mounts of Dockerfiles inside `root` in place. Missing files are skipped. The
 * repository may be mounted into running containers: a Dockerfile that is a link to a file
 * outside it is refused, and the new content replaces the file instead of writing through it.
 */
export async function scopeDockerfiles(files: string[], scope: string, root: string) {
  const realRoot = await fs.realpath(root);
  for (const file of files) {
    const real = await fs.realpath(file).catch(() => null);
    if (!real) continue;
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error(`The Dockerfile ${path.relative(root, file)} leads outside the repository.`);
    const text = await fs.readFile(real, "utf8").catch(() => null);
    if (text?.includes("type=cache")) await replaceFile(real, scopeCacheMounts(text, scope));
  }
}
