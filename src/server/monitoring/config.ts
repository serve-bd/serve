import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { ServerAlertConfig } from "@/server/db/schema";

export const DEFAULT_SERVER_ALERTS: ServerAlertConfig = { enabled: true, diskWarn: 85, diskCritical: 95, memory: 90, cpu: 90, cpuMinutes: 10 };

/** Thresholds of a server, falling back to the defaults. */
export async function alertsFor(serverId: string): Promise<ServerAlertConfig> {
  const [row] = await db.select().from(schema.serverAlerts).where(eq(schema.serverAlerts.serverId, serverId));
  return { ...DEFAULT_SERVER_ALERTS, ...(row?.config ?? {}) };
}

/** Interval choices offered in the UI (seconds). */
export const MONITOR_INTERVALS = [30, 60, 120, 300, 600] as const;
