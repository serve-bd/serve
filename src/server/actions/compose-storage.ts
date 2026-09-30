"use server";

import { act, UserError } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { serviceInOrg } from "@/server/services/access";
import { serverOf } from "@/server/servers/context";
import { type ComposeMount, composeVolumeName, readComposeMounts, writeComposeMounts } from "@/lib/compose-mounts";
import { updateService } from "@/server/actions/services";

async function composeService(serviceId: string, permission: "services.manage" | "projects.view") {
  const ctx = await requirePermission(permission);
  const { service } = await serviceInOrg(serviceId, ctx.org.id);
  if (service.type !== "compose" || !service.compose) throw new UserError("Not a compose service.");
  return { ctx, service, compose: service.compose };
}

/**
 * Replaces the storage of one service of a stack by editing its compose file. The new file goes
 * through the same save as the compose editor, with the same checks (host paths for Root admins).
 */
export async function saveComposeMounts(serviceId: string, name: string, mounts: ComposeMount[]) {
  const prepared = await act(async () => {
    const { compose } = await composeService(serviceId, "services.manage");
    if (compose.mode === "git") throw new UserError("This stack is read from the repository. Change its storage in the compose file there.");
    try {
      return writeComposeMounts(compose.content, name, mounts);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  });
  if (!prepared.ok) return prepared;
  return updateService(serviceId, { compose: { content: prepared.data } });
}

export type ComposeVolumeUsage = { volume: string; dockerName: string; exists: boolean; size: number | null; containers: number };

/** Named volumes of a stack as Docker has them on its server: size and how many containers use them. */
export async function composeVolumeUsage(serviceId: string) {
  return act(async () => {
    const { service, compose } = await composeService(serviceId, "projects.view");
    const names = new Set<string>();
    for (const s of readComposeMounts(compose.content)) for (const m of s.mounts) if (m.kind === "volume") names.add(m.source);
    const server = await serverOf(service);
    const df = (await Promise.race([
      server.docker.df(),
      new Promise((_, reject) => setTimeout(() => reject(new UserError("The server took too long to report volume sizes.")), 20_000)),
    ])) as { Volumes?: { Name: string; Labels?: Record<string, string> | null; UsageData?: { Size?: number; RefCount?: number } | null }[] };
    const byName = new Map((df.Volumes ?? []).map((v) => [v.Name, v]));
    const usage: ComposeVolumeUsage[] = [...names].map((volume) => {
      const dockerName = composeVolumeName(compose.content, service.slug, volume);
      const v = byName.get(dockerName);
      return { volume, dockerName, exists: !!v, size: v?.UsageData?.Size != null && v.UsageData.Size >= 0 ? v.UsageData.Size : null, containers: v?.UsageData?.RefCount ?? 0 };
    });
    // Volumes of the stack the file no longer mentions: their data is still on the server.
    const leftovers = (df.Volumes ?? [])
      .filter((v) => v.Labels?.["com.docker.compose.project"] === service.slug && !usage.some((u) => u.dockerName === v.Name))
      .map((v) => ({
        volume: v.Labels?.["com.docker.compose.volume"] ?? v.Name,
        dockerName: v.Name,
        exists: true,
        size: v.UsageData?.Size != null && v.UsageData.Size >= 0 ? v.UsageData.Size : null,
        containers: v.UsageData?.RefCount ?? 0,
      }));
    return { volumes: usage, leftovers };
  });
}
