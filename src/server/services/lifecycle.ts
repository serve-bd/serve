import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { docker, LABEL, listServiceContainers, removeContainer } from "@/server/docker/client";
import { paths } from "@/server/paths";
import { removeServiceProxy, syncServiceProxy } from "@/server/proxy/nginx";
import { composeDownByProject } from "@/server/deploy/compose";
import { deployDatabase, setServiceStatus } from "@/server/deploy";
import { run } from "@/server/process";

async function getService(id: string) {
  const service = await db.query.service.findFirst({ where: eq(schema.service.id, id) });
  if (!service) throw new Error("Service not found");
  return service;
}

export async function stopService(serviceId: string) {
  const service = await getService(serviceId);
  const containers = await listServiceContainers(service.id);
  await Promise.all(containers.map((c) => docker.getContainer(c.Id).stop({ t: 15 }).catch(() => {})));
  await setServiceStatus(service.id, "stopped");
  await syncServiceProxy(service.id).catch(() => {});
}

export async function startService(serviceId: string): Promise<"started" | "needs-deploy"> {
  const service = await getService(serviceId);
  const containers = await listServiceContainers(service.id);
  const relevant =
    service.type === "app"
      ? containers.filter((c) => c.Labels[LABEL.deployment] === service.currentDeploymentId)
      : containers;
  if (!relevant.length) {
    if (service.type === "database") {
      await setServiceStatus(service.id, "deploying");
      await deployDatabase(service, null);
      return "started";
    }
    return "needs-deploy";
  }
  await Promise.all(relevant.map((c) => docker.getContainer(c.Id).start().catch(() => {})));
  await setServiceStatus(service.id, "running");
  await syncServiceProxy(service.id).catch(() => {});
  return "started";
}

export async function restartService(serviceId: string) {
  const service = await getService(serviceId);
  const containers = await listServiceContainers(service.id);
  const relevant =
    service.type === "app" ? containers.filter((c) => c.Labels[LABEL.deployment] === service.currentDeploymentId) : containers;
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
  await Promise.all(relevant.map((c) => docker.getContainer(c.Id).restart({ t: 10 }).catch(() => {})));
  await setServiceStatus(service.id, "running");
  await syncServiceProxy(service.id).catch(() => {});
}

export async function destroyService(opts: { serviceId: string; slug: string; type: string; removeVolumes: boolean; environmentId?: string }) {
  await removeServiceProxy(opts.serviceId).catch(() => {});
  if (opts.type === "compose") {
    await composeDownByProject(opts.slug, opts.removeVolumes);
  }
  const containers = await listServiceContainers(opts.serviceId);
  await Promise.all(containers.map((c) => removeContainer(c.Id, 5)));

  if (opts.removeVolumes) {
    const volumes = await docker.listVolumes();
    for (const v of volumes.Volumes ?? []) {
      if (v.Name.startsWith(`serve-${opts.slug}-`)) await docker.getVolume(v.Name).remove().catch(() => {});
    }
  }
  const images = await docker.listImages({ filters: { reference: [`serve/${opts.slug}:*`] } });
  for (const img of images) {
    for (const tag of img.RepoTags ?? []) await docker.getImage(tag).remove({ force: true }).catch(() => {});
  }
  await fs.rm(paths.service(opts.serviceId), { recursive: true, force: true }).catch(() => {});
  await run("docker", ["image", "prune", "-f", "--filter", `label=${LABEL.service}=${opts.serviceId}`]).catch(() => {});
  if (opts.environmentId) {
    const { removeEnvNetworkIfUnused } = await import("@/server/docker/networks");
    await removeEnvNetworkIfUnused(opts.environmentId);
  }
}
