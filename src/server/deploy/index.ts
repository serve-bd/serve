import { replicasSupported } from "@/server/services/types";
import { configFingerprint } from "@/server/services/fingerprint";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gt, isNotNull, ne, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull, hmac } from "@/server/crypto";
import { currentVersion } from "@/server/instance/version";
import type Docker from "dockerode";
import { type BuildConfig, buildsImage, defaultBuild, type ImageSource, type PortMapping, type VolumeMount } from "@/server/services/types";
import { ensureNetwork, imageExists, imageExistsFor, LABEL, listServiceContainers, pullImage, removeContainer } from "@/server/docker/client";
import { forgetServer, getServer, serverOf, type ServerCtx } from "@/server/servers/context";
import { paths } from "@/server/paths";
import { claimBuildSlot } from "@/server/limits";
import { JobTimeout } from "@/lib/job-timeouts";
import { syncServiceProxy } from "@/server/proxy/nginx";
import { resolveEnv } from "@/server/services/variables";
import { composeVariables } from "@/lib/compose-vars";
import { networkAliases } from "@/lib/hostname";
import { repoUrlWithoutLogin } from "@/lib/repo-url";
import { parseCompose } from "@/server/deploy/compose";
import { engines } from "@/server/databases/engines";
import { logActivity } from "@/server/activity";
import { notify, orgOfService } from "@/server/notify";
import { buildImage } from "./builders";
import { cloneRepository, staleEntries } from "./git";
import { extractArchive } from "./upload-archive";
import { hasRoom, KEEP_UPLOADS, uploadExists, uploadPath } from "./uploads";
import { NO_UPLOAD } from "@/server/services/create";
import { formatBytes } from "@/lib/utils";
import { DeployLogger, type StepLog } from "./logger";
import { distributionProblem, normalizeDistribution, type Distribution } from "./distribution";
import { getRegistry, pushImage, registryAuth, type RegistryRow } from "@/server/registries";
import { defaultRepository, imageRef, normalizeRepository, renderTag } from "@/server/registries/refs";
import { replicaCount, replicaEnv, shortReplicaPicks } from "@/lib/refs";
import type { DeploymentTarget } from "@/server/services/types";
import { type Handoff, restartPolicyOf, restoreOld, retireOld } from "@/server/adopt/handoff";
import { copyDatabaseInto, copyVolumesInto } from "@/server/adopt/copy";
import { createSpec, dockerRestartPolicy, gpuError, startContainer, volumeName, waitHealthy } from "./containers";
import { serverPlatform } from "./options";
import { type BuildNetwork, networkHosts } from "./build-network";
import { prepareMounts } from "@/server/services/mounts";
import { adoptAnonymousVolumes, imageVolumePaths, statefulMounts, uncoveredPaths, volumesFor } from "./image-volumes";
import { databasePlan } from "@/server/databases/options";
import { ensureDatabaseTls } from "@/server/databases/tls";
import { allocateSubnet, composeServiceNames, composeUp, stackNetworkName, transformCompose, writeComposeFiles } from "./compose";
import type { ServiceStatus } from "@/server/db/schema";
import { composeDockerfiles, composeLocalPaths, composeNameClashes, composeSecurityIssues, containedPath, pathsOutside, scopeCacheMounts } from "@/server/security";
import { buildCacheScope, scopeDockerfiles } from "./build-cache";
import { connectProxy, disconnectProxy, ensureEnvNetwork } from "@/server/docker/networks";
import { getSetting } from "@/server/settings";
import { meshAfterStart, meshBeforeStart } from "@/server/mesh";

type Service = typeof schema.service.$inferSelect;
type Deployment = typeof schema.deployment.$inferSelect;

export class DeployCancelled extends Error {}

const imageRepo = (slug: string) => `serve/${slug}`;

async function setDeployment(id: string, patch: Partial<Deployment>) {
  await db.update(schema.deployment).set(patch).where(eq(schema.deployment.id, id));
}

export async function setServiceStatus(id: string, status: ServiceStatus) {
  await db.update(schema.service).set({ status }).where(eq(schema.service.id, id));
}

/**
 * After the worker restarted in the middle of an app deployment: a deployment that had stopped the
 * previous version first (host ports, recreate, data two copies must not share) gets it back.
 * Containers the cut-off deployment started go, and the previous containers that stopped while it
 * ran start again. A deployment that had already switched traffic keeps its new containers.
 * Returns whether the service has running containers afterwards.
 */
export async function recoverInterruptedDeployment(dep: { id: string; serviceId: string; startedAt: Date | null }, d: Docker) {
  const [service] = await db
    .select({ currentDeploymentId: schema.service.currentDeploymentId, type: schema.service.type })
    .from(schema.service)
    .where(eq(schema.service.id, dep.serviceId));
  const containers = await listServiceContainers(dep.serviceId, true, d);
  if (service?.type !== "app" || service.currentDeploymentId === dep.id || !dep.startedAt) return containers.some((c) => c.State === "running");
  const since = dep.startedAt.getTime();
  for (const c of containers.filter((c) => c.Labels[LABEL.deployment] === dep.id)) await removeContainer(c.Id, 0, d);
  for (const c of containers.filter((c) => c.Labels[LABEL.deployment] !== dep.id && c.State === "exited")) {
    const info = await d
      .getContainer(c.Id)
      .inspect()
      .catch(() => null);
    // Stopped by the deployment (or while it ran), not earlier by someone on purpose.
    if (!info || Date.parse(info.State.FinishedAt) < since) continue;
    await d
      .getContainer(c.Id)
      .start()
      .catch(() => {});
  }
  return (await listServiceContainers(dep.serviceId, false, d)).length > 0;
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DeployCancelled("Deployment cancelled");
}

/** Pick the first TCP port an image exposes. */
async function imagePort(image: string, d: Docker): Promise<number | null> {
  try {
    const info = await d.getImage(image).inspect();
    const ports = Object.keys(info.Config.ExposedPorts ?? {})
      .filter((p) => p.endsWith("/tcp"))
      .map((p) => Number(p.split("/")[0]))
      .sort((a, b) => a - b);
    return ports[0] ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                                    Apps                                    */
/* -------------------------------------------------------------------------- */

type PreparedImage = {
  /** Local tag (serve/<slug>:<deployment>) every server runs. */
  image: string;
  detectedPort: number | null;
  /** Pushed reference other servers pull; null when the image never left its server. */
  registryImage: string | null;
  rollback: boolean;
};

/**
 * Produce the image of a deployment: build it (on the build server), pull it
 * (image sources), or reuse an earlier one (rollbacks). Servers other than
 * `server` get it later through `ensureImageOn`.
 */
async function prepareAppImage(
  service: Service,
  dep: Deployment,
  log: DeployLogger,
  server: ServerCtx,
  signal?: AbortSignal,
  buildNetwork?: BuildNetwork | null,
): Promise<PreparedImage> {
  const target = `${imageRepo(service.slug)}:${dep.id}`;
  const d = server.docker;

  if (dep.rollbackOf) {
    const [original] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, dep.rollbackOf));
    if (!original?.image) throw new Error("The image for that deployment was cleaned up and can no longer be restored.");
    log.step(`Rolling back to deployment ${original.id.slice(0, 8)}${original.registryImage ? ` (${original.registryImage})` : ""}`);
    await setDeployment(dep.id, {
      commitSha: original.commitSha,
      commitMessage: original.commitMessage,
      commitAuthor: original.commitAuthor,
      branch: original.branch,
      registryImage: original.registryImage,
    });
    return { image: original.image, detectedPort: null, registryImage: original.registryImage, rollback: true };
  }

  const source = service.source;
  if (!source) throw new Error("This service has no source configured.");
  // Files uploaded from the CLI: built instead of the repository or the saved Dockerfile.
  const upload = dep.upload;
  if (source.type === "upload" && !upload) throw new Error(NO_UPLOAD);

  const platform = service.runtime.platform ?? null;
  const foreign = await foreignPlatform(platform, server, log.line);
  if (source.type === "image") {
    const ref = source.image.includes(":") || source.image.includes("@") ? source.image : `${source.image}:latest`;
    if (service.runtime.pullPolicy === "missing" && (await imageExistsFor(ref, platform, d))) {
      log.step(`Using ${source.image} already on ${server.local ? "the server" : server.name} (pull policy: if missing)`);
    } else {
      log.step(`Pulling ${source.image}${platform ? ` for ${platform}` : ""}`);
      const auth = await imagePullAuth(source, log.line);
      await pullImage(source.image, log.line, auth, d, platform);
    }
    checkCancelled(signal);
    await d.getImage(ref).tag({ repo: imageRepo(service.slug), tag: dep.id });
    if (foreign) await dropForeignTag(ref, d);
    return { image: target, detectedPort: await imagePort(target, d), registryImage: null, rollback: false };
  }

  // Git source: clone and build. Dockerfile source: build the saved Dockerfile in an empty context.
  const env = await resolveEnv(service);
  log.redact(env.secrets);
  stopOnFailedSecrets(env);
  // Said before the build: an empty build variable often breaks it, long before the container starts.
  if (env.missing.length) log.line(`Warning: unresolved variable references (left empty): ${env.missing.join(", ")}`);
  const workDir = path.join(paths.builds, dep.id);
  const saved = service.build ?? defaultBuild();
  const build: BuildConfig = {
    ...saved,
    noCache: saved.noCache || saved.noCacheOnce,
    ...(source.type === "dockerfile" ? { builder: "dockerfile" as const, dockerfile: "Dockerfile", rootDir: "/" } : {}),
  };
  if (service.build?.noCacheOnce) {
    // One-shot "build without cache": consume the flag so later deploys use the cache again.
    await db
      .update(schema.service)
      .set({ build: { ...service.build, noCacheOnce: false } })
      .where(eq(schema.service.id, service.id));
  }
  // A build timeout aborts clone + build like a cancellation.
  const timeoutMinutes = build.buildTimeoutMinutes;
  const buildController = new AbortController();
  const onAbort = () => buildController.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = timeoutMinutes ? setTimeout(() => buildController.abort(new Error(`The build exceeded ${timeoutMinutes} minutes.`)), timeoutMinutes * 60_000) : undefined;
  const buildSignal = buildController.signal;
  // Standard image labels: the repository and commit an image was built from, readable by any tool.
  const origin: Record<string, string> = {};
  let commit: string | null = null;
  try {
    if (upload) {
      log.step("Unpacking the uploaded files");
      if (source.type !== "upload")
        log.line(`A one-off deploy of files uploaded from the CLI, ${source.type === "git" ? "instead of the repository" : "built with the saved Dockerfile"}.`);
      if (build.noCache) log.line("Building without cache");
      if (!(await uploadExists(upload.archive)))
        throw new Error(`The uploaded files were deleted (Serve keeps those of the last ${KEEP_UPLOADS} uploads). Run serve deploy again.`);
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.mkdir(workDir, { recursive: true });
      const unpacked = await extractArchive(uploadPath(upload.archive), workDir, async () => {
        if (!(await hasRoom(workDir, 0))) throw new Error("The server's disk ran out of room while unpacking the upload.");
      });
      log.line(
        `${unpacked.files} ${unpacked.files === 1 ? "file" : "files"}, ${formatBytes(unpacked.bytes)} unpacked${upload.dirty ? ", with changes that were not committed" : ""}`,
      );
      // A Dockerfile source keeps building its saved Dockerfile, now with the uploaded files around it.
      if (source.type === "dockerfile") await fs.writeFile(path.join(workDir, "Dockerfile"), source.content);
      if (dep.commitSha) origin["org.opencontainers.image.revision"] = dep.commitSha;
      if (dep.branch) origin[LABEL.branch] = dep.branch;
      // A clean commit is passed to the build as SOURCE_COMMIT; files with local changes are no commit.
      commit = dep.commitSha && !upload.dirty ? dep.commitSha : null;
    } else if (source.type === "git") {
      log.step("Cloning repository");
      if (build.noCache) log.line("Building without cache");
      const clone = await cloneRepository(source, workDir, log.line, buildSignal, await orgIdOf(service), { submodules: build.submodules });
      await setDeployment(dep.id, {
        commitSha: clone.commitSha,
        commitMessage: clone.commitMessage,
        commitAuthor: clone.commitAuthor,
        branch: source.branch,
      });
      const repo = repoUrlWithoutLogin(source.repository);
      if (repo) origin["org.opencontainers.image.source"] = repo;
      if (clone.commitSha) origin["org.opencontainers.image.revision"] = clone.commitSha;
      origin[LABEL.branch] = source.branch;
      commit = clone.commitSha || null;
      if (commit) {
        const key = buildKey(service, build, env.build, commit, platform);
        origin[LABEL.buildKey] = key;
        // The same commit built the same way before: its image is used again instead of building.
        const reused = build.noCache ? null : await reusableImage(service, key, d);
        if (reused) {
          log.line(`Using the image deployment ${reused.deployment?.slice(0, 8) ?? "before"} built from this commit with the same settings. Deploy without cache to build again.`);
          await d.getImage(reused.tag).tag({ repo: imageRepo(service.slug), tag: dep.id });
          return { image: target, detectedPort: await imagePort(target, d), registryImage: null, rollback: false };
        }
      }
    } else if (source.type === "dockerfile") {
      log.step("Preparing the Dockerfile");
      if (build.noCache) log.line("Building without cache");
      // A fresh directory holding only the Dockerfile: there are no local files to COPY.
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.mkdir(workDir, { recursive: true });
      await fs.writeFile(path.join(workDir, "Dockerfile"), source.content);
    }
    checkCancelled(signal);

    const contextDir = containedPath(workDir, build.rootDir || "/", "Root directory");
    const dockerfilePath = containedPath(contextDir, build.dockerfile || "Dockerfile", "Dockerfile path");
    // The build follows a symlinked root directory or Dockerfile: they must stay inside the repository.
    if ((await pathsOutside(workDir, [contextDir, dockerfilePath])).length) {
      throw new Error("The root directory or Dockerfile path leads outside the repository.");
    }
    await fs.access(contextDir).catch(() => {
      throw new Error(`Root directory "${build.rootDir}" does not exist in the repository.`);
    });

    log.step(server.local ? "Building image" : `Building image on ${server.name}`);
    const started = Date.now();
    const result = await buildImage({
      contextDir,
      image: target,
      build,
      buildEnv: env.build,
      labels: { ...origin, [LABEL.managed]: "true", [LABEL.service]: service.id, [LABEL.deployment]: dep.id },
      log: log.line,
      signal: buildSignal,
      redact: env.secrets,
      dockerEnv: await server.cliEnv(),
      cacheScope: buildCacheScope(await orgIdOf(service)),
      platform,
      network: buildNetwork,
      remote: server.local ? null : { server, buildsDir: server.paths.builds },
      commit,
    });
    log.line(`Build finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return { image: target, detectedPort: result.detectedPort ?? (await imagePort(target, d)), registryImage: null, rollback: false };
  } catch (error) {
    if (buildSignal.aborted && !signal?.aborted && buildSignal.reason instanceof Error) throw buildSignal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * What a build of `commit` depends on besides the commit: the build settings, the build
 * variables, the platform and the Serve version (its generated Dockerfiles change with it). Keyed,
 * since it sits on the image as a label and the variables may hold secrets.
 */
function buildKey(service: Service, build: BuildConfig, buildEnv: Record<string, string>, commit: string, platform: string | null) {
  const source = service.source?.type === "git" ? { repository: service.source.repository, branch: service.source.branch } : null;
  // Settings that do not change the image itself stay out.
  const { noCache: _noCache, noCacheOnce: _once, buildTimeoutMinutes: _timeout, watchPaths: _watch, ...settings } = build;
  const sorted = Object.fromEntries(Object.entries(buildEnv).sort(([a], [b]) => a.localeCompare(b)));
  return hmac(JSON.stringify({ v: 1, serve: currentVersion(), commit, source, settings, env: sorted, platform }));
}

/** The newest image of this service built with the same build key, if one is still on the server. */
async function reusableImage(service: Service, key: string, d: Docker) {
  const images = await d.listImages({ filters: { label: [`${LABEL.service}=${service.id}`, `${LABEL.buildKey}=${key}`] } }).catch(() => []);
  const repo = imageRepo(service.slug);
  const newest = images.sort((a, b) => b.Created - a.Created).find((i) => (i.RepoTags ?? []).some((t) => t.startsWith(`${repo}:`)));
  if (!newest) return null;
  return { tag: newest.RepoTags!.find((t) => t.startsWith(`${repo}:`))!, deployment: newest.Labels?.[LABEL.deployment] ?? null };
}

async function orgIdOf(service: Service) {
  const [row] = await db.select({ organizationId: schema.project.organizationId }).from(schema.project).where(eq(schema.project.id, service.projectId));
  return row?.organizationId ?? null;
}

/**
 * The environment network a build on the service's own server may reach, like the running app
 * does. A build on a separate build server has no such network and builds without it.
 */
async function buildNetworkOf(service: Service, server: ServerCtx, log: DeployLogger): Promise<BuildNetwork | null> {
  if (!buildsImage(service.source?.type) || service.type !== "app") return null;
  try {
    const name = await ensureEnvNetwork(service.environmentId, server);
    return { name, hosts: await networkHosts(server.docker, name) };
  } catch (error) {
    log.line(`Build steps cannot reach this environment's services: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Whether `platform` differs from the server's own, with a warning: images of another platform run
 * under emulation, which is slow and works only where binfmt handlers are installed.
 */
async function foreignPlatform(platform: string | null, server: ServerCtx, log: (line: string) => void) {
  if (!platform) return false;
  const own = serverPlatform((await server.docker.info().catch(() => null))?.Architecture);
  if (!own || own === platform) return false;
  log(`Warning: ${server.name} is ${own} and this service uses ${platform}. It runs under emulation, which is slow and needs QEMU (binfmt) on the server.`);
  return true;
}

/** After a pull for another platform: the shared tag (like alpine:3) must not keep pointing at it for everything else on the server. */
async function dropForeignTag(ref: string, d: Docker) {
  await d
    .getImage(ref)
    .remove({ noprune: true })
    .catch(() => {});
}

/** Login for pulling an image: its saved registry, else the credentials stored with the service. */
async function imagePullAuth(source: ImageSource, log: (line: string) => void) {
  if (source.registryId) {
    const registry = await getRegistry(source.registryId);
    if (registry) return registryAuth(registry);
    log("The registry this image used was removed: pulling without a login.");
    return null;
  }
  const password = decryptOrNull(source.registryPassword);
  return source.registryUsername && password ? { username: source.registryUsername, password, serveraddress: registryOf(source.image) } : null;
}

function registryOf(image: string) {
  const first = image.split("/")[0];
  return first.includes(".") || first.includes(":") ? first : "https://index.docker.io/v1/";
}

/**
 * A server that is still being set up (Install Docker, validation) is waited for instead of
 * failing the deploy: a deploy started right after adding a server just starts a bit later.
 */
async function waitForServerSetup(serverId: string, name: string, log: (line: string) => void) {
  const status = async () => (await db.select({ status: schema.server.status }).from(schema.server).where(eq(schema.server.id, serverId)))[0]?.status;
  let current = await status();
  if (current !== "validating") return current;
  log(`Waiting for ${name} to finish setting up…`);
  const deadline = Date.now() + 15 * 60_000;
  while (current === "validating" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    current = await status();
  }
  forgetServer(serverId);
  return current;
}

/** A server a deployment runs on, checked for reachability first. */
async function connectTo(serverId: string, log: StepLog, role: string) {
  // The status comes from the database: the cached connection keeps the status it was made with.
  const fresh = await waitForServerSetup(serverId, role, (l) => log.line(l));
  const server = await getServer(serverId).catch(() => null);
  if (!server) throw new Error(`The ${role} server no longer exists. Choose another one in Settings → Servers & registry.`);
  if (!server.local) {
    const status = fresh ?? server.row.status;
    if (status === "pending" || status === "validating") throw new Error(`${server.name} is not set up yet. Validate it in Servers first.`);
    try {
      await server.docker.ping();
    } catch (error) {
      throw new Error(`Could not reach ${server.name}: ${(error as Error).message}`);
    }
  }
  await ensureNetwork(server.docker, server.network);
  log.line(`Connected to ${server.name}${server.local ? "" : ` (${server.row.host})`}`);
  return server;
}

/** Make the deployment's image available on a server: already there, pulled from the registry, or pulled from its source. */
async function ensureImageOn(target: ServerCtx, service: Service, prepared: PreparedImage, registry: RegistryRow | null, log: StepLog) {
  const d = target.docker;
  if (await imageExists(prepared.image, d)) return;
  const [repo, tag] = [prepared.image.slice(0, prepared.image.lastIndexOf(":")), prepared.image.slice(prepared.image.lastIndexOf(":") + 1)];
  if (prepared.registryImage) {
    log.line(`Pulling ${prepared.registryImage}`);
    await foreignPlatform(service.runtime.platform ?? null, target, log.line);
    await pullImage(prepared.registryImage, log.line, registry ? registryAuth(registry) : null, d, service.runtime.platform);
    await d.getImage(prepared.registryImage).tag({ repo, tag });
    // Keep only Serve's own tag, so image retention can clean this image up later.
    await d
      .getImage(prepared.registryImage)
      .remove({ noprune: true })
      .catch(() => {});
    return;
  }
  const source = service.source;
  if (!prepared.rollback && source?.type === "image") {
    const ref = source.image.includes(":") || source.image.includes("@") ? source.image : `${source.image}:latest`;
    const platform = service.runtime.platform ?? null;
    const foreign = await foreignPlatform(platform, target, log.line);
    if (service.runtime.pullPolicy === "missing" && (await imageExistsFor(ref, platform, d))) {
      log.line(`Using ${source.image} already on ${target.name}`);
    } else {
      log.line(`Pulling ${source.image}`);
      const auth = await imagePullAuth(source, log.line);
      await pullImage(source.image, log.line, auth, d, platform);
    }
    await d.getImage(ref).tag({ repo, tag });
    if (foreign) await dropForeignTag(ref, d);
    return;
  }
  throw new Error(
    prepared.rollback
      ? `The image for that deployment is not on ${target.name}. It was built on another server without a registry, or cleaned up. Redeploy instead.`
      : `The image is not on ${target.name}. Choose a registry in Settings → Servers & registry so other servers can pull it.`,
  );
}

/** Push a freshly built image to the service's registry. Returns the reference other servers pull. */
async function pushToRegistry(
  service: Service,
  dep: Deployment,
  dist: Distribution,
  registry: RegistryRow,
  image: string,
  buildServer: ServerCtx,
  log: StepLog,
  signal?: AbortSignal,
) {
  const [row] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, dep.id));
  const repository = normalizeRepository(dist.repository ?? defaultRepository(registry, service.slug));
  const tag = renderTag(dist.tag, { commit: row?.commitSha, deployment: dep.id, branch: row?.branch, service: service.slug });
  const repo = `${registry.host}/${repository}`;
  log.step(`Pushing ${repo}:${tag} to ${registry.name}`);
  const digest = await pushImage({
    d: buildServer.docker,
    localRef: image,
    repo,
    tags: dist.tagLatest && tag !== "latest" ? [tag, "latest"] : [tag],
    auth: registryAuth(registry),
    log: log.line,
    signal,
  });
  const ref = digest ? imageRef(registry.host, repository, digest) : imageRef(registry.host, repository, tag);
  log.line(digest ? `Pushed ${repo}:${tag} (${digest})` : `Pushed ${repo}:${tag}`);
  return ref;
}

const replicasOf = (runtime: Service["runtime"]) => Math.max(1, Math.min(runtime.replicas || 1, 20));

async function deployApp(service: Service, dep: Deployment, log: DeployLogger, server: ServerCtx, signal?: AbortSignal) {
  const dist = normalizeDistribution(service.serverId, service.distribution);
  const sourceType = service.source?.type;
  const problem = distributionProblem(dist, sourceType);
  if (problem) throw new Error(problem);
  // Host paths, host ports and extra privileges: saved only by Root admins, and checked again
  // here, so a service copied or moved into another organization cannot keep them.
  const hostUses = [
    service.runtime.volumes.some((v) => v.kind === "bind") && "host path mounts",
    service.runtime.ports.length > 0 && "published host ports",
    (service.runtime.privileged || !!service.runtime.capAdd?.length) && "privileged mode or extra capabilities",
    !!service.runtime.securityOpt?.length && "security options",
    (!!service.runtime.gpus || !!service.runtime.devices?.length) && "GPUs or host devices",
    (service.runtime.volumes.some((v) => v.external) || !!service.runtime.networks?.length) && "volumes or networks made outside Serve",
  ].filter(Boolean);
  if (hostUses.length && (await orgIdOf(service)) !== (await getSetting("rootOrganizationId"))) {
    throw new Error(`Only services of the Root organization may use ${hostUses.join(", ")}. Remove them in the service settings.`);
  }
  const registry = dist.registryId ? await getRegistry(dist.registryId) : null;
  if (dist.registryId && !registry) throw new Error("The registry of this service was removed. Choose another one in Settings → Servers & registry.");

  // Extra servers are best effort: one that is offline is skipped, not fatal.
  const targets: DeploymentTarget[] = [{ serverId: server.id, name: server.name, primary: true, status: "pending" }];
  const extras: ServerCtx[] = [];
  for (const id of dist.extraServerIds) {
    try {
      const extra = await connectTo(id, log, "extra");
      extras.push(extra);
      targets.push({ serverId: extra.id, name: extra.name, primary: false, status: "pending" });
    } catch (error) {
      log.line(`Warning: skipping an extra server: ${(error as Error).message}`);
      const [row] = await db.select({ name: schema.server.name }).from(schema.server).where(eq(schema.server.id, id));
      if (row) targets.push({ serverId: id, name: row.name, primary: false, status: "skipped", error: (error as Error).message });
    }
  }
  const multi = targets.length > 1;
  const saveTargets = () => (multi ? setDeployment(dep.id, { targets: targets.map((t) => ({ ...t })) }) : Promise.resolve());
  await saveTargets();

  // Git builds may happen on a dedicated build server; image sources are pulled where they run.
  const buildServer = buildsImage(sourceType) && dist.buildServerId && !dep.rollbackOf ? await connectTo(dist.buildServerId, log, "build") : server;
  const prepared = await prepareAppImage(service, dep, log, buildServer, signal, buildServer === server ? await buildNetworkOf(service, server, log) : null);
  checkCancelled(signal);
  const { image, detectedPort } = prepared;
  if (registry && buildsImage(sourceType) && !prepared.rollback) {
    prepared.registryImage = await pushToRegistry(service, dep, dist, registry, image, buildServer, log, signal);
    await setDeployment(dep.id, { registryImage: prepared.registryImage });
    checkCancelled(signal);
  }
  await setDeployment(dep.id, { image, status: "deploying" });
  await setServiceStatus(service.id, "deploying");

  // Fill in the port if it was never configured.
  let runtime = service.runtime;
  if (!runtime.port && detectedPort && runtime.detectPort !== false) {
    runtime = { ...runtime, port: detectedPort };
    await db.update(schema.service).set({ runtime }).where(eq(schema.service.id, service.id));
    log.line(`Using detected port ${detectedPort}`);
  }

  const env = await resolveEnv({ ...service, runtime });
  log.redact(env.secrets);
  stopOnFailedSecrets(env);
  // The commit running, for error trackers and version pages. The service's own variables win.
  const [built] = await db.select({ sha: schema.deployment.commitSha, branch: schema.deployment.branch }).from(schema.deployment).where(eq(schema.deployment.id, dep.id));
  for (const [k, v] of [
    ["SOURCE_COMMIT", built?.sha],
    ["SERVE_GIT_COMMIT", built?.sha],
    ["SERVE_GIT_BRANCH", built?.branch],
  ] as const)
    if (v && !(k in env.runtime)) env.runtime[k] = v;
  const replicaTotal = replicaCount(runtime.replicas, dist.extraServerIds.length);
  const short = shortReplicaPicks(env.runtime, replicaTotal);
  if (short.length) log.line(`Warning: replica.pick in ${short.join(", ")} has fewer values than the ${replicaTotal} replicas. The others get an empty value.`);
  if (env.missing.length) log.line(`Warning: unresolved variable references: ${env.missing.join(", ")}`);

  // The service's own server first: its failure fails the deployment and keeps the old version everywhere.
  const primaryTarget = targets[0];
  primaryTarget.status = "deploying";
  let imageVolumes: string[] = [];
  await saveTargets();
  try {
    if (multi) log.step(`Deploying to ${server.name}`);
    await ensureImageOn(server, service, prepared, registry, log);
    imageVolumes = await imageVolumePaths(image, server.docker);
    runtime = await keepImageVolumes(service, runtime, imageVolumes, log);
    await runOnServer({ service, dep, log, server, image, runtime, env, signal, primary: true, replicaOffset: 0, replicaTotal, imageVolumes, adopt: dep.adopt ?? null });
    primaryTarget.status = "success";
  } catch (error) {
    primaryTarget.status = "failed";
    primaryTarget.error = (error as Error).message.slice(0, 500);
    await saveTargets();
    throw error;
  }
  await saveTargets();

  // Then every extra server in parallel, each rolling back on its own if it fails.
  const results = await Promise.all(
    extras.map(async (extra) => {
      const t = targets.find((x) => x.serverId === extra.id)!;
      const slog = log.scoped(extra.name);
      t.status = "deploying";
      await saveTargets();
      try {
        slog.step(`Deploying to ${extra.name}`);
        await ensureImageOn(extra, service, prepared, registry, slog);
        // Replica numbers continue across servers, in the order the servers were added.
        const replicaOffset = (dist.extraServerIds.indexOf(extra.id) + 1) * replicasOf(runtime);
        await runOnServer({ service, dep, log: slog, server: extra, image, runtime, env, signal, primary: false, replicaOffset, replicaTotal, imageVolumes });
        t.status = "success";
      } catch (error) {
        t.status = "failed";
        t.error = (error as Error).message.slice(0, 500);
        slog.line(`Failed: ${t.error}`);
      }
      await saveTargets();
      return t;
    }),
  );
  const failed = [...results, ...targets.filter((t) => t.status === "skipped")].filter((t) => t.status !== "success");
  if (failed.length) {
    log.line(`Warning: not running the new version on ${failed.map((t) => t.name).join(", ")}. Those servers keep the previous version.`);
    await setDeployment(dep.id, { error: `Not deployed to ${failed.map((t) => `${t.name}: ${t.error ?? t.status}`).join("; ")}`.slice(0, 4000) });
  }
  // The build server keeps a copy for fast rebuilds; trim it like the others.
  if (buildServer.id !== server.id && !extras.some((e) => e.id === buildServer.id)) await pruneImages(service, buildServer, image).catch(() => {});
}

/** Start a deployment's containers on one server, wait for health, switch traffic and retire the old version there. */
async function runOnServer(opts: {
  service: Service;
  dep: Deployment;
  log: StepLog & Partial<Pick<DeployLogger, "redact">>;
  server: ServerCtx;
  image: string;
  runtime: Service["runtime"];
  env: Awaited<ReturnType<typeof resolveEnv>>;
  signal?: AbortSignal;
  /** The service's own server: runs the pre-deploy command and marks the deployment current. */
  primary: boolean;
  /** Index of this server's first replica, and replicas across all servers (SERVE_REPLICA_INDEX/COUNT). */
  replicaOffset: number;
  replicaTotal: number;
  /** Paths the image declares with VOLUME. */
  imageVolumes: string[];
  /** A container made outside Serve that the new containers replace. */
  adopt?: Handoff | null;
}) {
  const { service, dep, log, server, image, runtime, env, signal, primary, replicaOffset, replicaTotal } = opts;
  const d = server.docker;
  const old = (await listServiceContainers(service.id, true, d)).filter((c) => c.Labels[LABEL.deployment] !== dep.id);
  const replicas = replicasOf(runtime);
  const recreate = runtime.deployStrategy === "recreate";
  // Two copies of a stateful app (postgres, redis, ...) on one data directory corrupt it.
  const stateful = statefulMounts(opts.imageVolumes, runtime.volumes);
  const needsStopFirst = runtime.ports.length > 0 || recreate || stateful.length > 0;
  // The container taken over goes before the new ones start when they share its data or ports;
  // else it serves until the new ones are healthy.
  // A copy leaves the container running: only its data is copied in, before the first start.
  const copyFrom = opts.adopt?.mode === "copy" ? opts.adopt : null;
  const adopt = copyFrom ? null : (opts.adopt ?? null);
  const adoptFirst = !!adopt && (needsStopFirst || runtime.volumes.some((v) => v.kind !== "file"));
  const adoptPolicy = adopt ? await restartPolicyOf(d, adopt) : null;
  if (stateful.length && replicas > 1) {
    log.line(
      `Warning: the ${replicas} replicas share the data in ${stateful.map((v) => v.mountPath).join(", ")}. Most databases need exactly one; use 1 replica unless the app supports this.`,
    );
  }
  if (runtime.ports.length) {
    // Fail before touching the running version when another container holds a port.
    await assertPortsFree(d, server.name, runtime.ports, service.id, adopt?.containerId);
  }
  await assertOutsideDataFree(
    d,
    runtime.volumes.filter((v) => v.external).map((v) => v.source),
    service.id,
    opts.adopt?.containerId,
  );

  const [stillThere] = await db.select({ id: schema.service.id }).from(schema.service).where(eq(schema.service.id, service.id));
  if (!stillThere) throw new DeployCancelled("The service was deleted");
  const network = await ensureEnvNetwork(service.environmentId, server);
  if (runtime.volumes.some((v) => v.kind !== "volume")) await prepareMounts(server, service.id, runtime.volumes, log.line);
  await meshBeforeStart(service, server.id, log.line);

  if (runtime.preDeployCommand && dep.rollbackOf && primary) log.line("Skipping the pre-deploy command for a rollback");
  // Migrations and similar run once, on the service's own server.
  if (runtime.preDeployCommand && !dep.rollbackOf && primary) {
    // Runs before the old version stops, so a failing migration never takes the app down.
    log.step("Running the pre-deploy command");
    await runPreDeploy({
      service,
      dep,
      image,
      env: replicaEnv({ ...env.runtime, ...env.replicas[1] }, 0, replicaTotal, env.literal),
      runtime,
      network,
      d,
      log,
      signal,
      serviceDir: server.paths.service(service.id),
    });
    checkCancelled(signal);
  }

  if (needsStopFirst && old.length) {
    log.line(
      recreate
        ? "Stopping the previous version first (recreate strategy)"
        : runtime.ports.length
          ? "Stopping the previous version first because host ports are published"
          : `Stopping the previous version first: it keeps data in ${stateful.map((v) => v.mountPath).join(", ")}, which two copies must not use at once`,
    );
    const stopWait = runtime.stopTimeout ?? 10;
    for (const c of old)
      await d
        .getContainer(c.Id)
        .stop({ t: stopWait })
        .catch(() => {});
  }
  if (copyFrom?.volumes?.length) {
    log.step(`Copying the data of ${copyFrom.name}`);
    await copyVolumesInto(d, copyFrom, log.line);
  }
  if (adopt && adoptFirst) {
    log.step(`Taking over from ${adopt.name}`);
    await retireOld(d, adopt, log.line, runtime.stopTimeout ?? 30);
  }
  if (runtime.swappiness != null && (await d.info().catch(() => null))?.CgroupVersion === "2")
    log.line(`Note: ${server.name} uses cgroup v2, which has no per-container swappiness. That setting is ignored there.`);
  log.step(`Starting ${replicas} container${replicas > 1 ? "s" : ""}`);
  const started: string[] = [];
  try {
    if (stateful.length && old.length) {
      // The newest container of the previous version holds its data.
      const previous = old.filter((c) => c.Labels[LABEL.kind] === "app").sort((a, b) => b.Created - a.Created);
      await adoptAnonymousVolumes({ d, slug: service.slug, serviceId: service.id, volumes: stateful, old: previous, log: log.line });
      checkCancelled(signal);
    }
    for (let i = 0; i < replicas; i++) {
      const name = `${service.slug}-${dep.id.slice(0, 6)}-${i + 1}`;
      await removeContainer(name, 0, d);
      const container = await startContainer(
        {
          name,
          image,
          slug: service.slug,
          serviceId: service.id,
          deploymentId: dep.id,
          kind: "app",
          env: replicaEnv({ ...env.runtime, ...env.replicas[replicaOffset + i + 1] }, replicaOffset + i, replicaTotal, env.literal),
          runtime,
          aliases: networkAliases(service),
          network,
          serviceDir: server.paths.service(service.id),
        },
        server,
      );
      started.push(container.id);
      log.line(`Started ${name}`);
    }

    log.step("Waiting for healthchecks");
    await Promise.all(started.map((id) => waitHealthy(id, runtime, log.line, signal, network, server)));
    log.line("All containers are healthy");
    // Last chance to cancel before traffic moves to the new version.
    checkCancelled(signal);
  } catch (error) {
    for (const id of started) await removeContainer(id, 0, d);
    if (adopt && adoptFirst) {
      log.line(`Putting ${adopt.name} back`);
      await restoreOld(d, adopt, adoptPolicy, log.line);
    }
    if (needsStopFirst && old.length) {
      // Bring the previous version back so a failed deploy does not take the app down.
      log.line("Restarting the previous version");
      for (const c of old) {
        // The crash limit may have set its restart policy to "no".
        await d
          .getContainer(c.Id)
          .update({ RestartPolicy: dockerRestartPolicy(runtime.restartPolicy) })
          .catch(() => {});
        await d
          .getContainer(c.Id)
          .start()
          .catch(() => {});
      }
    }
    throw error;
  }

  // Switch traffic.
  if (primary) {
    await db.update(schema.service).set({ currentDeploymentId: dep.id, status: "running" }).where(eq(schema.service.id, service.id));
    // Other servers reach the new containers through the private network from now on.
    await meshAfterStart(server.id, log.line);
  }
  log.step("Routing traffic");
  try {
    await syncServiceProxy(service.id, server.id);
    log.line("Proxy updated");
  } catch (error) {
    log.line(`Warning: proxy update failed: ${(error as Error).message}`);
  }

  if (adopt && !adoptFirst) {
    log.step(`Taking over from ${adopt.name}`);
    await retireOld(d, adopt, log.line, runtime.stopTimeout ?? 15);
  }
  if (old.length && !needsStopFirst) {
    const drain = runtime.drainSeconds ?? 3;
    log.line(`Draining ${old.length} old container${old.length > 1 ? "s" : ""}${drain ? ` for ${drain}s` : ""}`);
    if (drain) await new Promise((r) => setTimeout(r, drain * 1000));
    await Promise.all(old.map((c) => removeContainer(c.Id, runtime.stopTimeout ?? 15, d)));
  } else if (old.length) {
    await Promise.all(old.map((c) => removeContainer(c.Id, 0, d)));
  }
  await pruneImages(service, server, image).catch(() => {});
  // Once, on the service's own server, in the new version's first container. It is live already,
  // so a failure is only reported.
  if (runtime.postDeployCommand && primary && !dep.rollbackOf && started[0]) {
    log.step("Running the post-deploy command");
    await runPostDeploy(started[0], runtime, d, log, signal);
  }
}

/** Runs the post-deploy command in a running container of the new version. Never fails the deployment. */
async function runPostDeploy(containerId: string, runtime: Service["runtime"], d: Docker, log: StepLog, signal?: AbortSignal) {
  const { execCommand } = await import("@/server/services/exec");
  let partial = "";
  try {
    const result = await execCommand(containerId, runtime.postDeployCommand!, {
      docker: d,
      signal,
      timeoutSeconds: Math.max(60, runtime.healthcheckTimeout ?? 900),
      onData: (text) => {
        const lines = (partial + text).split(/\r?\n/);
        partial = lines.pop() ?? "";
        for (const line of lines) log.line(line);
      },
    });
    if (partial) log.line(partial);
    if (result.timedOut) log.line("Warning: the post-deploy command timed out. The new version keeps running.");
    else if (result.exitCode !== 0) log.line(`Warning: the post-deploy command exited with code ${result.exitCode}. The new version keeps running.`);
    else log.line("Post-deploy command finished");
  } catch (error) {
    log.line(`Warning: the post-deploy command could not run: ${(error as Error).message}. The new version keeps running.`);
  }
}

/**
 * Mount a named volume on every path the image keeps data in (VOLUME) that no mount covers, and
 * save it to Persistent storage: an anonymous volume would be new and empty after every deploy.
 */
async function keepImageVolumes(service: Service, runtime: Service["runtime"], declared: string[], log: StepLog) {
  const missing = uncoveredPaths(declared, runtime.volumes);
  if (!missing.length) return runtime;
  const replicas = replicasOf(runtime);
  if (replicas > 1) {
    // One shared volume would put several copies on one data directory: not done on the user's behalf.
    log.line(
      `Warning: the image stores data in ${missing.join(", ")}. Each of the ${replicas} replicas keeps its own copy, lost on the next deploy. Add a volume in Persistent storage to keep it.`,
    );
    return runtime;
  }
  const added = volumesFor(missing, runtime.volumes);
  for (const v of added) log.line(`The image stores data in ${v.mountPath}: kept in volume ${volumeName(service.slug, v.source)} across deploys.`);
  const [fresh] = await db.select({ runtime: schema.service.runtime }).from(schema.service).where(eq(schema.service.id, service.id));
  const saved = fresh?.runtime ?? runtime;
  await db
    .update(schema.service)
    .set({ runtime: { ...saved, volumes: [...saved.volumes, ...added] } })
    .where(eq(schema.service.id, service.id));
  return { ...runtime, volumes: [...runtime.volumes, ...added] };
}

/**
 * Run the pre-deploy command in a one-off container from the new image, with the
 * service's variables and network. A non-zero exit fails the deployment.
 */
async function runPreDeploy(opts: {
  service: Service;
  dep: Deployment;
  image: string;
  env: Record<string, string>;
  runtime: Service["runtime"];
  network: string;
  d: Docker;
  log: StepLog;
  signal?: AbortSignal;
  serviceDir: string;
}) {
  const { service, dep, d, log } = opts;
  const name = `${service.slug}-${dep.id.slice(0, 6)}-predeploy`;
  await removeContainer(name, 0, d);
  const spec = createSpec({
    name,
    image: opts.image,
    slug: service.slug,
    serviceId: service.id,
    deploymentId: dep.id,
    kind: "predeploy",
    env: opts.env,
    // No published ports, no restarts: it runs once next to the live version.
    runtime: { ...opts.runtime, ports: [], restartPolicy: "no", command: null },
    aliases: [],
    network: opts.network,
    serviceDir: opts.serviceDir,
    cmd: ["sh", "-c", opts.runtime.preDeployCommand!],
  });
  const container = await d.createContainer(spec);
  let timer: NodeJS.Timeout | undefined;
  try {
    await container.start().catch((error: Error) => {
      throw gpuError(error, opts.runtime) ?? error;
    });
    const stream = (await container.logs({ follow: true, stdout: true, stderr: true })) as unknown as NodeJS.ReadableStream;
    const { PassThrough } = await import("node:stream");
    const out = new PassThrough();
    let partial = "";
    out.on("data", (chunk: Buffer) => {
      const lines = (partial + chunk.toString("utf8")).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) log.line(line);
    });
    d.modem.demuxStream(stream, out, out);
    const timeoutMs = Math.max(60, opts.runtime.healthcheckTimeout ?? 900) * 1000;
    const result = (await Promise.race([
      container.wait(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("The pre-deploy command timed out.")), timeoutMs);
      }),
      new Promise((_, reject) => {
        if (opts.signal?.aborted) reject(new DeployCancelled("Deployment cancelled"));
        else opts.signal?.addEventListener("abort", () => reject(new DeployCancelled("Deployment cancelled")), { once: true });
      }),
    ])) as { StatusCode: number };
    await new Promise((r) => setTimeout(r, 200));
    if (partial) log.line(partial);
    if (result.StatusCode !== 0) throw new Error(`The pre-deploy command exited with code ${result.StatusCode}. The previous version keeps running.`);
    log.line("Pre-deploy command finished");
  } finally {
    clearTimeout(timer);
    await container.remove({ force: true }).catch(() => {});
  }
}

/** Throws a clear error when another container already publishes one of the ports. */
async function assertPortsFree(d: Docker, serverName: string, ports: PortMapping[], serviceId: string, adoptId?: string) {
  if (!ports.length) return;
  // The container being taken over frees its ports when it stops.
  const others = (await d.listContainers()).filter((c) => c.Labels[LABEL.service] !== serviceId && c.Id !== adoptId);
  for (const p of ports) {
    const holder = others.find((c) =>
      c.Ports.some(
        (x) => x.PublicPort === p.host && x.Type === p.protocol && (x.IP === "0.0.0.0" || x.IP === "::" || !p.bindAddress || p.bindAddress === "0.0.0.0" || x.IP === p.bindAddress),
      ),
    );
    if (holder) {
      const name = holder.Names[0]?.replace(/^\//, "") ?? holder.Id.slice(0, 12);
      throw new Error(`Port ${p.host} is already used by the container ${name} on ${serverName}. Choose another port in Domains & ports.`);
    }
  }
}

/** Asks for the certificates of a service's HTTPS domains that have none (see ensureCertificateFor). */
async function requestDomainCertificates(service: Service, organizationId: string, log: DeployLogger) {
  const domains = await db
    .select()
    .from(schema.domain)
    .where(and(eq(schema.domain.serviceId, service.id), eq(schema.domain.https, true)));
  const { ensureCertificateFor } = await import("@/server/ssl/certificates");
  for (const d of domains) {
    if (d.certificateId) continue;
    const before = Date.now();
    const cert = await ensureCertificateFor(d, organizationId, { requestNow: true }).catch((e: Error) => {
      log.line(`Warning: no certificate for ${d.hostname}: ${e.message}`);
      return null;
    });
    if (cert && cert.createdAt.getTime() >= before - 1000) log.line(`Requested a certificate for ${d.hostname}`);
  }
}

/**
 * Volumes made outside Serve that another running container still uses: a second container on the
 * same data corrupts it. The container being taken over is the one exception: it stops first.
 */
async function assertOutsideDataFree(d: Docker, volumes: string[], serviceId: string, adoptId?: string) {
  if (!volumes.length) return;
  const wanted = new Set(volumes);
  const running = await d.listContainers();
  for (const c of running) {
    if (c.Labels[LABEL.service] === serviceId || c.Id === adoptId) continue;
    const used = (c.Mounts ?? []).find((m) => (m.Name && wanted.has(m.Name)) || (m.Type === "bind" && wanted.has(m.Source)));
    if (!used) continue;
    const name = c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12);
    throw new Error(`The data in ${used.Name ?? used.Source} is used by the running container ${name}. Stop it, or move it into the project, before deploying.`);
  }
}

/** Keep the newest N images per service for rollbacks (N is set per server), and the image being deployed. */
async function pruneImages(service: Service, server: ServerCtx, current: string) {
  const d = server.docker;
  const keep = await db
    .select({ image: schema.deployment.image })
    .from(schema.deployment)
    .where(and(eq(schema.deployment.serviceId, service.id), eq(schema.deployment.status, "success")))
    .orderBy(desc(schema.deployment.createdAt))
    .limit(Math.max(1, server.row.imageRetention) + 1);
  const keepSet = new Set([current, ...keep.map((k) => k.image).filter(Boolean)]);
  const images = await d.listImages({ filters: { reference: [`${imageRepo(service.slug)}:*`] } });
  for (const img of images) {
    const tags = img.RepoTags ?? [];
    if (tags.some((t) => keepSet.has(t))) continue;
    for (const tag of tags)
      await d
        .getImage(tag)
        .remove()
        .catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Databases                                  */
/* -------------------------------------------------------------------------- */

export async function deployDatabase(service: Service, log: DeployLogger | null, signal?: AbortSignal, handoff: Handoff | null = null) {
  // A copy leaves the container running: its data is dumped and restored once the database is up.
  const copyFrom = handoff?.mode === "copy" ? handoff : null;
  const adopt = copyFrom ? null : handoff;
  const server = await serverOf(service);
  const d = server.docker;
  const cfg = service.database!;
  const engine = engines[cfg.engine];
  const serviceDir = server.paths.service(service.id);
  const { databaseDomainCert } = await import("@/server/databases/domain-tls");
  const plan = databasePlan(cfg, decryptOrNull(cfg.password) ?? "", serviceDir, await databaseDomainCert(server, service));
  const image = plan.image;
  const line = log?.line ?? (() => {});
  log?.redact([plan.creds.password]);

  if (!(await imageExists(image, d))) {
    log?.step(`Pulling ${image}`);
    await pullImage(image, line, null, d);
  }
  checkCancelled(signal);

  // Generated files: configuration, initialization scripts and TLS certificates.
  for (const dir of plan.resetDirs) await server.fs.rm(dir);
  for (const f of plan.files) await server.fs.writeFile(f.path, f.content, f.mode);
  if (plan.files.length) line(`Wrote ${plan.files.length} configuration file${plan.files.length === 1 ? "" : "s"}`);
  if (plan.tls) {
    await ensureDatabaseTls(server, service.id, [service.slug, "localhost", "127.0.0.1", server.row.publicIp ?? "", server.local ? "" : server.row.host], line);
    line(`TLS on (${cfg.tls?.mode === "require" ? "required" : "optional"} for clients)${plan.verified ? `, with the certificate of ${cfg.domain}` : ""}`);
  }
  const extra = service.runtime.volumes ?? [];
  if (extra.some((v) => v.kind !== "volume")) await prepareMounts(server, service.id, extra, line);

  // The public port's allowlist (or its removal) goes in the server's firewall before the port
  // opens: when the firewall cannot take it, the deploy fails and the old container stays.
  const { allowlistsPending, applyDatabaseAllowlists } = await import("@/server/databases/allowlist");
  if ((cfg.publicPort || cfg.publicAllow?.length) && (await allowlistsPending(server.id, service.id))) {
    const restricted = !!cfg.publicAllow?.length && !!cfg.publicPort && cfg.publicBind !== "127.0.0.1";
    try {
      await applyDatabaseAllowlists(server.id, service.id);
      if (restricted) line(`Port ${cfg.publicPort} accepts only ${cfg.publicAllow!.join(", ")}`);
    } catch (error) {
      if (restricted) throw new Error(`The allowlist for port ${cfg.publicPort} could not be applied, so the port was not opened: ${(error as Error).message}`);
      line(`Warning: the firewall rules were not refreshed: ${(error as Error).message}`);
    }
  }
  // A database moved into a project keeps its data where it was: a volume or folder made outside Serve.
  const dataMount: VolumeMount = !cfg.dataVolume
    ? { kind: "volume", source: "data", mountPath: plan.dataMountPath }
    : cfg.dataVolume.startsWith("/")
      ? { kind: "bind", source: cfg.dataVolume, mountPath: plan.dataMountPath }
      : { kind: "volume", source: cfg.dataVolume, mountPath: plan.dataMountPath, external: true };
  if (((cfg.dataVolume && !cfg.dataVolumeOwned) || service.runtime.networks?.length) && (await orgIdOf(service)) !== (await getSetting("rootOrganizationId"))) {
    throw new Error("Only services of the Root organization may keep data or names in volumes and networks made outside Serve.");
  }
  log?.step("Starting database");
  await ensureNetwork(d, server.network);
  const network = await ensureEnvNetwork(service.environmentId, server);
  await assertOutsideDataFree(
    d,
    [cfg.dataVolume, ...extra.filter((v) => v.external).map((v) => v.source)].filter((v): v is string => !!v),
    service.id,
    adopt?.containerId,
  );
  // A database taken over stops first: two servers on one data directory corrupt it.
  const adoptPolicy = adopt ? await restartPolicyOf(d, adopt) : null;
  if (adopt) await retireOld(d, adopt, line, 60);
  try {
    return await startDatabase();
  } catch (error) {
    if (adopt) {
      await removeContainer(service.slug, 0, d);
      line(`Putting ${adopt.name} back`);
      await restoreOld(d, adopt, adoptPolicy, line);
    }
    throw error;
  }

  async function startDatabase() {
    await removeContainer(service.slug, 30, d);
    const container = await startContainer(
      {
        name: service.slug,
        image,
        slug: service.slug,
        serviceId: service.id,
        kind: "database",
        env: plan.env,
        cmd: plan.cmd,
        healthcheck: plan.healthcheck,
        healthTiming: plan.health,
        extraBinds: plan.binds,
        serviceDir,
        runtime: {
          ...service.runtime,
          port: engine.port,
          command: null,
          // The data volume first, then any mounts added in Persistent storage.
          volumes: [dataMount, ...extra.filter((v) => !(v.kind === "volume" && v.source === "data" && !v.external))],
          // With TLS on, the public port leads to the TLS port (Redis, Valkey and ClickHouse keep a plain one for the private network).
          ports: cfg.publicPort ? [{ host: cfg.publicPort, container: plan.publicTarget, protocol: "tcp", bindAddress: cfg.publicBind }] : [],
          healthcheckPath: null,
          healthcheckTimeout: 180,
        },
        aliases: networkAliases(service),
        network,
      },
      server,
    );
    line(
      `${dataMount.kind === "bind" ? "Folder" : "Volume"} ${dataMount.external || dataMount.kind === "bind" ? dataMount.source : volumeName(service.slug, "data")} mounted at ${plan.dataMountPath}`,
    );
    log?.step("Waiting for the database to accept connections");
    await waitHealthy(
      container.id,
      { ...service.runtime, port: null, healthcheckTimeout: Math.max(180, plan.health.startPeriod + plan.health.interval * plan.health.retries + 30) },
      line,
      signal,
      network,
      server,
    );
    line(`${engine.label} is ready`);
    if (copyFrom) {
      log?.step(`Copying the data of ${copyFrom.name}`);
      await copyDatabaseInto(service, d, copyFrom, line);
    }
    await setServiceStatus(service.id, "running");
    // Add-ons follow the database (a new version, new settings): PostgreSQL's pooler, and read
    // replicas of every engine that has them (also to tidy the database's side once they are off).
    // A failing one does not fail the deploy.
    if ((cfg.engine === "postgres" && (cfg.pooler?.enabled || cfg.replica?.enabled)) || (cfg.engine !== "postgres" && replicasSupported(cfg.engine) && cfg.replica)) {
      const { ensurePooler, ensureReplicas } = await import("@/server/databases/addons");
      const fresh = (await db.query.service.findFirst({ where: eq(schema.service.id, service.id) })) ?? service;
      await ensurePooler(fresh, line).catch((e) => line(`Warning: the connection pooler did not start: ${(e as Error).message}`));
      await ensureReplicas(fresh, line).catch((e: Error) => line(`Warning: the read replicas did not start: ${e.message}`));
    }
    await meshAfterStart(server.id, line);
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Compose                                   */
/* -------------------------------------------------------------------------- */

/** A compose stack is one copy: replica references mean the first and only one. */
function composeVars(env: Record<string, string>, literal: readonly string[] = []) {
  const { SERVE_REPLICA_INDEX: _i, SERVE_REPLICA_COUNT: _c, ...vars } = replicaEnv(env, 0, 1, literal);
  return vars;
}

async function deployCompose(service: Service, dep: Deployment, log: DeployLogger, server: ServerCtx, signal?: AbortSignal) {
  const cfg = service.compose!;
  const env = await resolveEnv(service);
  log.redact(env.secrets);
  stopOnFailedSecrets(env);
  const serviceDir = paths.service(service.id);
  let dir = path.join(serviceDir, "compose");
  let content = cfg.content;
  let tracked: string[] | null = null;

  if (cfg.mode === "git") {
    if (service.source?.type !== "git") throw new Error("Compose from git needs a git source.");
    log.step("Cloning repository");
    const repoDir = path.join(serviceDir, "repo");
    // Updated in place: relative bind mounts keep their data in the repository directory.
    const clone = await cloneRepository(service.source, repoDir, log.line, signal, await orgIdOf(service), { inPlace: true });
    await setDeployment(dep.id, {
      commitSha: clone.commitSha,
      commitMessage: clone.commitMessage,
      commitAuthor: clone.commitAuthor,
      branch: service.source.branch,
    });
    tracked = clone.files ?? null;
    let composePath = containedPath(repoDir, cfg.path, "Compose file path");
    // The standard names are interchangeable: a repository with compose.yaml works with the default path.
    const standard = ["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"];
    const base = path.posix.basename(cfg.path);
    if (standard.includes(base) && !(await fs.stat(composePath).catch(() => null))) {
      for (const name of standard) {
        const candidate = containedPath(repoDir, path.posix.join(path.posix.dirname(cfg.path), name), "Compose file path");
        if (await fs.stat(candidate).catch(() => null)) {
          log.line(`${cfg.path} not found; using ${path.relative(repoDir, candidate)}`);
          composePath = candidate;
          break;
        }
      }
    }
    // Resolve symlinks so a link in the repository cannot point at files on the server.
    const realRepo = await fs.realpath(repoDir);
    const realCompose = await fs.realpath(composePath).catch(() => {
      throw new Error(`Compose file ${cfg.path} not found in the repository.`);
    });
    if (realCompose !== realRepo && !realCompose.startsWith(realRepo + path.sep)) {
      throw new Error(`Compose file ${cfg.path} points outside the repository.`);
    }
    content = await fs.readFile(composePath, "utf8").catch(() => {
      throw new Error(`Compose file ${cfg.path} not found in the repository.`);
    });
    dir = path.dirname(composePath);
    // Bind mounts, env files, build contexts and secret files are read on the host: a symlink in the
    // repository must not lead them to files outside it.
    const escaping = await pathsOutside(repoDir, composeLocalPaths(content, dir));
    if (escaping.length) {
      throw new Error(`The compose file uses paths that lead outside the repository: ${escaping.map((p) => path.relative(repoDir, p)).join(", ")}`);
    }
    // BuildKit cache mounts are shared by every build on the server: give this organization's its own ids.
    await scopeDockerfiles(composeDockerfiles(content, dir), buildCacheScope(await orgIdOf(service)), repoDir);
    // Remember the file so the UI can show services and ports.
    await db
      .update(schema.service)
      .set({ compose: { ...cfg, content } })
      .where(eq(schema.service.id, service.id));
  }
  // A name another service answers to would take its traffic: refused for everyone.
  const others = (
    await db.select({ id: schema.service.id, slug: schema.service.slug, hostname: schema.service.hostname, environmentId: schema.service.environmentId }).from(schema.service)
  ).filter((s) => s.id !== service.id);
  const hostnames = others.filter((s) => s.environmentId === service.environmentId && s.hostname).map((s) => s.hostname as string);
  const clashes = composeNameClashes(
    content,
    others.map((s) => s.slug),
    hostnames,
  );
  if (clashes.length) throw new Error(`The compose file uses names of other services: ${clashes.slice(0, 3).join("; ")}`);
  // Checked at every deploy, for files from git and files saved before a rule existed: only the
  // Root organization may use host-level options or reach into Serve's own networks.
  const issues = composeSecurityIssues(content);
  // Only for stacks of the Root organization that one of its admins set up (not any of its members).
  if (issues.length && !(cfg.hostAccess && (await orgIdOf(service)) === (await getSetting("rootOrganizationId")))) {
    throw new Error(
      `The compose file uses options only admins of the Root organization may set up: ${issues.slice(0, 3).join("; ")}. An admin of the Root organization can save the stack's compose settings to allow them.`,
    );
  }
  // A file from git can change with every push: new host-level options need a Root admin to deploy them once.
  if (issues.length) {
    const approved = new Set(cfg.hostAccessIssues ?? []);
    const added = issues.filter((i) => !approved.has(i));
    if (added.length) {
      const { isInstanceAdmin } = await import("@/server/auth");
      if (!dep.createdBy || !(await isInstanceAdmin(dep.createdBy))) {
        throw new Error(
          `The compose file asks for host-level options no admin of the Root organization has deployed yet: ${added.slice(0, 3).join("; ")}. Such an admin deploys it once to approve them.`,
        );
      }
      await db
        .update(schema.service)
        // With the file just read from git: the old one must not come back with the approval.
        .set({ compose: { ...cfg, content, hostAccessIssues: issues } })
        .where(eq(schema.service.id, service.id));
    }
  }
  checkCancelled(signal);

  // Docker Compose silently turns an unset ${VAR} into an empty string, which fails later in
  // confusing ways (a database without a password never becomes healthy). Stop here instead.
  const used = composeVariables(content);
  const unset = used.filter((v) => !v.hasDefault && !(v.name in env.runtime));
  if (unset.length) {
    const names = unset.map((v) => v.name).join(", ");
    throw new Error(
      `The compose file uses ${unset.length === 1 ? "a variable that is" : "variables that are"} not set: ${names}. Add ${unset.length === 1 ? "it" : "them"} in Variables (an empty value is fine if that is intended), then deploy again.`,
    );
  }
  // ${VAR:?message}: the file asks for a value, so an empty one stops here, with its own words.
  const empty = used.filter((v) => v.required && env.runtime[v.name] === "");
  if (empty.length) {
    const list = empty.map((v) => (v.message ? `${v.name} (${v.message})` : v.name)).join(", ");
    throw new Error(`The compose file needs a value for ${list}. Fill ${empty.length === 1 ? "it" : "them"} in Variables, then deploy again.`);
  }
  // postgres:18+ keeps its data in /var/lib/postgresql and refuses to start with the old mount.
  for (const [name, svc] of Object.entries(parseCompose(content).services ?? {})) {
    const image = String((svc as { image?: string }).image ?? "");
    const major = Number(/^(?:docker\.io\/)?(?:library\/)?postgres:(\d+)/.exec(image)?.[1] ?? (/^(?:docker\.io\/)?(?:library\/)?postgres(:latest|:alpine)?$/.test(image) ? 99 : 0));
    const mounts = ((svc as { volumes?: unknown[] }).volumes ?? []).map((v) => (typeof v === "string" ? v.split(":")[1] : (v as { target?: string })?.target));
    if (major >= 18 && mounts.includes("/var/lib/postgresql/data")) {
      throw new Error(
        `Service ${name} runs ${image}, which stores its data in /var/lib/postgresql. Change the volume target from /var/lib/postgresql/data to /var/lib/postgresql, then deploy again.`,
      );
    }
  }

  let subnet = cfg.subnet ?? null;
  // A stored subnet may have been taken by another network while this stack was down.
  if (subnet) {
    const own = stackNetworkName(service.slug);
    const nets = await server.docker.listNetworks().catch(() => []);
    if (nets.some((n) => n.Name !== own && (n.IPAM?.Config ?? []).some((c) => c.Subnet === subnet))) {
      log.line(`Subnet ${subnet} is now used by another network; choosing a new one`);
      subnet = null;
    }
  }
  if (!subnet) {
    // One stack at a time: two stacks deploying together must not pick the same subnet.
    subnet = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('serve:compose-subnet'))`);
      const others = await tx.select({ compose: schema.service.compose }).from(schema.service).where(eq(schema.service.type, "compose"));
      const picked = await allocateSubnet(others.map((o) => o.compose?.subnet).filter(Boolean) as string[], server);
      const [fresh] = await tx.select({ compose: schema.service.compose }).from(schema.service).where(eq(schema.service.id, service.id));
      await tx
        .update(schema.service)
        .set({ compose: { ...(fresh?.compose ?? cfg), subnet: picked } })
        .where(eq(schema.service.id, service.id));
      return picked;
    });
  }
  const network = await ensureEnvNetwork(service.environmentId, server);
  await assertPortsFree(server.docker, server.name, service.compose?.ports ?? [], service.id);
  const isolated = !!service.compose?.isolated;
  if (!isolated) await meshBeforeStart(service, server.id, log.line);
  const transformed = transformCompose(content, service.slug, service.id, subnet, service.compose?.ports ?? [], isolated);
  // The stack's own network: named in the file, or compose's <project>_default.
  const declared = (parseCompose(transformed).networks as Record<string, { name?: string } | null> | undefined)?.default?.name;
  const stackNet = declared || stackNetworkName(service.slug);
  // Compose may recreate the stack network; the proxy must not hold it while that happens.
  await disconnectProxy(stackNet, server).catch(() => {});
  const run = {
    projectName: service.slug,
    dir,
    file: ".serve-compose.yml",
    vars: composeVars(env.runtime, env.literal),
    log: log.line,
    signal,
    redact: env.secrets,
    envNetwork: isolated ? undefined : network,
  };
  // dockerfile_inline builds too.
  await writeComposeFiles({ ...run, content: transformed.includes("type=cache") ? scopeCacheMounts(transformed, buildCacheScope(await orgIdOf(service))) : transformed });
  await setDeployment(dep.id, { status: "deploying" });
  await setServiceStatus(service.id, "deploying");
  await ensureNetwork(server.docker, server.network);

  let target = { ...run, server };
  if (!server.local) {
    // Compose runs on the server itself, against its own copy of the project.
    const uploadRoot = cfg.mode === "git" ? path.join(serviceDir, "repo") : dir;
    const remoteRoot = path.posix.join(server.paths.service(service.id), cfg.mode === "git" ? "repo" : "compose");
    const remoteDir = path.posix.join(remoteRoot, path.relative(uploadRoot, dir).split(path.sep).join("/"));
    log.step(`Uploading the project to ${server.name}`);
    // The upload only adds and replaces files: what is no longer tracked since the last upload
    // goes first. The list sits outside the copy, where the stack's containers cannot change it.
    const uploaded = path.posix.join(server.paths.service(service.id), ".serve-uploaded-files.json");
    if (tracked) {
      const previous = await server.fs
        .readFile(uploaded)
        .then((text) => JSON.parse(text) as string[])
        .catch(() => null);
      const stale = previous ? staleEntries(previous, tracked) : [];
      if (stale.length) await server.fs.removeInside(remoteRoot, stale);
    }
    await server.fs.uploadDir(uploadRoot, remoteRoot);
    if (tracked) await server.fs.writeFile(uploaded, JSON.stringify(tracked));
    target = { ...target, dir: remoteDir };
  }
  log.step(`Starting ${composeServiceNames(content).length} compose services`);
  try {
    await composeUp(target);
  } finally {
    // Isolated stacks are not on the environment network; the proxy joins the stack's own one.
    // Also after a failed deploy, so the containers still running stay reachable.
    if (isolated) {
      await connectProxy(stackNet, server).catch((e) => log.line(`Could not attach the proxy to ${stackNet}: ${(e as Error).message}`));
      const joined = await server.docker
        .getNetwork(stackNet)
        .inspect()
        .catch(() => null);
      if (!joined) log.line(`Network ${stackNet} was not found; domains of this stack cannot be routed.`);
    }
  }
  await db.update(schema.service).set({ currentDeploymentId: dep.id, status: "running" }).where(eq(schema.service.id, service.id));
  await meshAfterStart(server.id, log.line);
  log.step("Routing traffic");
  try {
    await syncServiceProxy(service.id);
    log.line("Proxy updated");
  } catch (error) {
    log.line(`Warning: proxy update failed: ${(error as Error).message}`);
  }
}

/** The service's server, checked for reachability before any work starts. */
async function connectServer(service: Service, log: DeployLogger) {
  const fresh = await waitForServerSetup(service.serverId, "the server", (l) => log.line(l));
  const server = await serverOf(service);
  if (server.local) return server;
  const status = fresh ?? server.row.status;
  if (status === "pending" || status === "validating") throw new Error(`${server.name} is not set up yet. Validate it in Servers first.`);
  log.line(`Deploying to ${server.name} (${server.row.host})`);
  try {
    await server.docker.ping();
  } catch (error) {
    throw new Error(`Could not reach ${server.name}: ${(error as Error).message}`);
  }
  return server;
}

function failureHint(message: string) {
  if (/Could not reach|ECONNREFUSED|Timed out connecting|SSH rejected/i.test(message)) return "Check that the server is online and that SSH works from the Servers page.";
  if (/address pools/i.test(message)) return "Docker has no free network ranges. Remove unused networks with `docker network prune`.";
  if (/no space left on device/i.test(message)) return "The disk is full. Run Clean up in Server settings or free some space.";
  if (/port is already allocated|address already in use/i.test(message)) return "A published host port is already used by another container.";
  if (/denied: requested access|unauthorized: authentication required|insufficient_scope/i.test(message))
    return "The registry refused access. Check that the token can push and pull, and that the repository name is right.";
  if (/pull access denied|manifest unknown|not found: manifest/i.test(message)) return "The image does not exist or needs registry credentials.";
  if (/Authentication failed|could not read Username|Repository not found/i.test(message)) return "The repository is private or the URL is wrong. Add a git provider token.";
  return null;
}

/* -------------------------------------------------------------------------- */
/*                                   Runner                                   */
/* -------------------------------------------------------------------------- */

/** What a deploy notification tells about the deployment: where the code came from, who started it, where it runs. */
async function deployDetails(deploymentId: string, serviceId: string) {
  const [row] = await db
    .select({
      trigger: schema.deployment.trigger,
      branch: schema.deployment.branch,
      commit: schema.deployment.commitSha,
      commitMessage: schema.deployment.commitMessage,
      author: schema.deployment.commitAuthor,
      image: schema.deployment.image,
      startedBy: schema.user.name,
    })
    .from(schema.deployment)
    .leftJoin(schema.user, eq(schema.deployment.createdBy, schema.user.id))
    .where(eq(schema.deployment.id, deploymentId));
  const domains = await db.select().from(schema.domain).where(eq(schema.domain.serviceId, serviceId));
  const live = domains.find((d) => d.primary && !d.redirectTo) ?? domains.find((d) => !d.redirectTo);
  return {
    trigger: row?.trigger ?? null,
    branch: row?.branch ?? null,
    commit: row?.commit ?? null,
    commitMessage: row?.commitMessage ?? null,
    author: row?.author ?? null,
    startedBy: row?.startedBy ?? null,
    image: row?.image ?? null,
    liveUrl: live ? `${live.https || live.tunnelId ? "https" : "http"}://${live.hostname}` : null,
  };
}

export async function runDeployment(deploymentId: string, signal?: AbortSignal) {
  const dep = await db.query.deployment.findFirst({ where: eq(schema.deployment.id, deploymentId) });
  if (dep?.status !== "queued") return;
  const service = await db.query.service.findFirst({ where: eq(schema.service.id, dep.serviceId) });
  if (!service) return;

  // A newer deployment is already waiting: skip this one.
  const newer = await db
    .select({ id: schema.deployment.id })
    .from(schema.deployment)
    .where(
      and(eq(schema.deployment.serviceId, service.id), eq(schema.deployment.status, "queued"), gt(schema.deployment.createdAt, dep.createdAt), ne(schema.deployment.id, dep.id)),
    )
    .limit(1);
  if (newer.length) {
    await setDeployment(dep.id, { status: "superseded", finishedAt: new Date(), logs: "Skipped: a newer deployment was queued.\n" });
    return;
  }

  const log = new DeployLogger(dep.id);
  const previousStatus = service.status;
  const startedAt = new Date();
  // The organization's builds-at-once limit: wait in the queue instead of failing. The check and
  // the claim are one step, so deploys starting together cannot all take the last slot.
  const organizationId = await orgIdOf(service);
  const slot = await claimBuildSlot(organizationId, dep.id, async (tx) => {
    // Only from the queue: a deployment cancelled in the meantime stays cancelled.
    const [claimed] = await tx
      .update(schema.deployment)
      .set({ status: "building", startedAt })
      .where(and(eq(schema.deployment.id, dep.id), eq(schema.deployment.status, "queued")))
      .returning({ id: schema.deployment.id });
    return !!claimed;
  });
  if (!slot) {
    await setDeployment(dep.id, { logs: "Waiting for a free build slot: this organization is at its limit of builds at once.\n" });
    const { enqueue } = await import("@/server/queue");
    await enqueue("deploy", { deploymentId: dep.id }, { concurrencyKey: `service:${service.id}`, runAt: new Date(Date.now() + 10_000) });
    return;
  }
  if (!slot.value) return;
  await setServiceStatus(service.id, "building");
  log.line(`Deployment ${dep.id} started (${dep.trigger})`);

  // A service whose move never finished (it failed, then was deployed again) still takes over from
  // the container it was made from.
  if (!dep.adopt && !service.currentDeploymentId) {
    const [moved] = await db
      .select({ adopt: schema.deployment.adopt })
      .from(schema.deployment)
      .where(and(eq(schema.deployment.serviceId, service.id), isNotNull(schema.deployment.adopt)))
      .orderBy(desc(schema.deployment.createdAt))
      .limit(1);
    if (moved?.adopt) {
      dep.adopt = moved.adopt;
      await setDeployment(dep.id, { adopt: moved.adopt });
    }
  }

  try {
    const server = await connectServer(service, log);
    await ensureNetwork(server.docker, server.network);
    // Certificates wait for the first deploy; asked for now, they are ready by the time traffic moves.
    if (!service.currentDeploymentId && service.type !== "database") await requestDomainCertificates(service, organizationId, log);
    if (service.type === "app") await deployApp(service, dep, log, server, signal);
    else if (service.type === "database") {
      await setDeployment(dep.id, { status: "deploying" });
      await deployDatabase(service, log, signal, dep.adopt ?? null);
      await db.update(schema.service).set({ currentDeploymentId: dep.id }).where(eq(schema.service.id, service.id));
    } else await deployCompose(service, dep, log, server, signal);

    // A container moved in from a git build: it ran as it was; deploys build from the repository from now on.
    if (dep.adopt?.git && service.type === "app") {
      const fresh = await db.query.service.findFirst({ where: eq(schema.service.id, service.id) });
      if (fresh) {
        const { detectPort: _keep, pullPolicy: _pull, ...runtime } = fresh.runtime;
        await db
          .update(schema.service)
          .set({ source: { type: "git", ...dep.adopt.git }, build: { ...defaultBuild() }, runtime })
          .where(eq(schema.service.id, service.id));
        const { registerRepoWebhook } = await import("@/server/git/repo-webhooks");
        await registerRepoWebhook(service.id).catch(() => {});
        log.line(`From the next deployment on, it builds from ${dep.adopt.git.repository} (${dep.adopt.git.branch})`);
      }
    }

    // The settings it now runs with, read after the deploy: it saves some itself (a detected port,
    // the image's volumes, a compose file from git). Later changes show as waiting for a redeploy.
    const deployed = await db.query.service.findFirst({ where: eq(schema.service.id, service.id) });
    if (deployed) await setDeployment(dep.id, { configHash: await configFingerprint(deployed).catch(() => null) });

    const seconds = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
    log.step(`Deployed successfully in ${seconds}s`);
    await log.flush();
    await setDeployment(dep.id, { status: "success", finishedAt: new Date() });
    await logActivity({
      userId: dep.createdBy,
      action: "deploy.success",
      message: `Deployed ${service.name}`,
      targetType: "service",
      targetId: service.id,
      projectId: service.projectId,
    });
    // The clone (or a rollback) filled in the commit after `dep` was read.
    const [commit] = await db
      .select({ commitSha: schema.deployment.commitSha, commitMessage: schema.deployment.commitMessage })
      .from(schema.deployment)
      .where(eq(schema.deployment.id, dep.id));
    const { commitSha, commitMessage } = commit ?? dep;
    const details = await deployDetails(dep.id, service.id);
    // The containers that kept restarting are gone: the restart warning ends now, not at the next
    // check. If the new version restarts too, the check opens it again.
    const { openIncidentFor, resolveIncident } = await import("@/server/monitoring/incidents");
    if (await openIncidentFor(`crashloop:${service.id}`).catch(() => null)) {
      await resolveIncident(`crashloop:${service.id}`, {
        event: "service.recovered",
        title: `${service.name} stopped restarting`,
        body: "A new deployment replaced the restarting containers.",
        url: `/projects/${service.projectId}/services/${service.id}/logs`,
      }).catch(() => null);
    }
    void notify(await orgOfService(service.id), "deploy.success", {
      ok: true,
      title: `${service.name} deployed`,
      body: commitMessage ? `Commit: ${commitMessage}` : `Deployment finished in ${seconds}s.`,
      url: `/projects/${service.projectId}/services/${service.id}/deployments/${dep.id}`,
      status: "succeeded",
      serviceId: service.id,
      deploymentId: dep.id,
      dedupKey: `deploy:${service.id}`,
      data: { ...details, durationSeconds: Number(seconds), commit: commitSha ?? null, commitMessage: commitMessage ?? null },
    });
  } catch (thrown) {
    // A deploy the worker stopped for running too long failed; it was not cancelled by anyone.
    const timedOut = signal?.reason instanceof JobTimeout ? signal.reason : null;
    const error = timedOut ?? thrown;
    const cancelled = !timedOut && (error instanceof DeployCancelled || signal?.aborted);
    const output = (error as { output?: string }).output ?? "";
    // For failed commands, the useful part is the tail of their output.
    const tail = output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^#\d+ (sha256|DONE|CACHED|\[internal\])/.test(l))
      .slice(-6)
      .join("\n");
    // Command output and container logs can hold secrets: masked like the log itself.
    const message = log.scrub(error instanceof Error ? (tail ? `${error.message}\n${tail}` : error.message) : String(error));
    log.line("");
    log.line(cancelled ? "==> Deployment cancelled" : `==> Deployment failed: ${(error as Error).message ?? message}`);
    const hint = failureHint(message);
    if (hint && !cancelled) log.line(`Hint: ${hint}`);
    await log.flush();
    await setDeployment(dep.id, {
      status: cancelled ? "cancelled" : "failed",
      error: cancelled ? null : message.slice(0, 4000),
      finishedAt: new Date(),
    });
    // Keep the old version running if there is one.
    const server = await serverOf(service).catch(() => null);
    const running = server ? (await listServiceContainers(service.id, false, server.docker).catch(() => [])).length > 0 : false;
    // A status another step set while it waited (a move or start sets "deploying") must not stick.
    const settled = previousStatus === "building" || previousStatus === "deploying" || previousStatus === "restarting" ? "idle" : previousStatus;
    await setServiceStatus(service.id, running ? "running" : cancelled ? settled : "failed");
    if (!cancelled) {
      await logActivity({
        userId: dep.createdBy,
        action: "deploy.failed",
        message: `Deployment of ${service.name} failed`,
        targetType: "service",
        targetId: service.id,
        projectId: service.projectId,
      });
      void notify(await orgOfService(service.id), "deploy.failed", {
        ok: false,
        title: `${service.name} failed to deploy`,
        body: message.split("\n")[0].slice(0, 500),
        url: `/projects/${service.projectId}/services/${service.id}/deployments/${dep.id}`,
        status: "failed",
        error: message.slice(0, 2000),
        serviceId: service.id,
        deploymentId: dep.id,
        dedupKey: `deploy:${service.id}`,
        data: {
          ...(await deployDetails(dep.id, service.id)),
          durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
          keptPreviousVersion: running,
        },
      });
    }
  }
}

/**
 * A secret from a secret manager that could not be read stops the deploy before anything
 * changes: starting the app with an empty password or key is worse than keeping the old version.
 */
function stopOnFailedSecrets(env: { failedSecrets: string[] }) {
  if (!env.failedSecrets.length) return;
  throw new Error(
    `Could not read ${env.failedSecrets.length === 1 ? "a secret" : `${env.failedSecrets.length} secrets`} from a secret manager:\n${env.failedSecrets.map((f) => `  ${f}`).join("\n")}`,
  );
}
