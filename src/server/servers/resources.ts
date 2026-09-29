import { inArray, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LABEL } from "@/server/docker/client";
import { env } from "@/server/env";
import type { ServerCtx } from "./context";

export type ContainerKind = "system" | "service" | "unmanaged";

export type ContainerRow = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: string[];
  kind: ContainerKind;
  /** What Serve knows about it: the service it belongs to or its role. */
  role: string | null;
  service: { id: string; name: string; projectId: string; projectName: string; organizationName: string } | null;
  composeService: string | null;
};

const SYSTEM_NAMES = new Set(["serve", "serve-worker", "serve-db", "serve-proxy", "serve-host-shell", env.proxyContainer]);

/** Serve's own containers: the proxy, helpers and the dashboard stack. */
export function isSystemContainer(labels: Record<string, string>, name: string) {
  if (labels[LABEL.service]) return false;
  if (labels[LABEL.managed] || labels[LABEL.kind]) return true;
  if (labels["com.docker.compose.project"] === "serve") return true;
  return SYSTEM_NAMES.has(name);
}

function systemRole(labels: Record<string, string>, name: string) {
  const kind = labels[LABEL.kind];
  if (kind === "proxy" || name === env.proxyContainer || name === "serve-proxy") return "nginx proxy";
  if (kind === "mesh") return "Private network";
  if (kind === "mesh-link") return "Private network name";
  if (kind) return kind.replace(/[-_]/g, " ");
  const svc = labels["com.docker.compose.service"] ?? name;
  if (/worker/.test(svc)) return "Worker";
  if (/db|postgres/.test(svc)) return "Serve database";
  if (/proxy/.test(svc)) return "nginx proxy";
  return "Dashboard";
}

/** Every container on a server, classified as Serve system, service or unmanaged. */
export async function listHostContainers(ctx: ServerCtx): Promise<ContainerRow[]> {
  const containers = await ctx.docker.listContainers({ all: true });
  const serviceIds = [...new Set(containers.map((c) => c.Labels[LABEL.service]).filter(Boolean))];
  const services = serviceIds.length
    ? await db
        .select({
          id: schema.service.id,
          name: schema.service.name,
          projectId: schema.project.id,
          projectName: schema.project.name,
          organizationName: schema.organization.name,
        })
        .from(schema.service)
        .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
        .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
        .where(inArray(schema.service.id, serviceIds))
    : [];
  const byId = new Map(services.map((s) => [s.id, s]));

  return containers
    .map((c): ContainerRow => {
      const name = c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12);
      const serviceId = c.Labels[LABEL.service];
      const kind: ContainerKind = serviceId ? "service" : isSystemContainer(c.Labels, name) ? "system" : "unmanaged";
      const service = serviceId ? (byId.get(serviceId) ?? null) : null;
      const ports = [...new Set((c.Ports ?? []).filter((p) => p.PublicPort).map((p) => `${p.PublicPort}→${p.PrivatePort}${p.Type === "udp" ? "/udp" : ""}`))];
      return {
        id: c.Id,
        name,
        image: c.Image.startsWith("sha256:") ? c.Image.slice(7, 19) : c.Image,
        state: c.State,
        status: c.Status,
        created: c.Created * 1000,
        ports,
        kind,
        role: kind === "system" ? systemRole(c.Labels, name) : kind === "service" && !service ? (c.Labels[LABEL.slug] ?? "Serve service") : null,
        service,
        composeService: c.Labels["com.docker.compose.service"] ?? null,
      };
    })
    .sort((a, b) => {
      const order = { system: 0, service: 1, unmanaged: 2 };
      return order[a.kind] - order[b.kind] || (a.state === "running" ? -1 : 1) - (b.state === "running" ? -1 : 1) || a.name.localeCompare(b.name);
    });
}

export async function hostSummary(ctx: ServerCtx) {
  const [images, volumes, networks] = await Promise.all([
    ctx.docker.listImages().catch(() => []),
    ctx.docker.listVolumes().catch(() => ({ Volumes: [] })),
    ctx.docker.listNetworks().catch(() => []),
  ]);
  return { images: images.length, volumes: volumes.Volumes?.length ?? 0, networks: networks.length };
}
