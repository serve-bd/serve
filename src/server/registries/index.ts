import type Docker from "dockerode";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { docker as localDocker, type LogFn, type RegistryAuth } from "@/server/docker/client";
import { authServer, parsePushDigest } from "./refs";

export type RegistryRow = typeof schema.containerRegistry.$inferSelect;

export async function getRegistry(id: string, organizationId?: string | null) {
  const where = organizationId ? and(eq(schema.containerRegistry.id, id), eq(schema.containerRegistry.organizationId, organizationId)) : eq(schema.containerRegistry.id, id);
  const [row] = await db.select().from(schema.containerRegistry).where(where);
  return row ?? null;
}

/** Credentials sent with each push or pull; nothing is stored on the servers. */
export function registryAuth(row: Pick<RegistryRow, "host" | "username" | "password">): RegistryAuth {
  return { username: row.username, password: decrypt(row.password), serveraddress: authServer(row.host) };
}

/** Log in to the registry through a Docker Engine (the local one by default). Throws with the registry's answer. */
export async function checkRegistryLogin(auth: RegistryAuth, d: Docker = localDocker) {
  try {
    await d.checkAuth(auth);
  } catch (error) {
    const e = error as { json?: { message?: string }; message?: string; statusCode?: number };
    const message = e.json?.message ?? e.message ?? String(error);
    throw new Error(`The registry refused the login: ${message.replace(/^\(HTTP code \d+\)\s*[a-z ]*-\s*/i, "")}`);
  }
}

/**
 * Tag a local image as `repo:tag` and push it. Returns the manifest digest the
 * registry reported, so other servers can pull exactly this image.
 */
export async function pushImage(opts: { d: Docker; localRef: string; repo: string; tags: string[]; auth: RegistryAuth; log?: LogFn; signal?: AbortSignal }) {
  const { d, log } = opts;
  let digest: string | null = null;
  for (const tag of opts.tags) {
    await d.getImage(opts.localRef).tag({ repo: opts.repo, tag });
    // Without `tag` the Engine pushes every local tag of the repository.
    const stream = (await d.getImage(opts.repo).push({ tag, authconfig: opts.auth, abortSignal: opts.signal } as never)) as unknown as NodeJS.ReadableStream;
    const pushed = await new Promise<string | null>((resolve, reject) => {
      let found: string | null = null;
      let failed: string | null = null;
      const seen = new Set<string>();
      d.modem.followProgress(
        stream,
        (error) => (error ? reject(error) : failed ? reject(new Error(failed)) : resolve(found)),
        (event: { status?: string; id?: string; error?: string; aux?: { Digest?: string } }) => {
          if (event.error) {
            failed = event.error;
            log?.(event.error);
            return;
          }
          // Older Engines send the digest in `aux`; others only in the final "tag: digest: sha256:… size: N" line.
          if (event.aux?.Digest) found = event.aux.Digest;
          else if (!found && event.status) found = parsePushDigest(event.status);
          if (!event.status || !log || event.status === "Pushing") return;
          const line = event.id ? `${event.id}: ${event.status}` : event.status;
          if (!seen.has(line)) {
            seen.add(line);
            log(line);
          }
        },
      );
    });
    // The first tag decides the digest; later tags (latest) point at the same manifest.
    digest ??= pushed;
    // The registry-named tag is only needed for the push itself.
    await d
      .getImage(`${opts.repo}:${tag}`)
      .remove({ noprune: true })
      .catch(() => {});
  }
  return digest;
}
