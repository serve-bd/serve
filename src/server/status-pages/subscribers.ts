import { and, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import { decryptOrNull, encrypt, hmac, randomSecret } from "@/server/crypto";
import { newId } from "@/server/id";
import { UserError } from "@/server/action";
import { publicRequest } from "@/server/net/public-fetch";
import { renderEmail } from "@/server/email/templates";
import { isEmailConfigured, sendEmail } from "@/server/email/send";
import { chatWebhookProblem, designOf, IMPACT_TEXT, labelsOf, type LabelKey, maintenancePhase, type SubscriberKind, subscribeOf } from "@/lib/status-page";
import { pageUrl } from "./urls";

type Page = typeof schema.statusPage.$inferSelect;
type Subscriber = typeof schema.statusSubscriber.$inferSelect;

/** A webhook that failed this many times in a row is removed: its owner deleted it, most likely. */
const MAX_FAILURES = 10;
/** An email address nobody confirmed is forgotten after this long. */
const UNCONFIRMED_DAYS = 7;

const normalize = (kind: SubscriberKind, target: string) => (kind === "email" ? target.trim().toLowerCase() : target.trim());

/** What a visitor can subscribe with on this page right now. Email also needs the instance's email settings. */
export async function subscribeOptions(page: Pick<Page, "subscribe" | "design" | "visibility">) {
  const cfg = subscribeOf(page.subscribe);
  // Webhooks get the incidents without the password: only a public page offers them (and email).
  const open = page.visibility === "public";
  return {
    email: open && cfg.email && (await isEmailConfigured()),
    slack: open && cfg.slack,
    discord: open && cfg.discord,
    webhook: open && cfg.webhook,
    rss: cfg.rss,
    components: cfg.components,
  };
}

export type SubscribeResult = { state: "check-email" | "subscribed" | "already" };

/**
 * A visitor's subscription. Email gets a confirmation link first (nobody is signed up by someone
 * else); a webhook gets a test message and is kept only when it answers.
 */
export async function subscribe(page: Page, input: { kind: string; target: string; componentIds?: string[] }): Promise<SubscribeResult> {
  const options = await subscribeOptions(page);
  const kind = z.enum(["email", "slack", "discord", "webhook"]).parse(input.kind);
  if (!options[kind]) throw new UserError("This way to subscribe is not offered here.");
  const target = normalize(kind, input.target ?? "");
  if (!target) throw new UserError(kind === "email" ? "Enter your email address." : "Enter the webhook URL.");
  if (target.length > 2000) throw new UserError("That is too long.");
  if (kind === "email" && !z.email().safeParse(target).success) throw new UserError("Enter a valid email address.");
  if (kind === "slack" || kind === "discord") {
    const problem = chatWebhookProblem(kind, target);
    if (problem) throw new UserError(problem);
  }
  if (kind === "webhook") {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new UserError("That is not a valid URL.");
    }
    if (url.protocol !== "https:" || url.username || url.password) throw new UserError("Use an https:// URL without a user name or password.");
  }
  const known = new Set((await db.select({ id: schema.statusComponent.id }).from(schema.statusComponent).where(eq(schema.statusComponent.pageId, page.id))).map((c) => c.id));
  const componentIds = options.components ? [...new Set((input.componentIds ?? []).filter((id) => known.has(id)))] : [];
  const targetHash = hmac(`status-subscriber:${kind}:${target}`);

  const [existing] = await db
    .select()
    .from(schema.statusSubscriber)
    .where(and(eq(schema.statusSubscriber.pageId, page.id), eq(schema.statusSubscriber.targetHash, targetHash)));
  if (existing?.confirmed) {
    // The same address again: its choice of components is the newest one.
    await db.update(schema.statusSubscriber).set({ componentIds }).where(eq(schema.statusSubscriber.id, existing.id));
    return { state: "already" };
  }

  if (kind === "email") {
    const token = existing?.token ?? randomSecret(24);
    if (existing) await db.update(schema.statusSubscriber).set({ componentIds }).where(eq(schema.statusSubscriber.id, existing.id));
    else await db.insert(schema.statusSubscriber).values({ id: newId(), pageId: page.id, kind, target, targetHash, componentIds, token });
    await sendConfirmation(page, target, token);
    return { state: "check-email" };
  }

  // A webhook: it must take a message now, or it is not kept.
  const words = labelsOf(designOf(page.design));
  const url = await pageUrl(page);
  const sent = await post(kind, target, {
    page: { name: page.name, url },
    event: "subscribed",
    title: `Subscribed to ${page.name}`,
    state: words["sub.done"],
    message: `This ${kind === "webhook" ? "webhook" : "channel"} now gets the incidents and maintenance of ${page.name}.`,
    url,
    level: "operational",
    notice: null,
  });
  if (sent) throw new UserError(`The webhook did not take a test message: ${sent}`);
  await db
    .insert(schema.statusSubscriber)
    .values({ id: newId(), pageId: page.id, kind, target: encrypt(target), targetHash, componentIds, token: randomSecret(24), confirmed: true })
    .onConflictDoNothing();
  return { state: "subscribed" };
}

async function sendConfirmation(page: Page, to: string, token: string) {
  const url = await pageUrl(page);
  const { html, text } = renderEmail({
    brand: page.name,
    heading: `Confirm your subscription to ${page.name}`,
    paragraphs: [`Someone, hopefully you, asked to get incident and maintenance updates of ${page.name} at this address.`],
    action: { label: "Confirm", url: `${url}/confirm?token=${encodeURIComponent(token)}` },
    note: "If it was not you, ignore this email: nothing is sent until the address is confirmed.",
  });
  await sendEmail({ to, subject: `Confirm your subscription to ${page.name}`, text, html });
}

export async function subscriberByToken(token: string) {
  if (!token || token.length > 100) return null;
  const [row] = await db
    .select({ subscriber: schema.statusSubscriber, page: schema.statusPage })
    .from(schema.statusSubscriber)
    .innerJoin(schema.statusPage, eq(schema.statusSubscriber.pageId, schema.statusPage.id))
    .where(eq(schema.statusSubscriber.token, token));
  return row ?? null;
}

export async function confirmSubscriber(id: string) {
  await db.update(schema.statusSubscriber).set({ confirmed: true }).where(eq(schema.statusSubscriber.id, id));
}

export async function removeSubscriber(id: string) {
  await db.delete(schema.statusSubscriber).where(eq(schema.statusSubscriber.id, id));
}

/** Email addresses nobody confirmed in a week: forgotten. */
export async function pruneSubscribers() {
  await db
    .delete(schema.statusSubscriber)
    .where(and(eq(schema.statusSubscriber.confirmed, false), lt(schema.statusSubscriber.createdAt, new Date(Date.now() - UNCONFIRMED_DAYS * 86400_000))));
}

/* -------------------------------------------------------------------------- */
/*                                   Sending                                  */
/* -------------------------------------------------------------------------- */

export type StatusEvent = "created" | "updated" | "maintenance-started" | "maintenance-ended" | "outage" | "outage-resolved";

type Message = {
  page: { name: string; url: string };
  event: StatusEvent | "subscribed";
  title: string;
  /** Investigating, Resolved, Scheduled… in the page's words. */
  state: string;
  message: string;
  url: string;
  level: "operational" | "maintenance" | "degraded" | "partial" | "major";
  notice: {
    id: string;
    kind: "incident" | "maintenance" | "outage";
    impact: string | null;
    components: string[];
    startsAt: string | null;
    endsAt: string | null;
    resolvedAt: string | null;
  } | null;
};

const COLOR: Record<Message["level"], number> = { operational: 0x1a9a52, maintenance: 0x2f6fdb, degraded: 0xc47a00, partial: 0xe0601b, major: 0xd9342b };

/** Post one message to a webhook. Returns why it failed, or null. */
async function post(kind: Exclude<SubscriberKind, "email">, url: string, m: Message): Promise<string | null> {
  const line = `${m.title} · ${m.state}`;
  const body =
    kind === "slack"
      ? { text: `*${m.title}* · ${m.state}\n${m.message}\n<${m.url}|${m.page.name} status>` }
      : kind === "discord"
        ? { username: m.page.name.slice(0, 80), embeds: [{ title: line.slice(0, 256), description: m.message.slice(0, 4000), url: m.url, color: COLOR[m.level] }] }
        : {
            page: m.page,
            event: m.event,
            title: m.title,
            state: m.state,
            message: m.message,
            url: m.url,
            incident: m.notice,
          };
  try {
    const res = await publicRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Serve status page" },
      body: JSON.stringify(body),
      timeoutMs: 10_000,
    });
    return res.status >= 200 && res.status < 300 ? null : `it answered ${res.status}${res.text ? `: ${res.text.slice(0, 120)}` : ""}`;
  } catch (e) {
    return (e as Error).message;
  }
}

async function deliver(page: Page, subscriber: Subscriber, m: Message) {
  let error: string | null = null;
  if (subscriber.kind === "email") {
    const unsubscribe = `${m.page.url}/unsubscribe?token=${encodeURIComponent(subscriber.token)}`;
    const { html, text } = renderEmail({
      brand: page.name,
      heading: m.title,
      paragraphs: [m.state, ...m.message.split("\n").filter(Boolean)],
      details: m.notice?.components.length ? [{ label: "Affected", value: m.notice.components.join(", ") }] : undefined,
      action: { label: "View the status page", url: m.url },
      note: `You get this because you subscribed to ${page.name}. Unsubscribe: ${unsubscribe}`,
    });
    await sendEmail({ to: subscriber.target, subject: `[${page.name}] ${m.title}`, text, html }).catch((e) => {
      error = (e as Error).message;
    });
  } else {
    const url = decryptOrNull(subscriber.target);
    error = url ? await post(subscriber.kind, url, m) : "The stored address could not be read.";
  }
  if (!error) {
    await db.update(schema.statusSubscriber).set({ failures: 0, lastError: null, lastSentAt: new Date() }).where(eq(schema.statusSubscriber.id, subscriber.id));
    return;
  }
  // A webhook that keeps failing is gone on the other side: stop trying. Email failures are Serve's own (settings).
  if (subscriber.kind !== "email" && subscriber.failures + 1 >= MAX_FAILURES) {
    await db.delete(schema.statusSubscriber).where(eq(schema.statusSubscriber.id, subscriber.id));
    return;
  }
  await db
    .update(schema.statusSubscriber)
    .set({ failures: sql`${schema.statusSubscriber.failures} + 1`, lastError: error.slice(0, 500) })
    .where(eq(schema.statusSubscriber.id, subscriber.id));
}

/** Send a message to the page's confirmed subscribers (those following an affected component) and its team channels. */
async function broadcast(page: Page, componentIds: string[], m: Message, notify = true) {
  if (notify) {
    const cfg = subscribeOf(page.subscribe);
    const subscribers = await db
      .select()
      .from(schema.statusSubscriber)
      .where(and(eq(schema.statusSubscriber.pageId, page.id), eq(schema.statusSubscriber.confirmed, true)));
    // Kinds the page no longer offers stay saved but quiet, so offering them again picks them back up.
    const offered = subscribers.filter((s) => cfg[s.kind]);
    const wanted = offered.filter((s) => !s.componentIds.length || !componentIds.length || s.componentIds.some((id) => componentIds.includes(id)));
    // A few at a time: a page with thousands of subscribers must not open thousands of connections.
    for (let i = 0; i < wanted.length; i += 8) await Promise.all(wanted.slice(i, i + 8).map((s) => deliver(page, s, m)));
  }
  if (page.teamChannelIds.length) {
    const { notifyChannels } = await import("@/server/notifications/deliver");
    await notifyChannels(page.organizationId, page.teamChannelIds, "status.incident", {
      title: `${page.name}: ${m.title}`,
      body: `${m.state}${m.message ? `\n${m.message}` : ""}`,
      url: m.url,
      ok: m.level === "operational",
      severity: m.level === "major" || m.level === "partial" ? "critical" : m.level === "degraded" ? "warning" : "info",
      status: m.state.toLowerCase(),
      dedupKey: m.notice ? `status:${m.notice.id}` : null,
      data: { statusPageId: page.id, event: m.event, incident: m.notice },
    });
  }
}

const levelOf = (kind: string, impact: string, done: boolean): Message["level"] =>
  done ? "operational" : kind === "maintenance" ? "maintenance" : impact === "minor" ? "degraded" : impact === "major" ? "partial" : "major";

/** Tell subscribers and team channels about a notice: posted, updated, or a maintenance window starting or ending. */
export async function notifyNotice(noticeId: string, event: StatusEvent, opts: { notify?: boolean } = {}) {
  const [row] = await db
    .select({ notice: schema.statusNotice, page: schema.statusPage })
    .from(schema.statusNotice)
    .innerJoin(schema.statusPage, eq(schema.statusNotice.pageId, schema.statusPage.id))
    .where(eq(schema.statusNotice.id, noticeId));
  if (!row) return;
  const { notice: n, page } = row;
  // A draft or a password page has no public audience; its team channels still hear about it.
  const audience = page.visibility === "public" && opts.notify !== false;
  const words = labelsOf(designOf(page.design));
  const [latest] = await db
    .select()
    .from(schema.statusNoticeUpdate)
    .where(eq(schema.statusNoticeUpdate.noticeId, n.id))
    .orderBy(sql`${schema.statusNoticeUpdate.createdAt} desc`)
    .limit(1);
  const names = n.componentIds.length
    ? (
        await db.select({ id: schema.statusComponent.id, name: schema.statusComponent.name }).from(schema.statusComponent).where(inArray(schema.statusComponent.id, n.componentIds))
      ).map((c) => c.name)
    : [];
  const phase =
    n.kind === "maintenance"
      ? event === "maintenance-started"
        ? "in-progress"
        : event === "maintenance-ended"
          ? "completed"
          : maintenancePhase({ startsAt: n.startsAt?.toISOString() ?? null, endsAt: n.endsAt?.toISOString() ?? null, resolvedAt: n.resolvedAt?.toISOString() ?? null })
      : null;
  const state = words[`state.${phase ?? n.state}` as LabelKey] ?? n.state;
  const when =
    n.kind === "maintenance" && n.startsAt && n.endsAt && phase === "scheduled"
      ? `From ${n.startsAt.toUTCString().replace(" GMT", " UTC")} to ${n.endsAt.toUTCString().replace(" GMT", " UTC")}.`
      : "";
  const url = await pageUrl(page);
  const done = phase ? phase === "completed" : !!n.resolvedAt;
  const m: Message = {
    page: { name: page.name, url },
    event,
    title: n.title,
    state: n.kind === "incident" && !done ? `${state} · ${IMPACT_TEXT[n.impact]}` : state,
    message: [latest?.body ?? "", when].filter(Boolean).join("\n"),
    url,
    level: levelOf(n.kind, n.impact, done),
    notice: {
      id: n.id,
      kind: n.kind,
      impact: n.kind === "incident" ? n.impact : null,
      components: names,
      startsAt: n.startsAt?.toISOString() ?? null,
      endsAt: n.endsAt?.toISOString() ?? null,
      resolvedAt: n.resolvedAt?.toISOString() ?? null,
    },
  };
  await broadcast(page, n.componentIds, m, audience);
}

/**
 * An uptime check found a service down, or back. Pages that show such outages and chose to send
 * them tell their subscribers (and team channels), unless a maintenance window covers it.
 */
export async function notifyOutage(serviceId: string, incident: { id: string; startedAt: Date; resolvedAt: Date | null }) {
  const rows = await db
    .select({ page: schema.statusPage, componentId: schema.statusComponent.id, name: schema.statusComponent.name })
    .from(schema.statusComponent)
    .innerJoin(schema.statusPage, eq(schema.statusComponent.pageId, schema.statusPage.id))
    .where(eq(schema.statusComponent.serviceId, serviceId));
  const byPage = new Map<string, { page: Page; components: { id: string; name: string }[] }>();
  for (const r of rows) {
    const entry = byPage.get(r.page.id) ?? { page: r.page, components: [] };
    entry.components.push({ id: r.componentId, name: r.name });
    byPage.set(r.page.id, entry);
  }
  for (const { page, components } of byPage.values()) {
    const design = designOf(page.design);
    if (!design.autoIncidents || !subscribeOf(page.subscribe).outages) continue;
    const ids = components.map((c) => c.id);
    const at = incident.startedAt;
    const planned = await db
      .select({ ids: schema.statusNotice.componentIds })
      .from(schema.statusNotice)
      .where(
        and(
          eq(schema.statusNotice.pageId, page.id),
          eq(schema.statusNotice.kind, "maintenance"),
          lte(schema.statusNotice.startsAt, at),
          or(gte(schema.statusNotice.resolvedAt, at), and(isNull(schema.statusNotice.resolvedAt), gte(schema.statusNotice.endsAt, at))),
        ),
      );
    if (planned.some((p) => p.ids.some((id) => ids.includes(id)))) continue;
    const words = labelsOf(design);
    const name = components.map((c) => c.name).join(", ");
    const url = await pageUrl(page);
    const back = !!incident.resolvedAt;
    await broadcast(
      page,
      ids,
      {
        page: { name: page.name, url },
        event: back ? "outage-resolved" : "outage",
        title: (back ? words.outageOnePast : words.outageOne).replace("{name}", name),
        state: back ? words["state.resolved"] : words["state.investigating"],
        message: "",
        url,
        level: back ? "operational" : "major",
        notice: {
          id: `outage-${incident.id}`,
          kind: "outage",
          impact: "critical",
          components: components.map((c) => c.name),
          startsAt: incident.startedAt.toISOString(),
          endsAt: null,
          resolvedAt: incident.resolvedAt?.toISOString() ?? null,
        },
      },
      page.visibility === "public",
    );
  }
}

/** Maintenance windows that started or ended since the last look: subscribers hear it once. */
export async function maintenanceTick() {
  const now = new Date();
  const started = await db
    .select({ id: schema.statusNotice.id })
    .from(schema.statusNotice)
    .where(
      and(
        eq(schema.statusNotice.kind, "maintenance"),
        eq(schema.statusNotice.startNotified, false),
        lte(schema.statusNotice.startsAt, now),
        isNull(schema.statusNotice.resolvedAt),
        or(isNull(schema.statusNotice.endsAt), gt(schema.statusNotice.endsAt, now)),
      ),
    );
  for (const n of started) {
    await db.update(schema.statusNotice).set({ startNotified: true }).where(eq(schema.statusNotice.id, n.id));
    await notifyNotice(n.id, "maintenance-started");
  }
  // Ended by time (a window completed by hand was announced with its update).
  const ended = await db
    .select({ id: schema.statusNotice.id, startNotified: schema.statusNotice.startNotified })
    .from(schema.statusNotice)
    .where(
      and(eq(schema.statusNotice.kind, "maintenance"), eq(schema.statusNotice.endNotified, false), isNull(schema.statusNotice.resolvedAt), lte(schema.statusNotice.endsAt, now)),
    );
  for (const n of ended) {
    await db.update(schema.statusNotice).set({ endNotified: true, startNotified: true }).where(eq(schema.statusNotice.id, n.id));
    // A window that ended before anyone heard it start (the worker was down): one message, not two.
    await notifyNotice(n.id, "maintenance-ended");
  }
}
