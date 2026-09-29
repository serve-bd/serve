import { connection } from "next/server";
import { getSettings } from "@/server/settings";
import { dockerDiskUsage } from "@/server/system";
import { serverSnapshot } from "@/server/metrics";
import { CleanupView } from "./cleanup-view";

export const metadata = { title: "Docker cleanup" };

export default async function CleanupPage() {
  await connection();
  const [settings, usage, snap] = await Promise.all([getSettings(), dockerDiskUsage(), serverSnapshot().catch(() => null)]);
  return (
    <CleanupView
      usage={usage}
      disk={snap?.disk ?? null}
      history={settings.cleanupHistory}
      lastAt={settings.lastCleanup?.at ?? null}
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
