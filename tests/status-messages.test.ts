import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-status-messages";
process.env.DATABASE_URL ??= "postgres://x@localhost/x";
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ db: {}, schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }) }));

const { discordBody, slackBody } = await import("@/server/status-pages/subscribers");
const { labelsOf } = await import("@/lib/status-page");

const page = { name: "Acme", url: "https://status.acme.com", iconUrl: "https://status.acme.com/icon?v=1", logoUrl: null, accent: "#7c3aed", words: labelsOf({ labels: {} }) };
const incident = {
  page,
  event: "created" as const,
  title: "Checkout errors",
  state: "Investigating",
  impact: "Partly down",
  message: "We are looking into it.",
  url: page.url,
  level: "partial" as const,
  notice: { id: "n1", kind: "incident" as const, impact: "major", components: ["API", "Website"], startsAt: "2026-10-06T10:00:00Z", endsAt: null, resolvedAt: null },
};
const maintenance = {
  ...incident,
  title: "Database upgrade",
  state: "Scheduled",
  impact: null,
  level: "maintenance" as const,
  notice: { ...incident.notice, kind: "maintenance" as const, impact: null, startsAt: "2026-10-07T22:00:00Z", endsAt: "2026-10-07T23:00:00Z" },
};

describe("status messages", () => {
  it("Discord: the page as the sender, status as fields, color by level", () => {
    const b = discordBody(incident);
    expect(b.username).toBe("Acme");
    expect(b.avatar_url).toBe(page.iconUrl);
    const e = b.embeds[0];
    expect(e.author.name).toBe("Acme");
    expect(e.title).toBe("Checkout errors");
    expect(e.color).toBe(0xe0601b);
    expect(e.fields.map((f) => f.name)).toEqual(["Status", "Impact", "Affected"]);
    expect(e.fields[0].value).toContain("Investigating");
    // Mentions in a visitor-visible message must never ping anyone.
    expect(b.allowed_mentions).toEqual({ parse: [] });
  });

  it("Discord: maintenance times in each reader's zone", () => {
    const e = discordBody(maintenance).embeds[0];
    const starts = e.fields.find((f) => f.name === "Starts");
    expect(starts?.value).toMatch(/^<t:\d+:f> \(<t:\d+:R>\)$/);
    expect(e.fields.some((f) => f.name === "Impact")).toBe(false);
  });

  it("Discord: no images from a page that is not public", () => {
    const b = discordBody({ ...incident, page: { ...page, iconUrl: null } });
    expect("avatar_url" in b).toBe(false);
    expect("icon_url" in b.embeds[0].author).toBe(false);
  });

  it("Discord: long text stays inside the limits", () => {
    const e = discordBody({ ...incident, title: "x".repeat(400), message: "y".repeat(5000) }).embeds[0];
    expect(e.title.length).toBeLessThanOrEqual(256);
    expect((e.description ?? "").length).toBeLessThanOrEqual(4096);
  });

  it("Slack: colored attachment with the page on top and a button, text escaped", () => {
    const b = slackBody({ ...incident, title: "<script> & co" });
    expect(b.text).toContain("<script>");
    const a = b.attachments[0];
    expect(a.color).toBe("#e0601b");
    const types = a.blocks.map((x) => x.type);
    expect(types).toEqual(["context", "section", "section", "actions"]);
    expect(JSON.stringify(a.blocks[1])).toContain("&lt;script&gt; &amp; co");
  });

  it("Slack: maintenance times as Slack dates", () => {
    expect(JSON.stringify(slackBody(maintenance))).toMatch(/<!date\^\d+\^\{date_short_pretty\} \{time\}\|/);
  });
});
