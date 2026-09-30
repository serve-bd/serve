import crypto from "node:crypto";
import fs from "node:fs/promises";
import { env } from "@/server/env";
import { scopeCacheMounts } from "@/server/security";

/** Cache mount prefix of an organization. Keyed with the instance secret, so no one can aim at another organization's caches. */
export function buildCacheScope(organizationId: string | null) {
  return `serve-${crypto
    .createHmac("sha256", env.encryptionKey)
    .update(`build-cache:${organizationId ?? "-"}`)
    .digest("hex")
    .slice(0, 20)}`;
}

/** Rewrites the cache mounts of Dockerfiles in place (fresh clones only). Missing files are skipped. */
export async function scopeDockerfiles(files: string[], scope: string) {
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text?.includes("type=cache")) await fs.writeFile(file, scopeCacheMounts(text, scope));
  }
}
