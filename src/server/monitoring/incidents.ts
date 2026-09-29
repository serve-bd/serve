import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { newId } from "@/server/id";
import { notify, type NotifyEvent } from "@/server/notify";

type Incident = typeof schema.incident.$inferSelect;

/** A problem that clears within this time is reopened quietly instead of paging again. */
const FLAP_WINDOW_MS = 10 * 60_000;

export type OpenIncident = {
  organizationId: string;
  key: string;
  kind: Incident["kind"];
  serviceId?: string | null;
  serverId?: string | null;
  severity?: "warning" | "critical";
  title: string;
  detail?: string | null;
  /** Notification sent when the incident opens (or escalates to critical). */
  event: NotifyEvent;
  url?: string;
};

export async function openIncidentFor(key: string) {
  const [row] = await db
    .select()
    .from(schema.incident)
    .where(and(eq(schema.incident.key, key), isNull(schema.incident.resolvedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Open (or keep open) the incident for a key. Notifies once when it opens and again only
 * when a warning becomes critical. A problem that just cleared reopens its incident
 * without a second notification, so a flapping check does not flood channels.
 */
export async function openIncident(input: OpenIncident): Promise<Incident> {
  const severity = input.severity ?? "critical";
  const open = await openIncidentFor(input.key);
  if (open) {
    const escalated = open.severity === "warning" && severity === "critical";
    const [row] = await db
      .update(schema.incident)
      .set({ severity: escalated ? "critical" : open.severity, title: input.title, detail: input.detail ?? open.detail })
      .where(eq(schema.incident.id, open.id))
      .returning();
    if (escalated) await send(input, row);
    return row;
  }
  const [recent] = await db.select().from(schema.incident).where(eq(schema.incident.key, input.key)).orderBy(desc(schema.incident.startedAt)).limit(1);
  if (recent?.resolvedAt && Date.now() - recent.resolvedAt.getTime() < FLAP_WINDOW_MS) {
    const [row] = await db
      .update(schema.incident)
      .set({ resolvedAt: null, severity, title: input.title, detail: input.detail ?? recent.detail })
      .where(eq(schema.incident.id, recent.id))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(schema.incident)
    .values({
      id: newId(),
      organizationId: input.organizationId,
      key: input.key,
      kind: input.kind,
      serviceId: input.serviceId ?? null,
      serverId: input.serverId ?? null,
      severity,
      title: input.title,
      detail: input.detail ?? null,
    })
    .returning();
  await send(input, row);
  return row;
}

/** Close the open incident for a key, if any, and optionally notify. */
export async function resolveIncident(key: string, recovered?: { event: NotifyEvent; title: string; body: string; url?: string }): Promise<Incident | null> {
  const open = await openIncidentFor(key);
  if (!open) return null;
  const [row] = await db.update(schema.incident).set({ resolvedAt: new Date() }).where(eq(schema.incident.id, open.id)).returning();
  if (recovered) {
    const minutes = Math.max(1, Math.round((Date.now() - open.startedAt.getTime()) / 60_000));
    await notify(open.organizationId, recovered.event, {
      ok: true,
      title: recovered.title,
      body: `${recovered.body} It was down for ${minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`}.`,
      url: recovered.url,
      status: "recovered",
      serviceId: open.serviceId,
      serverId: open.serverId,
      dedupKey: open.key,
      data: { incidentId: open.id, downMinutes: minutes },
    }).catch(() => {});
  }
  return row;
}

async function send(input: OpenIncident, row: Incident) {
  await notify(input.organizationId, input.event, {
    ok: false,
    title: row.title,
    body: row.detail ?? "",
    url: input.url,
    severity: row.severity === "warning" ? "warning" : "critical",
    status: input.kind === "down" ? "down" : "alert",
    serviceId: input.serviceId,
    serverId: input.serverId,
    dedupKey: row.key,
    data: { incidentId: row.id, kind: input.kind },
  }).catch(() => {});
}
