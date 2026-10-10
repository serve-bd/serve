import { logActivity } from "@/server/activity";
import type { schema } from "@/server/db";
import { getServer, getServerRow } from "@/server/servers/context";
import { canManageServer } from "@/server/servers/ownership";
import { HOST_SHELL, hostShellRefused, pickConsoleContainer } from "@/server/services/console";
import { FilesError, type FilesPlace } from "./helper";

/*
 * Who may open which files: the same people as the terminal. A server's files are a root shell
 * on it: admins who manage the server. A service's files are its console: the Console permission,
 * its project, and for a service with host-level access, an admin of the Root organization.
 */

type Service = typeof schema.service.$inferSelect;
type Org = { user: { id: string }; org: { id: string }; isAdmin: boolean; isInstanceAdmin: boolean };

export type Mount = { path: string; kind: "volume" | "bind" | "other"; name: string };

export type FilesTarget = {
  place: FilesPlace;
  /** "on hetzner", "in web (web-abc-1)": for messages. */
  where: string;
  /** Records a change in the activity log. */
  log: (message: string) => Promise<void>;
  /** A container's volumes and mounts, to tag them in listings. */
  mounts: () => Promise<Mount[]>;
};

const NO_MOUNTS = async () => [];

export async function serverTarget(org: Org, serverId: string): Promise<FilesTarget> {
  const row = await getServerRow(serverId).catch(() => null);
  if (!row) throw new FilesError(2, "Server not found.");
  if (!canManageServer(org, row)) throw new FilesError(3, "Only admins who manage this server can open its files.");
  const ctx = await getServer(row.id);
  const name = row.isLocal ? "the host" : row.name;
  return {
    place: { docker: ctx.docker, ssh: ctx.ssh, kind: "host" },
    where: `on ${name}`,
    log: (message) => logActivity({ userId: org.user.id, organizationId: org.org.id, action: "server.files", targetType: "server", targetId: row.id, message }),
    mounts: NO_MOUNTS,
  };
}

/** Mounts by container id: they do not change while the container exists. */
const mountCache = new Map<string, Mount[]>();

export async function serviceTarget(
  org: Org & { can: (p: "console.access") => boolean },
  service: Service,
  pick: { target?: string | null; replica?: number | null },
): Promise<FilesTarget> {
  if (!org.can("console.access")) throw new FilesError(3, "Your role cannot open the console, so it cannot open files either.");
  if (hostShellRefused(service, org.isInstanceAdmin)) throw new FilesError(3, HOST_SHELL);
  let c: Awaited<ReturnType<typeof pickConsoleContainer>>;
  try {
    c = await pickConsoleContainer(service, pick);
  } catch (e) {
    throw new FilesError(9, (e as Error).message);
  }
  const place: FilesPlace = { docker: c.docker, ssh: c.ssh, kind: "container", containerId: c.id };
  return {
    place,
    where: `in ${service.name}`,
    log: (message) => logActivity({ userId: org.user.id, projectId: service.projectId, action: "service.files", targetType: "service", targetId: service.id, message }),
    mounts: async () => {
      const cached = mountCache.get(c.id);
      if (cached) return cached;
      const info = await c.docker
        .getContainer(c.id)
        .inspect()
        .catch(() => null);
      const mounts: Mount[] = (info?.Mounts ?? []).map((m) => ({
        path: m.Destination,
        kind: m.Type === "volume" ? "volume" : m.Type === "bind" ? "bind" : "other",
        name: m.Type === "volume" ? (m.Name ?? "") : (m.Source ?? ""),
      }));
      if (mountCache.size > 500) mountCache.clear();
      if (info) mountCache.set(c.id, mounts);
      return mounts;
    },
  };
}
