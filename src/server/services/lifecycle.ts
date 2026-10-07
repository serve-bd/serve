import { replicaInstances } from "@/server/services/types";
import path from "node:path";
import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { runServerIds } from "@/server/deploy/distribution";
import type { ServiceStatus } from "@/server/db/schema";
import { LABEL, listServiceContainers, removeContainer } from "@/server/docker/client";
import { getServer, serversOfService, type ServerCtx } from "@/server/servers/context";
import { paths } from "@/server/paths";
import { removeServiceProxy, syncServiceProxy } from "@/server/proxy/nginx";
import { composeDownByProject } from "@/server/deploy/compose";
import { deployDatabase, setServiceStatus } from "@/server/deploy";
import { dockerRestartPolicy, volumeName } from "@/server/deploy/containers";

async function getService(id: string) {
  const service = await db.query.service.findFirst({ where: eq(schema.service.id, id) });
  if (!service) throw new Error("Service not found");
  return service;
}

type Service = Awaited<ReturnType<typeof getService>>;

/** Containers of the service's current version on one server (apps), or all of them (compose, databases). */
async function relevantOn(service: Service, server: ServerCtx) {
  const containers = await listServiceContainers(service.id, true, server.docker);
  if (service.type !== "app") return containers;
  const current = containers.filter((c) => c.Labels[LABEL.deployment] === service.currentDeploymentId);
  // An extra server whose last deploy failed still runs its previous version.
  if (!current.length && server.id !== service.serverId) return containers.filter((c) => c.Labels[LABEL.kind] !== "predeploy");
  return current;
}

/** An app replica the crash limit stopped has restart policy "no": starting the service puts its own back. */
async function restorePolicy(service: Service, target: ServerCtx, containerId: string) {
  if (service.type !== "app") return;
  await target.docker
    .getContainer(containerId)
    .update({ RestartPolicy: dockerRestartPolicy(service.runtime.restartPolicy) })
    .catch(() => {});
}

/** Extra servers are best effort: one that is offline must not block the others. */
async function onExtras(service: Service, fn: (server: ServerCtx) => Promise<void>) {
  const [, ...extras] = await serversOfService(service);
  // A database's read replicas on other servers stop, start and restart with it.
  const replicaServers = replicaInstances(service)
    .map((r) => r.serverId)
    .filter((id) => id !== service.serverId && !extras.some((e) => e.id === id));
  const more = await Promise.all([...new Set(replicaServers)].map((id) => getServer(id).catch(() => null)));
  await Promise.allSettled([...extras, ...more.filter((m): m is ServerCtx => !!m)].map(fn));
}

/**
 * A start, stop or restart that failed part way (an offline server, a database that did not come up)
 * must not leave the status the request set before it was queued ("deploying", "restarting", "stopped").
 */
async function settleOnError<T>(serviceId: string, pending: ServiceStatus[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const service = await db.query.service.findFirst({ where: eq(schema.service.id, serviceId) }).catch(() => null);
    if (service && pending.includes(service.status)) {
      const server = await getServer(service.serverId).catch(() => null);
      const running = server ? await listServiceContainers(service.id, false, server.docker).catch(() => null) : null;
      // Not known (the server is offline): a stop keeps its status, a start or restart did not happen.
      await setServiceStatus(service.id, running?.length ? "running" : service.status === "stopped" ? "stopped" : "crashed").catch(() => {});
    }
    throw error;
  }
}

export async function stopService(serviceId: string) {
  return settleOnError(serviceId, ["stopped"], () => stopNow(serviceId));
}

async function stopNow(serviceId: string) {
  const service = await getService(serviceId);
  const stop = async (server: ServerCtx) => {
    const containers = await listServiceContainers(service.id, true, server.docker);
    await Promise.all(
      containers.map((c) =>
        server.docker
          .getContainer(c.Id)
          .stop({ t: 15 })
          .catch(() => {}),
      ),
    );
  };
  await stop(await getServer(service.serverId));
  await onExtras(service, stop);
  await setServiceStatus(service.id, "stopped");
  await syncServiceProxy(service.id).catch(() => {});
}

export async function startService(serviceId: string): Promise<"started" | "needs-deploy"> {
  return settleOnError(serviceId, ["deploying"], () => startNow(serviceId));
}

async function startNow(serviceId: string): Promise<"started" | "needs-deploy"> {
  const service = await getService(serviceId);
  const server = await getServer(service.serverId);
  const relevant = await relevantOn(service, server);
  if (!relevant.length) {
    if (service.type === "database") {
      await setServiceStatus(service.id, "deploying");
      await deployDatabase(service, null);
      return "started";
    }
    return "needs-deploy";
  }
  const failed: string[] = [];
  const start = async (target: ServerCtx) => {
    const containers = target.id === server.id ? relevant : await relevantOn(service, target);
    await Promise.all(
      containers.map(async (c) => {
        await restorePolicy(service, target, c.Id);
        await target.docker
          .getContainer(c.Id)
          .start()
          .catch((error: Error & { statusCode?: number }) => {
            // 304: already running.
            if (error.statusCode !== 304 && target.id === server.id) failed.push(error.message);
          });
      }),
    );
  };
  await start(server);
  await onExtras(service, start);
  if (failed.length === relevant.length) {
    await setServiceStatus(service.id, "crashed");
    throw new Error(`The service could not be started: ${failed[0]}`);
  }
  await setServiceStatus(service.id, "running");
  await syncServiceProxy(service.id).catch(() => {});
  return "started";
}

export async function restartService(serviceId: string) {
  return settleOnError(serviceId, ["restarting", "deploying"], () => restartNow(serviceId));
}

async function restartNow(serviceId: string) {
  const service = await getService(serviceId);
  const server = await getServer(service.serverId);
  const relevant = await relevantOn(service, server);
  // Containers removed outside Serve: recreate what can be recreated.
  if (!relevant.length) {
    if (service.type === "database") {
      await setServiceStatus(service.id, "deploying");
      await deployDatabase(service, null);
      return;
    }
    await setServiceStatus(service.id, "crashed");
    throw new Error("No containers exist for this service. Deploy it again.");
  }
  await setServiceStatus(service.id, "restarting");
  const restart = async (target: ServerCtx) => {
    const containers = target.id === server.id ? relevant : await relevantOn(service, target);
    await Promise.all(
      containers.map(async (c) => {
        await restorePolicy(service, target, c.Id);
        await target.docker
          .getContainer(c.Id)
          .restart({ t: 10 })
          .catch(() => {});
      }),
    );
  };
  await restart(server);
  await onExtras(service, restart);
  await setServiceStatus(service.id, "running");
  await syncServiceProxy(service.id).catch(() => {});
}

/** Queue of the cleanup on a server an app was taken off (apart from the app's own deploys). */
export const extraCleanupKey = (serviceId: string, serverId: string) => `service:${serviceId}@${serverId}`;

/** How long a cleanup on a server an app left waits for that server (it may be gone for good). */
const EXTRA_CLEANUP_MS = 120_000;

export async function destroyService(opts: Parameters<typeof destroyOnServer>[0]) {
  if (!opts.extraCleanup) return destroyOnServer(opts);
  // Ticked again since: the next deploy runs it there, and this must not remove those replicas.
  const [row] = await db.select({ serverId: schema.service.serverId, distribution: schema.service.distribution }).from(schema.service).where(eq(schema.service.id, opts.serviceId));
  if (row && runServerIds(row.serverId, row.distribution).includes(opts.serverId ?? "")) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      destroyOnServer(opts),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The server did not answer. Its containers of this app stay until it is back and cleaned up.")), EXTRA_CLEANUP_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function destroyOnServer(opts: {
  serviceId: string;
  slug: string;
  type: string;
  removeVolumes: boolean;
  environmentId?: string;
  /** Server the service ran on (the row is already deleted). */
  serverId?: string;
  /** Keep the service's local files (used when a service moves to another server). */
  keepFiles?: boolean;
  /** Keep the service's folder on that server too: a moved stack's ./data binds stay with its volumes. */
  keepServerFiles?: boolean;
  /** Volumes it owns under other names than its own (data started from a kept database), removed with removeVolumes. */
  volumes?: string[];
  /** See extraCleanupKey. */
  extraCleanup?: boolean;
}) {
  const server = await getServer(opts.serverId);
  const { docker } = server;
  // The row may already point at another server (moves) or be gone (deletes): target the old server.
  await removeServiceProxy(opts.serviceId, opts.serverId).catch(() => {});
  if (opts.type === "compose") {
    await composeDownByProject(opts.slug, opts.removeVolumes, server);
  }
  const containers = await listServiceContainers(opts.serviceId, true, docker);
  const mounted = new Set(containers.flatMap((c) => (c.Mounts ?? []).filter((m) => m.Type === "volume" && m.Name).map((m) => m.Name as string)));
  await Promise.all(containers.map((c) => removeContainer(c.Id, 5, docker)));

  if (opts.removeVolumes) {
    // Volumes are named serve-<slug>-<source>: one of a service whose slug extends this one
    // (serve-api-v2-data for "api-v2") must not be taken for one of this service's.
    const prefix = volumeName(opts.slug, "");
    const others = (await db.select({ id: schema.service.id, slug: schema.service.slug }).from(schema.service))
      .filter((s) => s.id !== opts.serviceId)
      .map((s) => volumeName(s.slug, ""))
      .filter((p) => p.length > prefix.length && p.startsWith(prefix));
    const volumes = await docker.listVolumes();
    for (const v of volumes.Volumes ?? []) {
      if (v.Name.startsWith(prefix) && (mounted.has(v.Name) || !others.some((p) => v.Name.startsWith(p))))
        await docker
          .getVolume(v.Name)
          .remove()
          .catch(() => {});
    }
  }
  if (opts.removeVolumes) {
    for (const name of opts.volumes ?? [])
      await docker
        .getVolume(name)
        .remove()
        .catch(() => {});
  }
  // An app's images, and those a compose stack's deployments kept for rollbacks.
  const images = [
    ...(await docker.listImages({ filters: { reference: [`serve/${opts.slug}:*`] } })),
    ...(await docker.listImages({ filters: { reference: [`serve/compose/${opts.slug}:*`] } })),
  ];
  for (const img of images) {
    for (const tag of img.RepoTags ?? [])
      await docker
        .getImage(tag)
        .remove({ force: true })
        .catch(() => {});
  }
  if (!opts.keepFiles) {
    await fs.rm(paths.service(opts.serviceId), { recursive: true, force: true }).catch(() => {});
    // Its backup list is gone with the service, so the local files could never be used again.
    // Copies in S3 stay: they are the off-site history and can be imported elsewhere.
    await fs.rm(path.join(paths.backups, opts.serviceId), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(paths.uploads, opts.serviceId), { recursive: true, force: true }).catch(() => {});
  }
  if (!server.local && !opts.keepServerFiles) await server.fs.rm(server.paths.service(opts.serviceId)).catch(() => {});
  await docker.pruneImages({ filters: { dangling: { true: true }, label: [`${LABEL.service}=${opts.serviceId}`] } }).catch(() => {});
  if (opts.environmentId) {
    const { removeEnvNetworkIfUnused } = await import("@/server/docker/networks");
    await removeEnvNetworkIfUnused(opts.environmentId, server);
  }
}
