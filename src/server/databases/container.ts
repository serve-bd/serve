import type Docker from "dockerode";
import { LABEL } from "@/server/docker/client";

/**
 * A database service's container, checked by Serve's label and not trusted by its name alone:
 * dumps, restores and password changes must never reach another stack's container that took the
 * name while the database was being recreated.
 */
export async function databaseContainer(docker: Docker, service: { id: string; slug: string; name: string }) {
  const container = docker.getContainer(service.slug);
  const info = await container.inspect().catch(() => null);
  if (!info) throw new Error(`The container of ${service.name} is not there. Deploy it first.`);
  if (info.Config.Labels?.[LABEL.service] !== service.id) throw new Error(`The container named ${service.slug} does not belong to ${service.name}.`);
  return container;
}
