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
  const [settings, data] = await Promise.all([
    getSettings(),
    withTimeout(
      server().then((ctx) => Promise.all([dockerDiskUsage(ctx), serverSnapshot(ctx).catch(() => null)])),
      12_000,
    ),
  ]);
  // History entries without a server id are from before multi-server: they ran on the local server.
  const history = settings.cleanupHistory.filter((r) => (r.serverId ?? "local") === serverId);
  return (
    <CleanupView
      serverId={serverId}
      isInstanceAdmin={ctx.isInstanceAdmin}
      usage={data?.[0] ?? null}
      disk={data?.[1]?.disk ?? null}
      history={history}
      lastAt={history[0]?.at ?? null}
      settings={{
        cleanupEnabled: settings.cleanupEnabled,
        cleanupIntervalHours: settings.cleanupIntervalHours,
        cleanupDiskThreshold: settings.cleanupDiskThreshold,
        cleanupBuildCacheDays: settings.cleanupBuildCacheDays,
        cleanupUnusedImages: settings.cleanupUnusedImages,
      }}
    />
  );
}
