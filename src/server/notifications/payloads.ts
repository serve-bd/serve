import { createHmac, randomUUID } from "node:crypto";
import type { Severity } from "@/lib/notifications";

/** One notification, resolved and ready to send. Also the stored form used for retries. */
export type OutgoingMessage = {
  id: string;
  event: string;
  eventLabel: string;
  severity: Severity;
  ok: boolean;
  status: string;
  title: string;
  body: string;
  /** Absolute link into the dashboard. */
  url: string | null;
  error: string | null;
  /** Ties a problem to its recovery (opens and resolves on-call alerts). */
  dedupKey: string | null;
  occurredAt: string;
  organization: { id: string; name: string };
  project: { id: string; name: string } | null;
  environment: { id: string; name: string } | null;
  service: { id: string; name: string; type: string } | null;
  server: { id: string; name: string } | null;
  deployment: { id: string } | null;
  data: Record<string, unknown>;
  /** Product name the message comes from (white-label). */
  brand?: string;
  /** Email addresses an earlier attempt already reached; a retry skips them. */
  emailedTo?: string[];
};

export type HttpRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Fixed official API host: sent with fetch. Others go through the private-network guard. */
  trusted: boolean;
};

export type Plan = { kind: "http"; requests: HttpRequest[] } | { kind: "email"; to: string[] } | { kind: "skip"; reason: string };

const json = { "content-type": "application/json" };

const color = (m: OutgoingMessage) => (m.ok ? 0x22c55e : m.severity === "critical" ? 0xef4444 : m.severity === "warning" ? 0xf59e0b : 0x3b82f6);
const hex = (m: OutgoingMessage) => `#${color(m).toString(16).padStart(6, "0")}`;
const icon = (m: OutgoingMessage) => (m.ok ? "✅" : m.severity === "critical" ? "🚨" : m.severity === "warning" ? "⚠️" : "ℹ️");

/** Where it happened, like "Shop / production / api". */
/** The sender name shown on messages. */
export function brandOf(m: OutgoingMessage) {
  return m.brand || "Serve";
}

export function where(m: OutgoingMessage) {
  return [m.project?.name, m.environment?.name, m.service?.name].filter(Boolean).join(" / ") || m.server?.name || m.organization.name;
}

export function plainText(m: OutgoingMessage) {
  return [`${icon(m)} ${m.title}`, m.body, m.url].filter(Boolean).join("\n");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Slack and Mattermost treat <, > and & as markup. */
const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function list(value: string | undefined, max: number) {
  return (value ?? "")
    .split(/[,;\s]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** "Name: value" lines. Refuses names HTTP does not allow and headers the sender controls. */
export function parseHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i <= 0) throw new Error(`Header line "${line.slice(0, 40)}" needs the form Name: value.`);
    const name = line.slice(0, i).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error(`"${name}" is not a valid header name.`);
    if (/^(host|content-length|transfer-encoding|connection|x-serve-signature|x-serve-timestamp)$/i.test(name)) throw new Error(`Serve sets the ${name} header itself.`);
    out[name] = line.slice(i + 1).trim();
  }
  return out;
}

/** HMAC-SHA256 of "<timestamp>.<body>", hex encoded. */
export function signWebhook(secret: string, timestamp: number, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** The stable, documented webhook body (version 1). */
export function webhookBody(m: OutgoingMessage) {
  return {
    version: 1,
    id: m.id,
    event: m.event,
    occurredAt: m.occurredAt,
    severity: m.severity,
    ok: m.ok,
    status: m.status,
    title: m.title,
    body: m.body,
    error: m.error,
    url: m.url,
    organization: m.organization,
    project: m.project,
    environment: m.environment,
    service: m.service,
    server: m.server,
    deployment: m.deployment,
    data: m.data,
  };
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** Builds the requests a provider needs, following each provider's API. Pure, so it is tested directly. */
export function planDelivery(kind: string, config: Record<string, string>, m: OutgoingMessage, now = Date.now()): Plan {
  const c = (k: string) => config[k]?.trim() ?? "";
  switch (kind) {
    case "email":
      return { kind: "email", to: list(c("to"), 20) };

    case "discord":
      return {
        kind: "http",
        requests: [
          {
            url: c("webhookUrl"),
            method: "POST",
            headers: json,
            trusted: false,
            body: JSON.stringify({
              username: c("username") || undefined,
              allowed_mentions: { parse: [] },
              embeds: [
                {
                  title: m.title.slice(0, 256),
                  description: m.body.slice(0, 4000) || undefined,
                  url: m.url ?? undefined,
                  color: color(m),
                  timestamp: m.occurredAt,
                  footer: { text: `${m.eventLabel} · ${where(m)}`.slice(0, 2048) },
                },
              ],
            }),
          },
        ],
      };

    case "slack": {
      const text = `${icon(m)} *${escapeSlack(m.title)}*`;
      return {
        kind: "http",
        requests: [
          {
            url: c("webhookUrl"),
            method: "POST",
            headers: json,
            trusted: false,
            body: JSON.stringify({
              text: `${icon(m)} ${m.title}`,
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: m.body ? `${text}\n${escapeSlack(m.body).slice(0, 2900)}` : text } },
                {
                  type: "context",
                  elements: [{ type: "mrkdwn", text: `${escapeSlack(m.eventLabel)} · ${escapeSlack(where(m))}${m.url ? ` · <${m.url}|Open in ${brandOf(m)}>` : ""}` }],
                },
              ],
            }),
          },
        ],
      };
    }

    case "mattermost":
    case "rocketchat":
      return {
        kind: "http",
        requests: [
          {
            url: c("webhookUrl"),
            method: "POST",
            headers: json,
            trusted: false,
            body: JSON.stringify({
              ...(kind === "mattermost" ? { username: c("username") || undefined } : { alias: brandOf(m) }),
              channel: c("channel") || undefined,
              text: `${icon(m)} **${m.title}**`,
              attachments: [
                {
                  fallback: m.title,
                  color: hex(m),
                  title: m.eventLabel,
                  title_link: m.url ?? undefined,
                  text: [m.body, where(m)].filter(Boolean).join("\n"),
                },
              ],
            }),
          },
        ],
      };

    case "teams":
      return {
        kind: "http",
        requests: [
          {
            url: c("webhookUrl"),
            method: "POST",
            headers: json,
            trusted: false,
            body: JSON.stringify({
              type: "message",
              attachments: [
                {
                  contentType: "application/vnd.microsoft.card.adaptive",
                  contentUrl: null,
                  content: {
                    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                    type: "AdaptiveCard",
                    version: "1.4",
                    body: [
                      {
                        type: "TextBlock",
                        size: "Medium",
                        weight: "Bolder",
                        wrap: true,
                        text: `${icon(m)} ${m.title}`,
                        color: m.ok ? "Good" : m.severity === "info" ? "Default" : "Attention",
                      },
                      ...(m.body ? [{ type: "TextBlock", wrap: true, text: m.body }] : []),
                      { type: "TextBlock", wrap: true, isSubtle: true, spacing: "Small", text: `${m.eventLabel} · ${where(m)}` },
                    ],
                    actions: m.url ? [{ type: "Action.OpenUrl", title: `Open in ${brandOf(m)}`, url: m.url }] : [],
                  },
                },
              ],
            }),
          },
        ],
      };

    case "googlechat":
      return {
        kind: "http",
        requests: [
          {
            url: c("webhookUrl"),
            method: "POST",
            headers: { "content-type": "application/json; charset=UTF-8" },
            trusted: false,
            body: JSON.stringify({
              text: [`${icon(m)} *${m.title}*`, m.body, `_${m.eventLabel} · ${where(m)}_`, m.url ? `<${m.url}|Open in ${brandOf(m)}>` : ""].filter(Boolean).join("\n"),
            }),
          },
        ],
      };

    case "telegram": {
      const html = [
        `${icon(m)} <b>${escapeHtml(m.title)}</b>`,
        m.body && escapeHtml(m.body),
        `<i>${escapeHtml(`${m.eventLabel} · ${where(m)}`)}</i>`,
        m.url && `<a href="${escapeHtml(m.url)}">Open in ${escapeHtml(brandOf(m))}</a>`,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        kind: "http",
        requests: [
          {
            url: `https://api.telegram.org/bot${c("botToken")}/sendMessage`,
            method: "POST",
            headers: json,
            trusted: true,
            body: JSON.stringify({
              chat_id: c("chatId"),
              message_thread_id: c("threadId") ? Number(c("threadId")) : undefined,
              text: html.slice(0, 4096),
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
            }),
          },
        ],
      };
    }

    case "matrix": {
      const html = [
        `${icon(m)} <b>${escapeHtml(m.title)}</b>`,
        m.body && escapeHtml(m.body).replace(/\n/g, "<br>"),
        m.url && `<a href="${escapeHtml(m.url)}">Open in ${escapeHtml(brandOf(m))}</a>`,
      ]
        .filter(Boolean)
        .join("<br>");
      return {
        kind: "http",
        requests: [
          {
            url: `${trimSlash(c("homeserver"))}/_matrix/client/v3/rooms/${encodeURIComponent(c("roomId"))}/send/m.room.message/${encodeURIComponent(`serve-${m.id}-${randomUUID()}`)}`,
            method: "PUT",
            headers: { ...json, authorization: `Bearer ${c("accessToken")}` },
            trusted: false,
            body: JSON.stringify({ msgtype: m.ok || m.severity === "info" ? "m.notice" : "m.text", body: plainText(m), format: "org.matrix.custom.html", formatted_body: html }),
          },
        ],
      };
    }

    case "ntfy": {
      const server = trimSlash(c("server") || "https://ntfy.sh");
      return {
        kind: "http",
        requests: [
          {
            url: server,
            method: "POST",
            headers: { ...json, ...(c("token") ? { authorization: `Bearer ${c("token")}` } : {}) },
            trusted: server === "https://ntfy.sh",
            body: JSON.stringify({
              topic: c("topic"),
              title: m.title,
              message: m.body || m.eventLabel,
              priority: m.ok || m.severity === "info" ? 3 : m.severity === "critical" ? 5 : 4,
              tags: [m.ok ? "white_check_mark" : m.severity === "critical" ? "rotating_light" : m.severity === "warning" ? "warning" : "information_source"],
              click: m.url ?? undefined,
            }),
          },
        ],
      };
    }

    case "gotify":
      return {
        kind: "http",
        requests: [
          {
            url: `${trimSlash(c("server"))}/message`,
            method: "POST",
            headers: { ...json, "x-gotify-key": c("token") },
            trusted: false,
            body: JSON.stringify({
              title: m.title,
              message: m.url ? `${m.body}\n\n${m.url}`.trim() : m.body || m.eventLabel,
              priority: m.ok || m.severity === "info" ? 4 : m.severity === "critical" ? 9 : 7,
              extras: m.url ? { "client::notification": { click: { url: m.url } } } : undefined,
            }),
          },
        ],
      };

    case "pushover":
      return {
        kind: "http",
        requests: [
          {
            url: "https://api.pushover.net/1/messages.json",
            method: "POST",
            headers: json,
            trusted: true,
            body: JSON.stringify({
              token: c("token"),
              user: c("user"),
              device: c("device") || undefined,
              title: m.title.slice(0, 250),
              message: (m.body || m.eventLabel).slice(0, 1024),
              url: m.url ?? undefined,
              url_title: m.url ? `Open in ${brandOf(m)}` : undefined,
              priority: m.ok || m.severity === "info" ? 0 : 1,
              timestamp: Math.floor(new Date(m.occurredAt).getTime() / 1000),
            }),
          },
        ],
      };

    case "pushbullet":
      return {
        kind: "http",
        requests: [
          {
            url: "https://api.pushbullet.com/v2/pushes",
            method: "POST",
            headers: { ...json, "access-token": c("accessToken") },
            trusted: true,
            body: JSON.stringify({
              type: m.url ? "link" : "note",
              title: m.title,
              body: m.body || m.eventLabel,
              url: m.url ?? undefined,
              channel_tag: c("channelTag") || undefined,
            }),
          },
        ],
      };

    case "pagerduty": {
      const dedup = m.dedupKey ?? `${m.event}:${m.service?.id ?? m.server?.id ?? m.id}`;
      if (m.ok) {
        // A success resolves the alert its failure opened; with nothing to resolve there is nothing to page about.
        if (!m.dedupKey) return { kind: "skip", reason: "On-call channels only receive problems and their recoveries." };
        return {
          kind: "http",
          requests: [
            {
              url: "https://events.pagerduty.com/v2/enqueue",
              method: "POST",
              headers: json,
              trusted: true,
              body: JSON.stringify({ routing_key: c("routingKey"), event_action: "resolve", dedup_key: m.dedupKey }),
            },
          ],
        };
      }
      return {
        kind: "http",
        requests: [
          {
            url: "https://events.pagerduty.com/v2/enqueue",
            method: "POST",
            headers: json,
            trusted: true,
            body: JSON.stringify({
              routing_key: c("routingKey"),
              event_action: "trigger",
              dedup_key: dedup,
              payload: {
                summary: m.title.slice(0, 1024),
                source: m.server?.name ?? m.service?.name ?? "serve",
                severity: m.severity === "critical" ? "critical" : m.severity === "warning" ? "warning" : "info",
                timestamp: m.occurredAt,
                component: m.service?.name,
                group: m.project?.name,
                class: m.event,
                custom_details: { body: m.body, error: m.error, environment: m.environment?.name, organization: m.organization.name },
              },
              client: brandOf(m),
              client_url: m.url ?? undefined,
              links: m.url ? [{ href: m.url, text: `Open in ${brandOf(m)}` }] : [],
            }),
          },
        ],
      };
    }

    case "opsgenie": {
      const base = c("region") === "eu" ? "https://api.eu.opsgenie.com" : "https://api.opsgenie.com";
      const headers = { ...json, authorization: `GenieKey ${c("apiKey")}` };
      const alias = (m.dedupKey ?? `${m.event}:${m.service?.id ?? m.server?.id ?? m.id}`).slice(0, 512);
      if (m.ok) {
        if (!m.dedupKey) return { kind: "skip", reason: "On-call channels only receive problems and their recoveries." };
        return {
          kind: "http",
          requests: [
            {
              url: `${base}/v2/alerts/${encodeURIComponent(alias)}/close?identifierType=alias`,
              method: "POST",
              headers,
              trusted: true,
              body: JSON.stringify({ source: brandOf(m), note: m.title }),
            },
          ],
        };
      }
      return {
        kind: "http",
        requests: [
          {
            url: `${base}/v2/alerts`,
            method: "POST",
            headers,
            trusted: true,
            body: JSON.stringify({
              message: m.title.slice(0, 130),
              alias,
              description: [m.body, m.url].filter(Boolean).join("\n\n").slice(0, 15_000),
              priority: m.severity === "critical" ? "P1" : m.severity === "warning" ? "P3" : "P5",
              source: brandOf(m),
              entity: m.service?.name ?? m.server?.name,
              tags: [m.event, m.environment?.name].filter(Boolean),
              responders: c("responders") ? [{ name: c("responders"), type: "team" }] : undefined,
              details: { project: m.project?.name ?? "", environment: m.environment?.name ?? "", service: m.service?.name ?? "", server: m.server?.name ?? "" },
            }),
          },
        ],
      };
    }

    case "twilio": {
      const sid = c("accountSid");
      const from = c("from");
      const auth = `Basic ${Buffer.from(`${sid}:${c("authToken")}`).toString("base64")}`;
      const text = [`${m.ok ? "OK" : m.severity.toUpperCase()}: ${m.title}`, m.body, m.url].filter(Boolean).join("\n").slice(0, 1600);
      return {
        kind: "http",
        requests: list(c("to"), 10).map((to) => ({
          url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", authorization: auth },
          trusted: true,
          body: new URLSearchParams({ To: to, Body: text, ...(from.startsWith("MG") ? { MessagingServiceSid: from } : { From: from }) }).toString(),
        })),
      };
    }

    default: {
      // Generic webhook (also rows saved before providers had their own kinds).
      const body = JSON.stringify(webhookBody(m));
      const headers: Record<string, string> = {
        ...json,
        "user-agent": "Serve-Webhook/1",
        "x-serve-event": m.event,
        "x-serve-delivery": m.id,
        ...parseHeaders(config.headers),
      };
      if (c("secret")) {
        const ts = Math.floor(now / 1000);
        headers["x-serve-timestamp"] = String(ts);
        headers["x-serve-signature"] = `sha256=${signWebhook(c("secret"), ts, body)}`;
      }
      return { kind: "http", requests: [{ url: c("url"), method: c("method") || "POST", headers, body, trusted: false }] };
    }
  }
}
