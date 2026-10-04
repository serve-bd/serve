import { connection } from "next/server";
import { getSettings } from "@/server/settings";
import { dockerDiskUsage } from "@/server/system";
import { serverSnapshot } from "@/server/metrics";
import { CleanupView } from "./cleanup-view";
import { loadServer, withTimeout } from "../_lib/load";

export const metadata = { title: "Docker cleanup" };

export default async function CleanupPage(props: PageProps<"/servers/[serverId]/cleanup">) {
  await connection();
  const { serverId } = await props.params;
  const { server, ctx } = await loadServer(serverId);
  const settings = await getSettings();
  // Not awaited: the page shows at once, and these stream in when Docker has counted.
  const usage = withTimeout(
    server().then((ctx) => dockerDiskUsage(ctx)),
    16_000,
  ).then((u) => u ?? { reachable: false, images: null, containers: null, volumes: null, buildCache: null });
  const disk = withTimeout(
    server().then((ctx) => serverSnapshot(ctx).catch(() => null)),
    12_000,
  ).then((snap) => snap?.disk ?? null);
  // History entries without a server id are from before multi-server: they ran on the local server.
  const history = settings.cleanupHistory.filter((r) => (r.serverId ?? "local") === serverId);
  return (
    <CleanupView
      serverId={serverId}
      isInstanceAdmin={ctx.isInstanceAdmin}
      usage={usage}
      disk={disk}
      history={history}
      lastAt={history[0]?.at ?? null}
      settings={{
        cleanupEnabled: settings.cleanupEnabled,
        cleanupIntervalHours: settings.cleanupIntervalHours,
        cleanupDiskThreshold: settings.cleanupDiskThreshold,
        cleanupBuildCacheDays: settings.cleanupBuildCacheDays,
        cleanupUnusedImages: settings.cleanupUnusedImages,
        cleanupUnusedVolumes: settings.cleanupUnusedVolumes,
        cleanupUnusedNetworks: settings.cleanupUnusedNetworks,
      }}
    />
  );
}
