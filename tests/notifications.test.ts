import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fillTemplate, notifyEventCatalog, type Provider, providers, webhookExample } from "@/lib/notifications";
import { type OutgoingMessage, parseHeaders, planDelivery, signWebhook, webhookBody } from "@/server/notifications/payloads";
import { channelWants, decide, inQuietHours, inScope, retryDelay, throttleSince } from "@/server/notifications/rules";
import { validateChannelConfig } from "@/server/notifications/validate";

const msg = (patch: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  id: "d1",
  event: "deploy.failed",
  eventLabel: "Deployment failed",
  severity: "warning",
  ok: false,
  status: "failed",
  title: "api failed to deploy",
  body: "Build <exited> & stopped",
  url: "https://serve.example.com/p/1",
  error: "Build exited",
  dedupKey: "deploy:s1",
  occurredAt: "2026-09-29T10:00:00.000Z",
  organization: { id: "o1", name: "Acme" },
  project: { id: "p1", name: "Shop" },
  environment: { id: "e1", name: "production" },
  service: { id: "s1", name: "api", type: "app" },
  server: { id: "local", name: "localhost" },
  deployment: { id: "dep1" },
  data: {},
  ...patch,
});

const one = (kind: string, config: Record<string, string>, m = msg()) => {
  const plan = planDelivery(kind, config, m, 1_700_000_000_000);
  if (plan.kind !== "http") throw new Error(`expected http, got ${plan.kind}`);
  return plan.requests;
};
const body = (r: { body?: string }) => JSON.parse(r.body ?? "{}");

describe("payload builders", () => {
  it("shows the details of a deploy as fields, and the error in a code block", () => {
    const m = msg({
      error: "Build exited with code 1\nnpm ERR! missing script: build",
      data: { commit: "abc1234def", commitMessage: "Fix login\nmore", branch: "main", trigger: "webhook", durationSeconds: 75, keptPreviousVersion: true },
    });
    const [r] = one("discord", { webhookUrl: "https://discord.com/api/webhooks/1/x" }, m);
    const fields = body(r).embeds[0].fields as { name: string; value: string }[];
    const get = (n: string) => fields.find((f) => f.name === n)?.value;
    expect(get("Project")).toBe("Shop");
    expect(get("Commit")).toBe("abc1234 Fix login");
    expect(get("Trigger")).toBe("Git push");
    expect(get("Ran for")).toBe("1m 15s");
    expect(get("Running")).toBe("The previous version keeps running");
    expect(get("Error")).toContain("missing script: build");
    const [slack] = one("slack", { webhookUrl: "https://hooks.slack.com/services/x" }, m);
    expect(JSON.stringify(body(slack).blocks)).toContain("*Branch*\\nmain");
  });

  it("Discord sends an embed with color and no mentions", () => {
    const [r] = one("discord", { webhookUrl: "https://discord.com/api/webhooks/1/x" });
    const b = body(r);
    expect(r.trusted).toBe(false);
    expect(b.allowed_mentions).toEqual({ parse: [] });
    expect(b.embeds[0]).toMatchObject({ title: "⚠️ api failed to deploy", url: "https://serve.example.com/p/1", color: 0xf59e0b });
  });

  it("Slack escapes markup in mrkdwn", () => {
    const [r] = one("slack", { webhookUrl: "https://hooks.slack.com/services/x" });
    expect(body(r).blocks[0].text.text).toContain("Build &lt;exited&gt; &amp; stopped");
  });

  it("Telegram uses HTML, escapes it and goes to the fixed API host", () => {
    const [r] = one("telegram", { botToken: "123:abc", chatId: "-100", threadId: "7" });
    expect(r.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(r.trusted).toBe(true);
    const b = body(r);
    expect(b).toMatchObject({ chat_id: "-100", message_thread_id: 7, parse_mode: "HTML" });
    expect(b.text).toContain("Build &lt;exited&gt; &amp; stopped");
  });

  it("Teams sends an Adaptive Card with an open link", () => {
    const [r] = one("teams", { webhookUrl: "https://example.webhook.office.com/x" });
    const card = body(r).attachments[0];
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content.actions[0]).toMatchObject({ type: "Action.OpenUrl", url: "https://serve.example.com/p/1" });
  });

  it("ntfy maps severity to priority and only trusts ntfy.sh", () => {
    const [r] = one("ntfy", { topic: "alerts" }, msg({ severity: "critical" }));
    expect(r.url).toBe("https://ntfy.sh");
    expect(r.trusted).toBe(true);
    expect(body(r)).toMatchObject({ topic: "alerts", priority: 5, click: "https://serve.example.com/p/1" });
    const [own] = one("ntfy", { topic: "alerts", server: "https://push.example.com/", token: "tk" });
    expect(own.url).toBe("https://push.example.com");
    expect(own.trusted).toBe(false);
    expect(own.headers.authorization).toBe("Bearer tk");
  });

  it("Gotify sends the app token as a header", () => {
    const [r] = one("gotify", { server: "https://gotify.example.com", token: "T" });
    expect(r.url).toBe("https://gotify.example.com/message");
    expect(r.headers["x-gotify-key"]).toBe("T");
  });

  it("Matrix PUTs a room message with a unique transaction id", () => {
    const [a] = one("matrix", { homeserver: "https://matrix.org", accessToken: "syt", roomId: "!r:matrix.org" });
    const [b] = one("matrix", { homeserver: "https://matrix.org", accessToken: "syt", roomId: "!r:matrix.org" });
    expect(a.method).toBe("PUT");
    expect(a.url).toMatch(/^https:\/\/matrix\.org\/_matrix\/client\/v3\/rooms\/!r%3Amatrix\.org\/send\/m\.room\.message\//);
    expect(a.url).not.toBe(b.url);
    expect(a.headers.authorization).toBe("Bearer syt");
  });

  it("PagerDuty triggers problems and resolves recoveries with the same dedup key", () => {
    const [t] = one("pagerduty", { routingKey: "k" });
    expect(body(t)).toMatchObject({ event_action: "trigger", dedup_key: "deploy:s1", payload: { severity: "warning", source: "localhost" } });
    const [r] = one("pagerduty", { routingKey: "k" }, msg({ ok: true, severity: "info" }));
    expect(body(r)).toEqual({ routing_key: "k", event_action: "resolve", dedup_key: "deploy:s1" });
    expect(planDelivery("pagerduty", { routingKey: "k" }, msg({ ok: true, dedupKey: null })).kind).toBe("skip");
  });

  it("Opsgenie creates alerts with an alias and closes them by alias", () => {
    const [c] = one("opsgenie", { apiKey: "g", region: "eu", responders: "Platform" }, msg({ severity: "critical" }));
    expect(c.url).toBe("https://api.eu.opsgenie.com/v2/alerts");
    expect(c.headers.authorization).toBe("GenieKey g");
    expect(body(c)).toMatchObject({ alias: "deploy:s1", priority: "P1", responders: [{ name: "Platform", type: "team" }] });
    const [close] = one("opsgenie", { apiKey: "g", region: "us" }, msg({ ok: true }));
    expect(close.url).toBe("https://api.opsgenie.com/v2/alerts/deploy%3As1/close?identifierType=alias");
  });

  it("Twilio sends one form-encoded request per number", () => {
    const reqs = one("twilio", { accountSid: "AC1", authToken: "t", from: "+15017122661", to: "+15558675310, +15558675311" });
    expect(reqs).toHaveLength(2);
    expect(reqs[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(reqs[0].headers.authorization).toBe(`Basic ${Buffer.from("AC1:t").toString("base64")}`);
    const params = new URLSearchParams(reqs[1].body);
    expect(params.get("To")).toBe("+15558675311");
    expect(params.get("From")).toBe("+15017122661");
    const [mg] = one("twilio", { accountSid: "AC1", authToken: "t", from: `MG${"a".repeat(32)}`, to: "+15558675310" });
    expect(new URLSearchParams(mg.body).get("MessagingServiceSid")).toBe(`MG${"a".repeat(32)}`);
  });

  it("Pushover and Pushbullet go to their API hosts", () => {
    const [po] = one("pushover", { token: "a", user: "u" });
    expect(po).toMatchObject({ url: "https://api.pushover.net/1/messages.json", trusted: true });
    expect(body(po)).toMatchObject({ priority: 1, url_title: "Open in Serve" });
    const [pb] = one("pushbullet", { accessToken: "o.x" });
    expect(pb.headers["access-token"]).toBe("o.x");
    expect(body(pb).type).toBe("link");
  });

  it("email plans the recipient list", () => {
    expect(planDelivery("email", { to: "a@x.co, b@x.co" }, msg())).toEqual({ kind: "email", to: ["a@x.co", "b@x.co"] });
  });

  it("every provider produces a plan", () => {
    for (const p of providers as readonly Provider[]) {
      const config = Object.fromEntries(
        p.fields.map((f) => [f.key, f.type === "url" || f.key.toLowerCase().includes("url") ? "https://example.com/h" : f.key === "headers" ? "X-A: 1" : "x"]),
      );
      expect(() => planDelivery(p.id, config, msg())).not.toThrow();
    }
  });
});

describe("webhook", () => {
  it("has the documented, stable body", () => {
    const b = webhookBody(msg());
    expect(Object.keys(b).sort()).toEqual(Object.keys(webhookExample).sort());
    expect(b).toMatchObject({ version: 1, event: "deploy.failed", project: { id: "p1", name: "Shop" }, deployment: { id: "dep1" } });
  });

  it("signs timestamp.body with HMAC-SHA256", () => {
    const [r] = one("webhook", { url: "https://example.com/h", method: "PUT", secret: "s3cret", headers: "Authorization: Bearer abc" });
    expect(r.method).toBe("PUT");
    expect(r.headers.Authorization).toBe("Bearer abc");
    expect(r.headers["x-serve-timestamp"]).toBe("1700000000");
    const expected = createHmac("sha256", "s3cret").update(`1700000000.${r.body}`).digest("hex");
    expect(r.headers["x-serve-signature"]).toBe(`sha256=${expected}`);
    expect(signWebhook("s3cret", 1700000000, r.body ?? "")).toBe(expected);
    expect(r.headers["x-serve-delivery"]).toBe("d1");
  });

  it("does not sign without a secret", () => {
    const [r] = one("webhook", { url: "https://example.com/h" });
    expect(r.headers["x-serve-signature"]).toBeUndefined();
    expect(r.method).toBe("POST");
  });

  it("parses custom headers and refuses ones Serve controls", () => {
    expect(parseHeaders("A: 1\n\n  B-2 : two:parts  ")).toEqual({ A: "1", "B-2": "two:parts" });
    expect(() => parseHeaders("no colon")).toThrow(/Name: value/);
    expect(() => parseHeaders("Bad Name: x")).toThrow(/valid header/);
    expect(() => parseHeaders("X-Serve-Signature: x")).toThrow(/sets/);
    expect(() => parseHeaders("host: x")).toThrow(/sets/);
  });
});

describe("rules", () => {
  const e = { event: "deploy.failed", severity: "warning" as const, ok: false, projectId: "p1", environmentId: "e1", serviceId: "s1" };
  it("matches events and minimum severity", () => {
    expect(channelWants({ events: ["deploy.failed"], scope: null, minSeverity: "info" }, e)).toBe(true);
    expect(channelWants({ events: ["deploy.success"], scope: null, minSeverity: "info" }, e)).toBe(false);
    expect(channelWants({ events: ["deploy.failed"], scope: null, minSeverity: "critical" }, e)).toBe(false);
    // A recovery closing an alert passes "problems only".
    expect(
      channelWants({ events: ["service.recovered"], scope: null, minSeverity: "warning" }, { ...e, event: "service.recovered", ok: true, severity: "info", dedup: true }),
    ).toBe(true);
    expect(channelWants({ events: ["deploy.success"], scope: null, minSeverity: "warning" }, { ...e, event: "deploy.success", ok: true, severity: "info" })).toBe(false);
  });

  it("filters by project, environment or service", () => {
    const scope = { projectIds: [], environmentIds: ["e2"], serviceIds: ["s1"], includeGlobal: false };
    expect(inScope(scope, e)).toBe(true);
    expect(inScope({ ...scope, serviceIds: [] }, e)).toBe(false);
    expect(inScope({ ...scope, serviceIds: [], projectIds: ["p1"] }, e)).toBe(true);
    expect(inScope(scope, { projectId: null, environmentId: null, serviceId: null })).toBe(false);
    expect(inScope({ ...scope, includeGlobal: true }, { projectId: null, environmentId: null, serviceId: null })).toBe(true);
    expect(inScope({ projectIds: [], environmentIds: [], serviceIds: [], includeGlobal: false }, e)).toBe(true);
  });

  it("knows quiet hours across midnight and time zones", () => {
    const q = { enabled: true, start: "22:00", end: "07:00", timezone: "UTC", allowCritical: true, digest: true };
    expect(inQuietHours(q, new Date("2026-01-01T23:30:00Z"))).toBe(true);
    expect(inQuietHours(q, new Date("2026-01-01T06:59:00Z"))).toBe(true);
    expect(inQuietHours(q, new Date("2026-01-01T07:00:00Z"))).toBe(false);
    expect(inQuietHours(q, new Date("2026-01-01T12:00:00Z"))).toBe(false);
    // 12:00 UTC is 21:30 in Adelaide (UTC+10:30 in January).
    expect(inQuietHours({ ...q, timezone: "Australia/Adelaide", start: "21:00", end: "22:00" }, new Date("2026-01-01T11:00:00Z"))).toBe(true);
    expect(inQuietHours({ ...q, start: "09:00", end: "17:00" }, new Date("2026-01-01T12:00:00Z"))).toBe(true);
    expect(inQuietHours({ ...q, enabled: false }, new Date("2026-01-01T23:30:00Z"))).toBe(false);
    expect(inQuietHours({ ...q, timezone: "Not/AZone" }, new Date("2026-01-01T23:30:00Z"))).toBe(true);
  });

  it("holds, drops, groups or sends", () => {
    const night = new Date("2026-01-01T23:30:00Z");
    const q = { enabled: true, start: "22:00", end: "07:00", timezone: "UTC", allowCritical: true, digest: true };
    expect(decide({ quietHours: q, severity: "warning", throttleMinutes: 0, lastSentAt: null, now: night })).toBe("hold");
    expect(decide({ quietHours: { ...q, digest: false }, severity: "warning", throttleMinutes: 0, lastSentAt: null, now: night })).toBe("suppress");
    expect(decide({ quietHours: q, severity: "critical", throttleMinutes: 0, lastSentAt: null, now: night })).toBe("send");
    expect(decide({ quietHours: { ...q, allowCritical: false }, severity: "critical", throttleMinutes: 0, lastSentAt: null, now: night })).toBe("hold");
    const noon = new Date("2026-01-01T12:00:00Z");
    expect(decide({ quietHours: q, severity: "info", throttleMinutes: 15, lastSentAt: new Date(noon.getTime() - 10 * 60_000), now: noon })).toBe("group");
    expect(decide({ quietHours: q, severity: "info", throttleMinutes: 15, lastSentAt: new Date(noon.getTime() - 20 * 60_000), now: noon })).toBe("send");
    expect(decide({ quietHours: null, severity: "info", throttleMinutes: 0, lastSentAt: noon, now: noon })).toBe("send");
  });

  it("backs off retries and stops", () => {
    expect([1, 2, 3, 4].map(retryDelay)).toEqual([60_000, 300_000, 1_800_000, null]);
  });
});

describe("templates", () => {
  it("fills known placeholders and keeps unknown ones", () => {
    expect(fillTemplate("{title} on {service} ({nope}) {error}", { title: "Down", service: "api", error: null })).toBe("Down on api ({nope}) ");
  });

  it("every event has a group and severity", () => {
    for (const ev of notifyEventCatalog) expect(ev.group && ev.severity).toBeTruthy();
  });
});

describe("validation", () => {
  it("keeps saved secrets when the field is left empty", () => {
    expect(validateChannelConfig("slack", { webhookUrl: "" }, { webhookUrl: "https://hooks.slack.com/services/a" })).toEqual({ webhookUrl: "https://hooks.slack.com/services/a" });
  });

  it("asks for saved secrets again when the server address changes", () => {
    const stored = { server: "https://gotify.example.com", token: "secret-token" };
    expect(validateChannelConfig("gotify", { server: "https://gotify.example.com/", token: "" }, stored).token).toBe("secret-token");
    expect(() => validateChannelConfig("gotify", { server: "https://evil.example.com", token: "" }, stored)).toThrow(/again/);
    expect(validateChannelConfig("gotify", { server: "https://evil.example.com", token: "new" }, stored).token).toBe("new");
  });

  it("requires https for chat webhooks and refuses credentials in URLs", () => {
    expect(() => validateChannelConfig("slack", { webhookUrl: "http://hooks.slack.com/x" })).toThrow(/https/);
    expect(() => validateChannelConfig("webhook", { url: "https://u:p@example.com" })).toThrow(/user name/);
    expect(validateChannelConfig("webhook", { url: "http://example.com/h" })).toMatchObject({ url: "http://example.com/h", method: "POST" });
  });

  it("checks provider formats", () => {
    expect(() => validateChannelConfig("telegram", { botToken: "nope", chatId: "1" })).toThrow(/BotFather/);
    expect(validateChannelConfig("telegram", { botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", chatId: "@alerts_room" }).chatId).toBe("@alerts_room");
    expect(() => validateChannelConfig("pagerduty", { routingKey: "short" })).toThrow(/32/);
    expect(() => validateChannelConfig("twilio", { accountSid: `AC${"0".repeat(32)}`, authToken: "t", from: "+15017122661", to: "555" })).toThrow(/phone numbers/);
    expect(validateChannelConfig("email", { to: "A@x.co; b@x.co" }).to).toBe("a@x.co, b@x.co");
    expect(() => validateChannelConfig("webhook", { url: "https://x.co", headers: "Host: x" })).toThrow(/sets/);
    expect(() => validateChannelConfig("matrix", { homeserver: "https://m.org", accessToken: "t", roomId: "room" })).toThrow(/room ID/);
    expect(() => validateChannelConfig("nope", {})).toThrow(/Unknown/);
  });
});

describe("throttling around recoveries", () => {
  it("sends down → recovered → down within the throttle window", () => {
    const now = new Date("2026-09-29T10:10:00Z");
    const downAt = new Date("2026-09-29T10:00:00Z");
    const throttle = (status: string, lastInGroup: Date | null, lastOfProblem: string | null) =>
      decide({ quietHours: null, severity: "critical", throttleMinutes: 30, lastSentAt: throttleSince({ status }, lastInGroup, lastOfProblem), now });
    // The recovery has its own event, so its group has nothing sent yet; it is never held back anyway.
    expect(throttle("recovered", downAt, "down")).toBe("send");
    // Down again: the group still holds the first alert, but the last message of the problem was a recovery.
    expect(throttle("down", downAt, "recovered")).toBe("send");
    // A repeat of a problem that is still down is grouped.
    expect(throttle("down", downAt, "down")).toBe("group");
  });
});
