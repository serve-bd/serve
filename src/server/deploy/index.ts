import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import type Docker from "dockerode";
import type { BuildConfig, PortMapping } from "@/server/services/types";
import { ensureNetwork, imageExists, LABEL, listServiceContainers, pullImage, removeContainer } from "@/server/docker/client";
import { serverOf, type ServerCtx } from "@/server/servers/context";
import { paths } from "@/server/paths";
import { syncServiceProxy } from "@/server/proxy/nginx";
import { getSettings } from "@/server/settings";
import { resolveEnv } from "@/server/services/variables";
import { composeVariables } from "@/lib/compose-vars";
import { networkAliases } from "@/lib/hostname";
import { parseCompose } from "@/server/deploy/compose";
import { engines } from "@/server/databases/engines";
import { logActivity } from "@/server/activity";
import { notify, orgOfService } from "@/server/notify";
import { buildImage } from "./builders";
import { cloneRepository } from "./git";
import { DeployLogger } from "./logger";
import { createSpec, startContainer, volumeName, waitHealthy } from "./containers";
import { prepareMounts } from "@/server/services/mounts";
import { databasePlan } from "@/server/databases/options";
import { ensureDatabaseTls } from "@/server/databases/tls";
import { allocateSubnet, composeServiceNames, composeUp, stackNetworkName, transformCompose, writeComposeFiles } from "./compose";
import type { ServiceStatus } from "@/server/db/schema";
import { composeSecurityIssues, containedPath } from "@/server/security";
import { connectProxy, disconnectProxy, ensureEnvNetwork } from "@/server/docker/networks";
import { getSetting } from "@/server/settings";

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

async function prepareAppImage(service: Service, dep: Deployment, log: DeployLogger, server: ServerCtx, signal?: AbortSignal) {
  const target = `${imageRepo(service.slug)}:${dep.id}`;
  const d = server.docker;

  if (dep.rollbackOf) {
    const [original] = await db.select().from(schema.deployment).where(eq(schema.deployment.id, dep.rollbackOf));
    if (!original?.image) throw new Error("The image for that deployment was cleaned up and can no longer be restored.");
    if (!(await imageExists(original.image, d))) {
      throw new Error(
        server.local
          ? "The image for that deployment was cleaned up and can no longer be restored."
          : `The image for that deployment is not on ${server.name}. It was built on another server or cleaned up. Redeploy instead.`,
      );
    }
    log.step(`Rolling back to deployment ${original.id.slice(0, 8)}`);
    await setDeployment(dep.id, {
      commitSha: original.commitSha,
      commitMessage: original.commitMessage,
      commitAuthor: original.commitAuthor,
      branch: original.branch,
    });
    return { image: original.image, detectedPort: null as number | null };
  }

  const source = service.source;
  if (!source) throw new Error("This service has no source configured.");

  if (source.type === "image") {
    log.step(`Pulling ${source.image}`);
    const password = decryptOrNull(source.registryPassword);
    const auth =
      source.registryUsername && password
        ? { username: source.registryUsername, password, serveraddress: registryOf(source.image) }
        : null;
    await pullImage(source.image, log.line, auth, d);
    checkCancelled(signal);
    const ref = source.image.includes(":") || source.image.includes("@") ? source.image : `${source.image}:latest`;
    await d.getImage(ref).tag({ repo: imageRepo(service.slug), tag: dep.id });
    return { image: target, detectedPort: await imagePort(target, d) };
  }

  // Git source: clone and build.
  const env = await resolveEnv(service);
  log.redact(env.secrets);
  const workDir = path.join(paths.builds, dep.id);
  const build: BuildConfig = { ...service.build!, noCache: service.build?.noCache || service.build?.noCacheOnce };
  if (service.build?.noCacheOnce) {
    // One-shot "build without cache": consume the flag so later deploys use the cache again.
    await db.update(schema.service).set({ build: { ...service.build, noCacheOnce: false } }).where(eq(schema.service.id, service.id));
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
    return { image: target, detectedPort: result.detectedPort ?? (await imagePort(target, d)) };
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

async function deployApp(service: Service, dep: Deployment, log: DeployLogger, server: ServerCtx, signal?: AbortSignal) {
  const d = server.docker;
  const { image, detectedPort } = await prepareAppImage(service, dep, log, server, signal);
  await setDeployment(dep.id, { image, status: "deploying" });
  await setServiceStatus(service.id, "deploying");
  checkCancelled(signal);

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

  if (runtime.preDeployCommand && dep.rollbackOf) log.line("Skipping the pre-deploy command for a rollback");
  if (runtime.preDeployCommand && !dep.rollbackOf) {
    // Runs before the old version stops, so a failing migration never takes the app down.
    log.step("Running the pre-deploy command");
    await runPreDeploy({ service, dep, image, env: env.runtime, runtime, network, d, log, signal, serviceDir: server.paths.service(service.id) });
    checkCancelled(signal);
  }

  if (needsStopFirst && old.length) {
    log.line(recreate ? "Stopping the previous version first (recreate strategy)" : "Stopping the previous version first because host ports are published");
    const stopWait = runtime.stopTimeout ?? 10;
    for (const c of old) await d.getContainer(c.Id).stop({ t: stopWait }).catch(() => {});
  }
  log.step(`Starting ${replicas} container${replicas > 1 ? "s" : ""}`);
  const started: string[] = [];
  try {
    for (let i = 0; i < replicas; i++) {
      const name = `${service.slug}-${dep.id.slice(0, 6)}-${i + 1}`;
      await removeContainer(name, 0, d);
      const container = await startContainer({
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
      }, server);
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
      for (const c of old) await d.getContainer(c.Id).start().catch(() => {});
    }
    throw error;
  }

  // Switch traffic.
  await db
    .update(schema.service)
    .set({ currentDeploymentId: dep.id, status: "running" })
    .where(eq(schema.service.id, service.id));
  log.step("Routing traffic");
  try {
    await syncServiceProxy(service.id);
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
  await pruneImages(service, d).catch(() => {});
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
  log: DeployLogger;
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
        (x) =>
          x.PublicPort === p.host &&
          x.Type === p.protocol &&
          (x.IP === "0.0.0.0" || x.IP === "::" || !p.bindAddress || p.bindAddress === "0.0.0.0" || x.IP === p.bindAddress),
      ),
    );
    if (holder) {
      const name = holder.Names[0]?.replace(/^\//, "") ?? holder.Id.slice(0, 12);
      throw new Error(`Port ${p.host} is already used by the container ${name} on ${serverName}. Choose another port in Domains & ports.`);
    }
  }
}

/** Keep the newest N images per service for rollbacks. */
async function pruneImages(service: Service, d: Docker) {
  const settings = await getSettings();
  const keep = await db
    .select({ image: schema.deployment.image })
    .from(schema.deployment)
    .where(and(eq(schema.deployment.serviceId, service.id), eq(schema.deployment.status, "success")))
    .orderBy(desc(schema.deployment.createdAt))
    .limit(settings.imageRetention + 1);
  const keepSet = new Set(keep.map((k) => k.image).filter(Boolean));
  const images = await d.listImages({ filters: { reference: [`${imageRepo(service.slug)}:*`] } });
  for (const img of images) {
    const tags = img.RepoTags ?? [];
    if (tags.some((t) => keepSet.has(t))) continue;
    for (const tag of tags) await d.getImage(tag).remove().catch(() => {});
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
  const container = await startContainer({
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
  }, server);
  line(`Volume ${volumeName(service.slug, "data")} mounted at ${plan.dataMountPath}`);
  log?.step("Waiting for the database to accept connections");
  await waitHealthy(container.id, { ...service.runtime, port: null, healthcheckTimeout: Math.max(180, plan.health.startPeriod + plan.health.interval * plan.health.retries + 30) }, line, signal, network, server);
  line(`${engine.label} is ready`);
  await setServiceStatus(service.id, "running");
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
    // Compose files from git are checked at deploy time; only the Root organization may use host-level options.
    const issues = composeSecurityIssues(content);
    if (issues.length && (await orgIdOf(service)) !== (await getSetting("rootOrganizationId"))) {
      throw new Error(`The compose file uses options that can access the host: ${issues.slice(0, 3).join("; ")}`);
    }
    // Remember the file so the UI can show services and ports.
    await db
      .update(schema.service)
      .set({ compose: { ...cfg, content } })
      .where(eq(schema.service.id, service.id));
  }
  checkCancelled(signal);

  // Docker Compose silently turns an unset ${VAR} into an empty string, which fails later in
  // confusing ways (a database without a password never becomes healthy). Stop here instead.
  const unset = composeVariables(content).filter((v) => !v.hasDefault && !(v.name in env.runtime));
  if (unset.length) {
    const names = unset.map((v) => v.name).join(", ");
    throw new Error(`The compose file uses ${unset.length === 1 ? "a variable that is" : "variables that are"} not set: ${names}. Add ${unset.length === 1 ? "it" : "them"} in Variables (an empty value is fine if that is intended), then deploy again.`);
  }
  // postgres:18+ keeps its data in /var/lib/postgresql and refuses to start with the old mount.
  for (const [name, svc] of Object.entries(parseCompose(content).services ?? {})) {
    const image = String((svc as { image?: string }).image ?? "");
    const major = Number(/^(?:docker\.io\/)?(?:library\/)?postgres:(\d+)/.exec(image)?.[1] ?? (/^(?:docker\.io\/)?(?:library\/)?postgres(:latest|:alpine)?$/.test(image) ? 99 : 0));
    const mounts = ((svc as { volumes?: unknown[] }).volumes ?? []).map((v) => (typeof v === "string" ? v.split(":")[1] : (v as { target?: string })?.target));
    if (major >= 18 && mounts.includes("/var/lib/postgresql/data")) {
      throw new Error(`Service ${name} runs ${image}, which stores its data in /var/lib/postgresql. Change the volume target from /var/lib/postgresql/data to /var/lib/postgresql, then deploy again.`);
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
    await db.update(schema.service).set({ compose: { ...(fresh?.compose ?? cfg), subnet } }).where(eq(schema.service.id, service.id));
  }
  const network = await ensureEnvNetwork(service.environmentId, server);
  await assertPortsFree(server.docker, server.name, service.compose?.ports ?? [], service.id);
  const isolated = !!service.compose?.isolated;
  const transformed = transformCompose(content, service.slug, service.id, subnet, network, service.compose?.ports ?? [], isolated);
  // Compose may recreate the stack network; the proxy must not hold it while that happens.
  await disconnectProxy(stackNetworkName(service.slug), server).catch(() => {});
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
  await composeUp(target);
  // Isolated stacks are not on the environment network; the proxy joins the stack's own one.
  if (isolated) await connectProxy(stackNetworkName(service.slug), server);
  await db
    .update(schema.service)
    .set({ currentDeploymentId: dep.id, status: "running" })
    .where(eq(schema.service.id, service.id));
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
  const server = await serverOf(service);
  if (server.local) return server;
  const status = server.row.status;
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
      and(
        eq(schema.deployment.serviceId, service.id),
        eq(schema.deployment.status, "queued"),
        gt(schema.deployment.createdAt, dep.createdAt),
        ne(schema.deployment.id, dep.id),
      ),
    )
    .limit(1);
  if (newer.length) {
    await setDeployment(dep.id, { status: "superseded", finishedAt: new Date(), logs: "Skipped: a newer deployment was queued.\n" });
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
    await setServiceStatus(
      service.id,
      running ? "running" : cancelled ? (previousStatus === "building" ? "idle" : previousStatus) : "failed",
    );
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
      });
    }
  }
}
