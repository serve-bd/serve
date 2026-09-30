import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import type Docker from "dockerode";
import type { BuildConfig, PortMapping } from "@/server/services/types";
import { ensureNetwork, imageExists, LABEL, listServiceContainers, pullImage, removeContainer } from "@/server/docker/client";
import { forgetServer, getServer, serverOf, type ServerCtx } from "@/server/servers/context";
import { paths } from "@/server/paths";
import { buildSlotFree } from "@/server/limits";
import { syncServiceProxy } from "@/server/proxy/nginx";
import { resolveEnv } from "@/server/services/variables";
import { composeVariables } from "@/lib/compose-vars";
import { networkAliases } from "@/lib/hostname";
import { parseCompose } from "@/server/deploy/compose";
import { engines } from "@/server/databases/engines";
import { logActivity } from "@/server/activity";
import { notify, orgOfService } from "@/server/notify";
import { buildImage } from "./builders";
import { cloneRepository } from "./git";
import { DeployLogger, type StepLog } from "./logger";
import { distributionProblem, normalizeDistribution, type Distribution } from "./distribution";
import { getRegistry, pushImage, registryAuth, type RegistryRow } from "@/server/registries";
import { defaultRepository, imageRef, normalizeRepository, renderTag } from "@/server/registries/refs";
import type { DeploymentTarget } from "@/server/services/types";
import { createSpec, startContainer, volumeName, waitHealthy } from "./containers";
import { prepareMounts } from "@/server/services/mounts";
import { databasePlan } from "@/server/databases/options";
import { ensureDatabaseTls } from "@/server/databases/tls";
import { allocateSubnet, composeServiceNames, composeUp, stackNetworkName, transformCompose, writeComposeFiles } from "./compose";
import type { ServiceStatus } from "@/server/db/schema";
import { composeSecurityIssues, containedPath } from "@/server/security";
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
async function prepareAppImage(service: Service, dep: Deployment, log: DeployLogger, server: ServerCtx, signal?: AbortSignal): Promise<PreparedImage> {
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

  if (source.type === "image") {
    log.step(`Pulling ${source.image}`);
    const password = decryptOrNull(source.registryPassword);
    const auth = source.registryUsername && password ? { username: source.registryUsername, password, serveraddress: registryOf(source.image) } : null;
    await pullImage(source.image, log.line, auth, d);
    checkCancelled(signal);
    const ref = source.image.includes(":") || source.image.includes("@") ? source.image : `${source.image}:latest`;
    await d.getImage(ref).tag({ repo: imageRepo(service.slug), tag: dep.id });
    return { image: target, detectedPort: await imagePort(target, d), registryImage: null, rollback: false };
  }

  // Git source: clone and build.
  const env = await resolveEnv(service);
  log.redact(env.secrets);
  const workDir = path.join(paths.builds, dep.id);
  const build: BuildConfig = { ...service.build!, noCache: service.build?.noCache || service.build?.noCacheOnce };
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
  try {
    log.step("Cloning repository");
    if (build.noCache) log.line("Building without cache");
    const clone = await cloneRepository(source, workDir, log.line, buildSignal, await orgIdOf(service), { submodules: build.submodules });
    await setDeployment(dep.id, {
      commitSha: clone.commitSha,
      commitMessage: clone.commitMessage,
      commitAuthor: clone.commitAuthor,
      branch: source.branch,
    });
    checkCancelled(signal);

    const contextDir = containedPath(workDir, build.rootDir || "/", "Root directory");
    containedPath(contextDir, build.dockerfile || "Dockerfile", "Dockerfile path");
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
      labels: { [LABEL.managed]: "true", [LABEL.service]: service.id, [LABEL.deployment]: dep.id },
      log: log.line,
      signal: buildSignal,
      redact: env.secrets,
      dockerEnv: await server.cliEnv(),
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

async function orgIdOf(service: Service) {
  const [row] = await db.select({ organizationId: schema.project.organizationId }).from(schema.project).where(eq(schema.project.id, service.projectId));
  return row?.organizationId ?? null;
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
    await pullImage(prepared.registryImage, log.line, registry ? registryAuth(registry) : null, d);
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
    log.line(`Pulling ${source.image}`);
    const password = decryptOrNull(source.registryPassword);
    const auth = source.registryUsername && password ? { username: source.registryUsername, password, serveraddress: registryOf(source.image) } : null;
    await pullImage(source.image, log.line, auth, d);
    const ref = source.image.includes(":") || source.image.includes("@") ? source.image : `${source.image}:latest`;
    await d.getImage(ref).tag({ repo, tag });
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

async function deployApp(service: Service, dep: Deployment, log: DeployLogger, server: ServerCtx, signal?: AbortSignal) {
  const dist = normalizeDistribution(service.serverId, service.distribution);
  const sourceType = service.source?.type;
  const problem = distributionProblem(dist, sourceType);
  if (problem) throw new Error(problem);
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
  const buildServer = sourceType === "git" && dist.buildServerId && !dep.rollbackOf ? await connectTo(dist.buildServerId, log, "build") : server;
  const prepared = await prepareAppImage(service, dep, log, buildServer, signal);
  checkCancelled(signal);
  const { image, detectedPort } = prepared;
  if (registry && sourceType === "git" && !prepared.rollback) {
    prepared.registryImage = await pushToRegistry(service, dep, dist, registry, image, buildServer, log, signal);
    await setDeployment(dep.id, { registryImage: prepared.registryImage });
    checkCancelled(signal);
  }
  await setDeployment(dep.id, { image, status: "deploying" });
  await setServiceStatus(service.id, "deploying");

  // Fill in the port if it was never configured.
  let runtime = service.runtime;
  if (!runtime.port && detectedPort) {
    runtime = { ...runtime, port: detectedPort };
    await db.update(schema.service).set({ runtime }).where(eq(schema.service.id, service.id));
    log.line(`Using detected port ${detectedPort}`);
  }

  const env = await resolveEnv({ ...service, runtime });
  log.redact(env.secrets);
  if (env.missing.length) log.line(`Warning: unresolved variable references: ${env.missing.join(", ")}`);

  // The service's own server first: its failure fails the deployment and keeps the old version everywhere.
  const primaryTarget = targets[0];
  primaryTarget.status = "deploying";
  await saveTargets();
  try {
    if (multi) log.step(`Deploying to ${server.name}`);
    await ensureImageOn(server, service, prepared, registry, log);
    await runOnServer({ service, dep, log, server, image, runtime, env, signal, primary: true });
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
        await runOnServer({ service, dep, log: slog, server: extra, image, runtime, env, signal, primary: false });
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
  if (buildServer.id !== server.id && !extras.some((e) => e.id === buildServer.id)) await pruneImages(service, buildServer).catch(() => {});
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
}) {
  const { service, dep, log, server, image, runtime, env, signal, primary } = opts;
  const d = server.docker;
  const old = (await listServiceContainers(service.id, true, d)).filter((c) => c.Labels[LABEL.deployment] !== dep.id);
  const replicas = Math.max(1, Math.min(runtime.replicas || 1, 20));
  const recreate = runtime.deployStrategy === "recreate";
  const needsStopFirst = runtime.ports.length > 0 || recreate;
  if (runtime.ports.length) {
    // Fail before touching the running version when another container holds a port.
    await assertPortsFree(d, server.name, runtime.ports, service.id);
  }

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
    await runPreDeploy({ service, dep, image, env: env.runtime, runtime, network, d, log, signal, serviceDir: server.paths.service(service.id) });
    checkCancelled(signal);
  }

  if (needsStopFirst && old.length) {
    log.line(recreate ? "Stopping the previous version first (recreate strategy)" : "Stopping the previous version first because host ports are published");
    const stopWait = runtime.stopTimeout ?? 10;
    for (const c of old)
      await d
        .getContainer(c.Id)
        .stop({ t: stopWait })
        .catch(() => {});
  }
  log.step(`Starting ${replicas} container${replicas > 1 ? "s" : ""}`);
  const started: string[] = [];
  try {
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
          env: env.runtime,
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
  } catch (error) {
    for (const id of started) await removeContainer(id, 0, d);
    if (needsStopFirst && old.length) {
      // Bring the previous version back so a failed deploy does not take the app down.
      log.line("Restarting the previous version");
      for (const c of old)
        await d
          .getContainer(c.Id)
          .start()
          .catch(() => {});
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

  if (old.length && !needsStopFirst) {
    const drain = runtime.drainSeconds ?? 3;
    log.line(`Draining ${old.length} old container${old.length > 1 ? "s" : ""}${drain ? ` for ${drain}s` : ""}`);
    if (drain) await new Promise((r) => setTimeout(r, drain * 1000));
    await Promise.all(old.map((c) => removeContainer(c.Id, runtime.stopTimeout ?? 15, d)));
  } else if (old.length) {
    await Promise.all(old.map((c) => removeContainer(c.Id, 0, d)));
  }
  await pruneImages(service, server).catch(() => {});
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
  try {
    await container.start();
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
      new Promise((_, reject) => setTimeout(() => reject(new Error("The pre-deploy command timed out.")), timeoutMs)),
      new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(new DeployCancelled("Deployment cancelled")))),
    ])) as { StatusCode: number };
    await new Promise((r) => setTimeout(r, 200));
    if (partial) log.line(partial);
    if (result.StatusCode !== 0) throw new Error(`The pre-deploy command exited with code ${result.StatusCode}. The previous version keeps running.`);
    log.line("Pre-deploy command finished");
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

/** Throws a clear error when another container already publishes one of the ports. */
async function assertPortsFree(d: Docker, serverName: string, ports: PortMapping[], serviceId: string) {
  if (!ports.length) return;
  const others = (await d.listContainers()).filter((c) => c.Labels[LABEL.service] !== serviceId);
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

/** Keep the newest N images per service for rollbacks; N is set per server. */
async function pruneImages(service: Service, server: ServerCtx) {
  const d = server.docker;
  const keep = await db
    .select({ image: schema.deployment.image })
    .from(schema.deployment)
    .where(and(eq(schema.deployment.serviceId, service.id), eq(schema.deployment.status, "success")))
    .orderBy(desc(schema.deployment.createdAt))
    .limit(Math.max(1, server.row.imageRetention) + 1);
  const keepSet = new Set(keep.map((k) => k.image).filter(Boolean));
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

export async function deployDatabase(service: Service, log: DeployLogger | null, signal?: AbortSignal) {
  const server = await serverOf(service);
  const d = server.docker;
  const cfg = service.database!;
  const engine = engines[cfg.engine];
  const serviceDir = server.paths.service(service.id);
  const plan = databasePlan(cfg, decryptOrNull(cfg.password) ?? "", serviceDir);
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
    line(`TLS on (${cfg.tls?.mode === "require" ? "required" : "optional"} for clients)`);
  }
  const extra = service.runtime.volumes ?? [];
  if (extra.some((v) => v.kind !== "volume")) await prepareMounts(server, service.id, extra, line);

  log?.step("Starting database");
  await ensureNetwork(d, server.network);
  const network = await ensureEnvNetwork(service.environmentId, server);
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
        volumes: [{ kind: "volume", source: "data", mountPath: plan.dataMountPath }, ...extra.filter((v) => !(v.kind === "volume" && v.source === "data"))],
        ports: cfg.publicPort ? [{ host: cfg.publicPort, container: engine.port, protocol: "tcp", bindAddress: cfg.publicBind }] : [],
        healthcheckPath: null,
        healthcheckTimeout: 180,
      },
      aliases: networkAliases(service),
      network,
    },
    server,
  );
  line(`Volume ${volumeName(service.slug, "data")} mounted at ${plan.dataMountPath}`);
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
  await setServiceStatus(service.id, "running");
  await meshAfterStart(server.id, line);
}

/* -------------------------------------------------------------------------- */
/*                                  Compose                                   */
/* -------------------------------------------------------------------------- */

async function deployCompose(service: Service, dep: Deployment, log: DeployLogger, server: ServerCtx, signal?: AbortSignal) {
  const cfg = service.compose!;
  const env = await resolveEnv(service);
  log.redact(env.secrets);
  const serviceDir = paths.service(service.id);
  let dir = path.join(serviceDir, "compose");
  let content = cfg.content;

  if (cfg.mode === "git") {
    if (service.source?.type !== "git") throw new Error("Compose from git needs a git source.");
    log.step("Cloning repository");
    const repoDir = path.join(serviceDir, "repo");
    const clone = await cloneRepository(service.source, repoDir, log.line, signal, await orgIdOf(service));
    await setDeployment(dep.id, {
      commitSha: clone.commitSha,
      commitMessage: clone.commitMessage,
      commitAuthor: clone.commitAuthor,
      branch: service.source.branch,
    });
    const composePath = containedPath(repoDir, cfg.path, "Compose file path");
    // Resolve symlinks so a link in the repository cannot point at files on the server.
    const realRepo = await fs.realpath(repoDir);
    const realCompose = await fs.realpath(composePath).catch(() => composePath);
    if (realCompose !== realRepo && !realCompose.startsWith(realRepo + path.sep)) {
      throw new Error(`Compose file ${cfg.path} points outside the repository.`);
    }
    content = await fs.readFile(composePath, "utf8").catch(() => {
      throw new Error(`Compose file ${cfg.path} not found in the repository.`);
    });
    dir = path.dirname(composePath);
    // Remember the file so the UI can show services and ports.
    await db
      .update(schema.service)
      .set({ compose: { ...cfg, content } })
      .where(eq(schema.service.id, service.id));
  }
  // Checked at every deploy, for files from git and files saved before a rule existed: only the
  // Root organization may use host-level options or reach into Serve's own networks.
  const issues = composeSecurityIssues(content);
  if (issues.length && (await orgIdOf(service)) !== (await getSetting("rootOrganizationId"))) {
    throw new Error(`The compose file uses options only services of the Root organization may use: ${issues.slice(0, 3).join("; ")}`);
  }
  checkCancelled(signal);

  // Docker Compose silently turns an unset ${VAR} into an empty string, which fails later in
  // confusing ways (a database without a password never becomes healthy). Stop here instead.
  const unset = composeVariables(content).filter((v) => !v.hasDefault && !(v.name in env.runtime));
  if (unset.length) {
    const names = unset.map((v) => v.name).join(", ");
    throw new Error(
      `The compose file uses ${unset.length === 1 ? "a variable that is" : "variables that are"} not set: ${names}. Add ${unset.length === 1 ? "it" : "them"} in Variables (an empty value is fine if that is intended), then deploy again.`,
    );
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
    const others = await db.select({ compose: schema.service.compose }).from(schema.service).where(eq(schema.service.type, "compose"));
    subnet = await allocateSubnet(others.map((o) => o.compose?.subnet).filter(Boolean) as string[], server);
    const [fresh] = await db.select({ compose: schema.service.compose }).from(schema.service).where(eq(schema.service.id, service.id));
    await db
      .update(schema.service)
      .set({ compose: { ...(fresh?.compose ?? cfg), subnet } })
      .where(eq(schema.service.id, service.id));
  }
  const network = await ensureEnvNetwork(service.environmentId, server);
  await assertPortsFree(server.docker, server.name, service.compose?.ports ?? [], service.id);
  const isolated = !!service.compose?.isolated;
  if (!isolated) await meshBeforeStart(service, server.id, log.line);
  const transformed = transformCompose(content, service.slug, service.id, subnet, network, service.compose?.ports ?? [], isolated);
  // The stack's own network: named in the file, or compose's <project>_default.
  const declared = (parseCompose(transformed).networks as Record<string, { name?: string } | null> | undefined)?.default?.name;
  const stackNet = declared || stackNetworkName(service.slug);
  // Compose may recreate the stack network; the proxy must not hold it while that happens.
  await disconnectProxy(stackNet, server).catch(() => {});
  const run = { projectName: service.slug, dir, file: ".serve-compose.yml", vars: env.runtime, log: log.line, signal, redact: env.secrets };
  await writeComposeFiles({ ...run, content: transformed });
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
    await server.fs.uploadDir(uploadRoot, remoteRoot);
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

  // The organization's builds-at-once limit: wait in the queue instead of failing.
  const organizationId = await orgIdOf(service);
  if (organizationId && !(await buildSlotFree(organizationId, dep.id))) {
    await setDeployment(dep.id, { logs: "Waiting for a free build slot: this organization is at its limit of builds at once.\n" });
    const { enqueue } = await import("@/server/queue");
    await enqueue("deploy", { deploymentId: dep.id }, { concurrencyKey: `service:${service.id}`, runAt: new Date(Date.now() + 10_000) });
    return;
  }

  const log = new DeployLogger(dep.id);
  const previousStatus = service.status;
  const startedAt = new Date();
  await setDeployment(dep.id, { status: "building", startedAt });
  await setServiceStatus(service.id, "building");
  log.line(`Deployment ${dep.id} started (${dep.trigger})`);

  try {
    const server = await connectServer(service, log);
    await ensureNetwork(server.docker, server.network);
    if (service.type === "app") await deployApp(service, dep, log, server, signal);
    else if (service.type === "database") {
      await setDeployment(dep.id, { status: "deploying" });
      await deployDatabase(service, log, signal);
      await db.update(schema.service).set({ currentDeploymentId: dep.id }).where(eq(schema.service.id, service.id));
    } else await deployCompose(service, dep, log, server, signal);

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
    void notify(await orgOfService(service.id), "deploy.success", {
      ok: true,
      title: `${service.name} deployed`,
      body: dep.commitMessage ? `Commit: ${dep.commitMessage}` : `Deployment finished in ${seconds}s.`,
      url: `/projects/${service.projectId}/services/${service.id}/deployments/${dep.id}`,
      status: "succeeded",
      serviceId: service.id,
      deploymentId: dep.id,
      dedupKey: `deploy:${service.id}`,
      data: { durationSeconds: seconds, commit: dep.commitSha ?? null, commitMessage: dep.commitMessage ?? null },
    });
  } catch (error) {
    const cancelled = error instanceof DeployCancelled || signal?.aborted;
    const output = (error as { output?: string }).output ?? "";
    // For failed commands, the useful part is the tail of their output.
    const tail = output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^#\d+ (sha256|DONE|CACHED|\[internal\])/.test(l))
      .slice(-6)
      .join("\n");
    const message = error instanceof Error ? (tail ? `${error.message}\n${tail}` : error.message) : String(error);
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
    await setServiceStatus(service.id, running ? "running" : cancelled ? (previousStatus === "building" ? "idle" : previousStatus) : "failed");
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
        data: { keptPreviousVersion: running },
      });
    }
  }
}
