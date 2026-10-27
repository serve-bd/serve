import { and, desc, eq, isNotNull } from "drizzle-orm";
import type Docker from "dockerode";
import { db, schema } from "@/server/db";
import type { ImageCheck } from "@/server/db/schema";
import { engineImage, engines } from "@/server/databases/engines";
import { listServiceContainers, type RegistryAuth } from "@/server/docker/client";
import { getRegistry } from "@/server/registries";
import { listTags, splitImage } from "@/server/registries/browse";
import { getServer } from "@/server/servers/context";
import { notify } from "@/server/notifications/deliver";
import { newerVersionTag } from "@/lib/image-versions";

/*
 * Image updates: for the registry images a service runs (a database, an app from an image, the
 * pulled images of a stack), whether the registry has another build of the same tag (security
 * fixes: an update pulls it) and whether a higher version of the same form exists (9-alpine after
 * 8-alpine: only shown, a new version can break things). Images Serve builds are not checked.
 */

type Service = typeof schema.service.$inferSelect;
type Image = { ref: string; composeService: string | null; auth: RegistryAuth | null; versions: string[] | null };

/** A daily look is enough: registries count requests, and builds of a tag come out days apart. */
export const CHECK_EVERY_MS = 24 * 60 * 60_000;

/** The images a service runs from a registry, with the login to read them and, for databases, the versions Serve offers. */
async function imagesOf(service: Service): Promise<Image[]> {
  if (service.type === "database" && service.database) {
    const cfg = service.database;
    // A custom image is checked as written; Serve's own image only suggests the versions it offers.
    return [{ ref: engineImage(cfg.engine, cfg.version, cfg.image), composeService: null, auth: null, versions: cfg.image ? null : engines[cfg.engine].versions }];
  }
  if (service.type === "app" && service.source?.type === "image") {
    const { imagePullAuth } = await import("@/server/deploy/index");
    const source = service.source;
    const ref = source.image.includes(":") || source.image.includes("@") ? source.image : `${source.image}:latest`;
    return [{ ref, composeService: null, auth: await imagePullAuth(source, () => {}), versions: null }];
  }
  if (service.type === "compose") {
    // The images the last deploy pulled (built ones have no digest and are left out).
    const [last] = await db
      .select({ snapshot: schema.deployment.composeSnapshot })
      .from(schema.deployment)
      .where(and(eq(schema.deployment.serviceId, service.id), eq(schema.deployment.status, "success"), isNotNull(schema.deployment.composeSnapshot)))
      .orderBy(desc(schema.deployment.createdAt))
      .limit(1);
    return Object.entries(last?.snapshot?.images ?? {})
      .filter(([, i]) => i.digest)
      .map(([name, i]) => ({ ref: i.ref, composeService: name, auth: null, versions: null }));
  }
  return [];
}

/** Digests of the builds the service's containers run, by stack service (null: the service itself). */
async function runningDigests(service: Service, d: Docker) {
  const out = new Map<string | null, Set<string>>();
  for (const c of await listServiceContainers(service.id, false, d)) {
    const key = service.type === "compose" ? (c.Labels["com.docker.compose.service"] ?? null) : null;
    const image = await d
      .getImage(c.ImageID)
      .inspect()
      .catch(() => null);
    const set = out.get(key) ?? new Set<string>();
    for (const rd of image?.RepoDigests ?? []) set.add(rd.split("@")[1]);
    out.set(key, set);
  }
  return out;
}

/** Look at one service now, save what was found, and notify about findings not notified before. */
export async function checkServiceImages(serviceId: string): Promise<ImageCheck | null> {
  const [service] = await db.select().from(schema.service).where(eq(schema.service.id, serviceId));
  if (!service || service.parentServiceId) return null;
  const images = await imagesOf(service);
  if (!images.length) {
    if (service.imageCheck) await db.update(schema.service).set({ imageCheck: null }).where(eq(schema.service.id, service.id));
    return null;
  }
  const ctx = await getServer(service.serverId);
  const running = await runningDigests(service, ctx.docker);
  const found: ImageCheck["images"] = [];
  for (const image of images) {
    const { tag } = splitImage(image.ref);
    // A pinned digest never changes, and nothing runs yet: nothing to compare.
    const pinned = image.ref.includes("@");
    const runs = running.get(image.composeService) ?? new Set<string>();
    let digest: string | null = null;
    let newerVersion: string | null = null;
    let error: string | null = null;
    if (!pinned && runs.size) {
      try {
        const answer = (await ctx.docker.getImage(image.ref).distribution(image.auth ? { authconfig: image.auth } : {})) as { Descriptor: { digest: string } };
        digest = answer.Descriptor.digest;
      } catch (e) {
        error = `The registry did not answer for ${image.ref}: ${(e as Error).message.split("\n")[0]}`;
      }
    }
    if (!pinned && tag) {
      try {
        const saved = image.auth ? await savedRegistryOf(service) : null;
        const tags = (await listTags(saved, image.ref)).map((t) => t.name);
        newerVersion = newerVersionTag(tag, image.versions ? tags.filter((t) => image.versions!.includes(t)) : tags);
      } catch {
        // Tags are a hint: a registry that does not list them still gets the build check.
      }
    }
    found.push({ ref: image.ref, composeService: image.composeService, newerBuild: !!digest && !runs.has(digest), digest, newerVersion, error });
  }
  const notified = found
    .filter((i) => i.newerBuild || i.newerVersion)
    .map((i) => `${i.ref}|${i.newerBuild ? i.digest : ""}|${i.newerVersion ?? ""}`)
    .join(",");
  const check: ImageCheck = { checkedAt: new Date().toISOString(), images: found, notified: notified || service.imageCheck?.notified };
  await db.update(schema.service).set({ imageCheck: check }).where(eq(schema.service.id, service.id));
  if (notified && notified !== service.imageCheck?.notified) await notifyUpdates(service, found);
  return check;
}

async function savedRegistryOf(service: Service) {
  return service.source?.type === "image" && service.source.registryId ? getRegistry(service.source.registryId) : null;
}

async function notifyUpdates(service: Service, found: ImageCheck["images"]) {
  const [project] = await db.select({ organizationId: schema.project.organizationId }).from(schema.project).where(eq(schema.project.id, service.projectId));
  if (!project) return;
  const lines = found.flatMap((i) => {
    const name = i.composeService ? `${i.composeService} (${i.ref})` : i.ref;
    return [...(i.newerBuild ? [`A newer build of ${name}: Update image pulls it.`] : []), ...(i.newerVersion ? [`Version ${i.newerVersion} of ${name} is out.`] : [])];
  });
  await notify(project.organizationId, "service.image-update", {
    ok: true,
    title: `Image updates for ${service.name}`,
    body: lines.join("\n"),
    url: `/projects/${service.projectId}/services/${service.id}`,
    serviceId: service.id,
  });
}

/** The worker's hourly round: services not looked at for a day, a few at a time. */
export async function checkImageUpdates(limit = 25) {
  const services = await db
    .select({ id: schema.service.id, type: schema.service.type, source: schema.service.source, imageCheck: schema.service.imageCheck, parent: schema.service.parentServiceId })
    .from(schema.service);
  const due = services
    .filter((s) => !s.parent && (s.type !== "app" || s.source?.type === "image"))
    .filter((s) => !s.imageCheck || Date.now() - Date.parse(s.imageCheck.checkedAt) >= CHECK_EVERY_MS)
    .slice(0, limit);
  const failures: string[] = [];
  for (const s of due) {
    try {
      await checkServiceImages(s.id);
    } catch (e) {
      failures.push(`${s.id}: ${(e as Error).message}`);
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
}
