import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { alertsFor } from "@/server/monitoring/config";
import { loadServer } from "../_lib/load";
import { AlertsView } from "./alerts-view";

export const metadata = { title: "Alerts" };

export default async function AlertsPage(props: PageProps<"/servers/[serverId]/alerts">) {
  const { serverId } = await props.params;
  const { row } = await loadServer(serverId);
  const [config, incidents] = await Promise.all([
    alertsFor(serverId),
    db
      .select()
      .from(schema.incident)
      .where(and(eq(schema.incident.serverId, serverId), eq(schema.incident.kind, "resource")))
      .orderBy(desc(schema.incident.startedAt))
      .limit(20),
  ]);
  return (
    <AlertsView
      serverId={serverId}
      serverName={row.isLocal ? "this server" : row.name}
      config={config}
      incidents={incidents.map((i) => ({
        id: i.id,
        title: i.title,
        detail: i.detail,
        severity: i.severity,
        startedAt: i.startedAt.toISOString(),
        resolvedAt: i.resolvedAt?.toISOString() ?? null,
      }))}
    />
  );
}
