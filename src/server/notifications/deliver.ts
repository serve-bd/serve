import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { env } from "@/server/env";
import { newId } from "@/server/id";
import { publicRequest } from "@/server/net/public-fetch";
import { enqueue } from "@/server/queue";
import { eventInfo, fillTemplate, type NotifyEvent, providerInfo, type Severity, severityRank } from "@/lib/notifications";
import { type OutgoingMessage, planDelivery } from "./payloads";
import { channelWants, decide, inQuietHours, retryDelay, throttleSince } from "./rules";
import { productName } from "@/server/branding";

type Channel = typeof schema.notificationChannel.$inferSelect;
type Delivery = typeof schema.notificationDelivery.$inferSelect;

export type NotifyInput = {
  title: string;
  body: string;
  /** Dashboard path, like /projects/p/services/s. */
  url?: string;
  ok: boolean;
  /** Defaults to the event's severity (info for successes). */
  severity?: Severity;
  /** Short word for {status}: failed, succeeded, down, up… */
  status?: string;
  error?: string | null;
  serviceId?: string | null;
  serverId?: string | null;
  deploymentId?: string | null;
  /** Links a problem and its recovery, so on-call alerts open and close together. */
  dedupKey?: string | null;
  data?: Record<string, unknown>;
};

const absolute = (path?: string) => (path ? (/^https?:\/\//.test(path) ? path : `${env.appUrl.replace(/\/$/, "")}${path}`) : null);

/** Names and ids around an event: organization, project, environment, service and server. */
async function resolveMessage(organizationId: string, event: string, input: NotifyInput): Promise<OutgoingMessage> {
  const [org] = await db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, organizationId));
  let project: OutgoingMessage["project"] = null;
  let environment: OutgoingMessage["environment"] = null;
  let service: OutgoingMessage["service"] = null;
  let serverId = input.serverId ?? null;
  if (input.serviceId) {
    const [row] = await db
      .select({
        id: schema.service.id,
        name: schema.service.name,
        type: schema.service.type,
        serverId: schema.service.serverId,
        projectId: schema.project.id,
        projectName: schema.project.name,
        environmentId: schema.environment.id,
        environmentName: schema.environment.name,
      })
      .from(schema.service)
      .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
      .leftJoin(schema.environment, eq(schema.service.environmentId, schema.environment.id))
      .where(eq(schema.service.id, input.serviceId));
    if (row) {
      service = { id: row.id, name: row.name, type: row.type };
      project = { id: row.projectId, name: row.projectName };
      environment = row.environmentId ? { id: row.environmentId, name: row.environmentName ?? "" } : null;
      serverId ??= row.serverId;
    }
  }
  const [server] = serverId ? await db.select({ id: schema.server.id, name: schema.server.name }).from(schema.server).where(eq(schema.server.id, serverId)) : [];
  const info = eventInfo(event);
  const severity: Severity = input.severity ?? (input.ok ? "info" : (info?.severity ?? "warning"));
  return {
    id: newId(),
    event,
    eventLabel: info?.label ?? event,
    severity,
    ok: input.ok,
    status: input.status ?? (input.ok ? "succeeded" : "failed"),
    title: input.title,
    body: input.body,
    url: absolute(input.url),
    error: input.error ?? (input.ok ? null : input.body || null),
    dedupKey: input.dedupKey ?? null,
    occurredAt: new Date().toISOString(),
    organization: org ?? { id: organizationId, name: "" },
    project,
    environment,
    service,
    server: server ?? null,
    deployment: input.deploymentId ? { id: input.deploymentId } : null,
    data: input.data ?? {},
    brand: await productName(),
  };
}

export function templateValues(m: OutgoingMessage) {
  return {
    title: m.title,
    body: m.body,
    event: m.eventLabel,
    status: m.status,
    severity: m.severity,
    service: m.service?.name,
    project: m.project?.name,
    environment: m.environment?.name,
    server: m.server?.name,
    organization: m.organization.name,
    error: m.error,
    url: m.url,
  };
}

/** A channel's custom title and body. On-call providers keep the standard text. */
export function applyTemplate(channel: Pick<Channel, "kind" | "template">, m: OutgoingMessage): OutgoingMessage {
  const t = channel.template;
  if (!t || providerInfo(channel.kind)?.alerting || (!t.title.trim() && !t.body.trim())) return m;
  const values = templateValues(m);
  return { ...m, title: t.title.trim() ? fillTemplate(t.title, values).trim() || m.title : m.title, body: t.body.trim() ? fillTemplate(t.body, values).trim() : m.body };
}

export function channelConfig(channel: Pick<Channel, "config">) {
  return JSON.parse(decrypt(channel.config)) as Record<string, string>;
}

const snippet = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

/** Sends one message through a provider. Throws a readable error when the provider refuses it. */
export async function sendMessage(kind: string, config: Record<string, string>, m: OutgoingMessage): Promise<{ skipped?: string }> {
  const plan = planDelivery(kind, config, m);
  if (plan.kind === "skip") return { skipped: plan.reason };
  if (plan.kind === "email") {
    if (!plan.to.length) throw new Error("No email addresses to send to.");
    const { sendNotificationEmail } = await import("@/server/email/messages");
    const to = plan.to.filter((a) => !m.emailedTo?.includes(a));
    const results = await Promise.allSettled(to.map((a) => sendNotificationEmail(a, { title: m.title, body: m.body, url: m.url ?? undefined, ok: m.ok })));
    const failed = results.find((r) => r.status === "rejected");
    if (failed) {
      const sent = to.filter((_, i) => results[i].status === "fulfilled");
      throw Object.assign(new Error(`Email failed: ${(failed.reason as Error).message}`), { emailedTo: [...(m.emailedTo ?? []), ...sent] });
    }
    return {};
  }
  for (const r of plan.requests) {
    if (!r.url) throw new Error("The channel has no URL.");
    let status: number;
    let text: string;
    if (r.trusted) {
      const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body, signal: AbortSignal.timeout(15_000), redirect: "error" });
      status = res.status;
      text = await res.text().catch(() => "");
    } else {
      ({ status, text } = await publicRequest(r.url, { method: r.method, headers: r.headers, body: r.body, timeoutMs: 15_000 }));
    }
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}${text ? `: ${snippet(text)}` : ""}`);
  }
  return {};
}

const groupKeyOf = (m: OutgoingMessage) => `${m.event}:${m.service?.id ?? m.server?.id ?? ""}`;

async function touchChannel(channelId: string, status: Delivery["status"], error: string | null) {
  await db
    .update(schema.notificationChannel)
    .set({ lastDeliveryAt: new Date(), lastDeliveryStatus: status, lastDeliveryError: error })
    .where(eq(schema.notificationChannel.id, channelId));
}

/** Tries a delivery once; schedules a retry with backoff when it fails. */
export async function attemptDelivery(deliveryId: string, opts: { scheduleRetry?: boolean } = {}): Promise<Delivery | null> {
  const [row] = await db
    .select({ d: schema.notificationDelivery, c: schema.notificationChannel })
    .from(schema.notificationDelivery)
    .innerJoin(schema.notificationChannel, eq(schema.notificationDelivery.channelId, schema.notificationChannel.id))
    .where(eq(schema.notificationDelivery.id, deliveryId));
  if (!row || row.d.status === "sent") return row?.d ?? null;
  const attempts = row.d.attempts + 1;
  // Claim the attempt: a retry job and the sweep for lost jobs could both pick this row up.
  const [claimed] = await db
    .update(schema.notificationDelivery)
    .set({ attempts })
    .where(and(eq(schema.notificationDelivery.id, deliveryId), eq(schema.notificationDelivery.attempts, row.d.attempts)))
    .returning({ id: schema.notificationDelivery.id });
  if (!claimed) return row.d;
  try {
    const { skipped } = await sendMessage(row.c.kind, channelConfig(row.c), row.d.message as unknown as OutgoingMessage);
    const [updated] = await db
      .update(schema.notificationDelivery)
      .set({ status: skipped ? "suppressed" : "sent", error: skipped ?? null, attempts, sentAt: skipped ? null : new Date(), nextAttemptAt: null })
      .where(eq(schema.notificationDelivery.id, deliveryId))
      .returning();
    if (!skipped) await touchChannel(row.c.id, "sent", null);
    return updated;
  } catch (e) {
    const error = (e as Error).message.slice(0, 1000) || "Unknown error";
    const delay = opts.scheduleRetry === false ? null : retryDelay(attempts);
    const nextAttemptAt = delay ? new Date(Date.now() + delay) : null;
    // Addresses this attempt reached are not mailed again by the retry.
    const emailedTo = (e as { emailedTo?: string[] }).emailedTo;
    const message = emailedTo ? { ...row.d.message, emailedTo } : row.d.message;
    const [updated] = await db
      .update(schema.notificationDelivery)
      .set({ status: "failed", error, attempts, nextAttemptAt, message })
      .where(eq(schema.notificationDelivery.id, deliveryId))
      .returning();
    await touchChannel(row.c.id, "failed", error);
    if (nextAttemptAt) await enqueue("notification.deliver", { deliveryId }, { runAt: nextAttemptAt }).catch(() => {});
    return updated;
  }
}

async function record(channel: Channel, m: OutgoingMessage, status: Delivery["status"], extra: Partial<Delivery> = {}) {
  const [row] = await db
    .insert(schema.notificationDelivery)
    .values({
      id: m.id,
      organizationId: channel.organizationId,
      channelId: channel.id,
      event: m.event,
      severity: m.severity,
      title: m.title.slice(0, 500),
      status,
      groupKey: groupKeyOf(m),
      message: m as unknown as Record<string, unknown>,
      ...extra,
    })
    .returning();
  return row;
}

const tried = ["sent", "failed", "pending"] as const;

/** Last delivery that went out (or tried to) for this event on this channel. */
async function lastSent(channelId: string, groupKey: string) {
  const [row] = await db
    .select({ createdAt: schema.notificationDelivery.createdAt })
    .from(schema.notificationDelivery)
    .where(
      and(
        eq(schema.notificationDelivery.channelId, channelId),
        eq(schema.notificationDelivery.groupKey, groupKey),
        eq(schema.notificationDelivery.test, false),
        inArray(schema.notificationDelivery.status, [...tried]),
      ),
    )
    .orderBy(desc(schema.notificationDelivery.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

/** Status of the last message about the same problem on this channel, whatever its event (the alert or its recovery). */
async function lastOfProblem(channelId: string, dedupKey: string) {
  const [row] = await db
    .select({ status: sql<string | null>`${schema.notificationDelivery.message}->>'status'` })
    .from(schema.notificationDelivery)
    .where(
      and(
        eq(schema.notificationDelivery.channelId, channelId),
        eq(schema.notificationDelivery.test, false),
        inArray(schema.notificationDelivery.status, [...tried]),
        sql`${schema.notificationDelivery.message}->>'dedupKey' = ${dedupKey}`,
      ),
    )
    .orderBy(desc(schema.notificationDelivery.createdAt))
    .limit(1);
  return row?.status ?? null;
}

async function deliverToChannel(channel: Channel, base: OutgoingMessage) {
  const m = { ...applyTemplate(channel, base), id: newId() };
  const groupKey = groupKeyOf(m);
  const throttled = channel.throttleMinutes > 0 && m.status !== "recovered";
  const previous = throttled ? await lastSent(channel.id, groupKey) : null;
  const since = throttled ? throttleSince(m, previous, m.dedupKey ? await lastOfProblem(channel.id, m.dedupKey) : null) : null;
  const decision = decide({
    quietHours: providerInfo(channel.kind)?.alerting ? null : channel.quietHours,
    severity: m.severity,
    throttleMinutes: channel.throttleMinutes,
    lastSentAt: since,
  });
  if (decision === "hold") return record(channel, m, "held");
  if (decision === "suppress") {
    // A recovery of an alert the channel got is kept for after quiet hours, or the channel would show it down.
    const told = m.status === "recovered" && m.dedupKey ? await lastOfProblem(channel.id, m.dedupKey) : null;
    if (told && told !== "recovered") return record(channel, m, "held");
    return record(channel, m, "suppressed", { error: "Quiet hours" });
  }
  if (decision === "group") return record(channel, m, "grouped");
  // Repeats grouped since the last message are counted in this one (not those an earlier message counted).
  if (throttled && previous) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.notificationDelivery)
      .where(
        and(
          eq(schema.notificationDelivery.channelId, channel.id),
          eq(schema.notificationDelivery.groupKey, groupKey),
          eq(schema.notificationDelivery.status, "grouped"),
          gt(schema.notificationDelivery.createdAt, previous),
        ),
      );
    if (n > 0) m.body = `${m.body}\n\n${n} similar notification${n === 1 ? " was" : "s were"} grouped into this one.`.trim();
  }
  const row = await record(channel, m, "pending");
  return attemptDelivery(row.id);
}

/** Sends an event to every enabled channel of the organization that wants it. Never throws. */
export async function notify(organizationId: string | null, event: NotifyEvent, input: NotifyInput) {
  if (!organizationId) return;
  try {
    const channels = await db
      .select()
      .from(schema.notificationChannel)
      .where(and(eq(schema.notificationChannel.enabled, true), eq(schema.notificationChannel.organizationId, organizationId)));
    if (!channels.length) return;
    const m = await resolveMessage(organizationId, event, input);
    const rule = {
      event,
      severity: m.severity,
      ok: m.ok,
      dedup: !!m.dedupKey,
      projectId: m.project?.id ?? null,
      environmentId: m.environment?.id ?? null,
      serviceId: m.service?.id ?? null,
    };
    await Promise.allSettled(channels.filter((c) => channelWants(c, rule)).map((c) => deliverToChannel(c, m)));
  } catch (e) {
    console.error("[notify]", e);
  }
}

/** A sample message for "Send test" and the template preview. */
export function sampleMessage(org: { id: string; name: string }, kind: string, brand = "Serve"): OutgoingMessage {
  const alerting = !!providerInfo(kind)?.alerting;
  return {
    id: newId(),
    event: "test",
    eventLabel: "Test",
    severity: "info",
    ok: !alerting,
    status: "test",
    title: `Test notification from ${brand}`,
    brand,
    body: "This channel is set up. Real notifications look like this.",
    url: absolute("/integrations/notifications"),
    error: null,
    dedupKey: alerting ? `serve-test:${newId()}` : null,
    occurredAt: new Date().toISOString(),
    organization: org,
    project: { id: "example", name: "Shop" },
    environment: { id: "example", name: "production" },
    service: { id: "example", name: "api", type: "app" },
    server: { id: "local", name: "localhost" },
    deployment: null,
    data: {},
  };
}

/** Sends a test. On-call providers get an alert that is resolved right after. */
export async function sendTest(kind: string, config: Record<string, string>, m: OutgoingMessage) {
  await sendMessage(kind, config, m);
  if (providerInfo(kind)?.alerting) await sendMessage(kind, config, { ...m, ok: true });
}

/** Worker tick: once quiet hours end, sends one summary of what was held. */
export async function flushHeldNotifications() {
  const held = await db
    .select({ d: schema.notificationDelivery, c: schema.notificationChannel })
    .from(schema.notificationDelivery)
    .innerJoin(schema.notificationChannel, eq(schema.notificationDelivery.channelId, schema.notificationChannel.id))
    .where(eq(schema.notificationDelivery.status, "held"))
    .orderBy(schema.notificationDelivery.createdAt);
  const byChannel = new Map<string, { channel: Channel; rows: Delivery[] }>();
  for (const { d, c } of held) {
    const entry = byChannel.get(c.id) ?? { channel: c, rows: [] };
    entry.rows.push(d);
    byChannel.set(c.id, entry);
  }
  for (const { channel, rows } of byChannel.values()) {
    if (inQuietHours(channel.quietHours)) continue;
    const ids = rows.map((r) => r.id);
    if (!channel.enabled) {
      await db.update(schema.notificationDelivery).set({ status: "suppressed", error: "Channel turned off" }).where(inArray(schema.notificationDelivery.id, ids));
      continue;
    }
    const first = rows[0].message as unknown as OutgoingMessage;
    const worst = rows.reduce<Severity>((w, r) => (severityRank[r.severity] > severityRank[w] ? r.severity : w), "info");
    const lines = rows.slice(0, 15).map((r) => `• ${r.title}`);
    if (rows.length > 15) lines.push(`…and ${rows.length - 15} more`);
    const digest: OutgoingMessage = {
      ...first,
      id: newId(),
      event: "digest",
      eventLabel: "Quiet hours summary",
      severity: worst,
      ok: rows.every((r) => (r.message as unknown as OutgoingMessage).ok),
      status: "summary",
      title: `${rows.length} notification${rows.length === 1 ? "" : "s"} during quiet hours`,
      body: lines.join("\n"),
      url: absolute("/integrations/notifications"),
      error: null,
      dedupKey: null,
      occurredAt: new Date().toISOString(),
      project: null,
      environment: null,
      service: null,
      server: null,
      deployment: null,
      data: { events: rows.map((r) => ({ id: r.id, event: r.event, title: r.title, at: r.createdAt.toISOString() })) },
    };
    await db
      .update(schema.notificationDelivery)
      .set({ status: "sent", sentAt: new Date(), error: "Sent in the quiet-hours summary" })
      .where(inArray(schema.notificationDelivery.id, ids));
    const row = await record(channel, digest, "pending");
    await attemptDelivery(row.id);
  }
}

/**
 * Failed deliveries whose retry job was lost (for example to a restart) are picked up again, and
 * so are first attempts the process stopped during: they would stay "pending" and never be sent.
 */
export async function retryDueDeliveries() {
  const due = await db
    .select({ id: schema.notificationDelivery.id })
    .from(schema.notificationDelivery)
    .where(
      or(
        and(eq(schema.notificationDelivery.status, "failed"), lt(schema.notificationDelivery.nextAttemptAt, sql`now() - interval '2 minutes'`)),
        and(eq(schema.notificationDelivery.status, "pending"), lt(schema.notificationDelivery.createdAt, sql`now() - interval '10 minutes'`)),
      ),
    )
    .limit(50);
  for (const d of due) await attemptDelivery(d.id);
}

/** Delivery history is kept for 30 days. */
export async function pruneDeliveries() {
  await db
    .delete(schema.notificationDelivery)
    .where(
      and(
        lt(schema.notificationDelivery.createdAt, sql`now() - interval '30 days'`),
        or(isNull(schema.notificationDelivery.nextAttemptAt), lt(schema.notificationDelivery.nextAttemptAt, sql`now()`)),
      ),
    );
}
