import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {}, sql: {} }));
vi.mock("@/server/proxy/nginx", () => ({ activeServers: vi.fn() }));
import { normalizeAccessLine } from "@/server/analytics";
import { caddyLogAppend, caddyMainConfig } from "@/server/proxy/caddy";
import { filterFromQuery, type LogTarget, parseCursor, requestLogConfig, requestRow, targetFor } from "@/server/request-log";

const target = (patch: Partial<LogTarget["config"]> = {}): LogTarget => ({
  serviceId: "svc",
  projectId: "p",
  orgId: "o",
  config: { enabled: true, days: 7, statuses: [4, 5], ips: true, ...patch },
});

describe("access log lines carry what the request log keeps", () => {
  it("nginx: method, agent, referer and the upstream", () => {
    const e = normalizeAccessLine(
      JSON.stringify({
        t: "2026-10-05T10:00:00+00:00",
        h: "a.test",
        m: "POST",
        u: "/login?next=/x",
        s: 502,
        b: 10,
        rt: 0.25,
        ip: "1.2.3.4",
        ua: "curl/8",
        ref: "",
        up: "172.18.0.5:80",
      }),
    )!;
    expect(e).toMatchObject({ m: "POST", ua: "curl/8", up: "172.18.0.5:80" });
  });

  it("Caddy: method and headers from the request, the upstream from log_append", () => {
    const e = normalizeAccessLine(
      JSON.stringify({
        ts: 1791180000.5,
        status: 500,
        size: 5,
        duration: 0.01,
        upstream: "serve-link-10-240-1-5:80",
        request: { host: "a.test:443", uri: "/", method: "GET", client_ip: "1.2.3.4", headers: { "User-Agent": ["Mozilla/5.0"], Referer: ["https://b.test/"] } },
      }),
    )!;
    expect(e).toMatchObject({ h: "a.test", m: "GET", ua: "Mozilla/5.0", ref: "https://b.test/", up: "serve-link-10-240-1-5:80" });
  });

  it("Traefik: method, kept headers and the service address", () => {
    const e = normalizeAccessLine(
      JSON.stringify({
        RequestHost: "a.test",
        RequestPath: "/api",
        RequestMethod: "DELETE",
        DownstreamStatus: 404,
        Duration: 2e6,
        ServiceAddr: "web-abc123-dep9xy-2:3000",
        "request_User-Agent": "Go-http-client/1.1",
        StartUTC: "2026-10-05T10:00:00Z",
      }),
    )!;
    expect(e).toMatchObject({ m: "DELETE", ua: "Go-http-client/1.1", up: "web-abc123-dep9xy-2:3000", s: 404 });
  });
});

describe("what a request log row keeps", () => {
  const entry = {
    t: "2026-10-05T10:00:00Z",
    h: "A.test",
    s: 503,
    b: 120,
    rt: 1.2345,
    u: "/reset?token=secret",
    ip: "1.2.3.4",
    m: "GET",
    ua: "-",
    ref: "-",
    up: "10.0.0.1:80, 172.18.0.7:80",
  };

  it("drops the query string (it can hold tokens) and keeps that there was one", () => {
    const row = requestRow(entry, target(), "local")!;
    expect(row.path).toBe("/reset");
    expect(row.query).toBe(true);
    expect(JSON.stringify(row)).not.toContain("secret");
    expect(requestRow({ ...entry, u: "/a?" }, target(), "local")!.query).toBe(false);
  });

  it("keeps only the chosen status groups", () => {
    expect(requestRow({ ...entry, s: 200 }, target(), "local")).toBeNull();
    expect(requestRow({ ...entry, s: 404 }, target(), "local")).not.toBeNull();
    expect(requestRow({ ...entry, s: 200 }, target({ statuses: [2] }), "local")).not.toBeNull();
    expect(requestRow({ ...entry, s: 0 }, target({ statuses: [2, 3, 4, 5] }), "local")).toBeNull();
  });

  it("leaves out the visitor IP when the service does not keep it, and empty nginx fields", () => {
    const row = requestRow(entry, target({ ips: false }), "local")!;
    expect(row.ip).toBeNull();
    expect(row.userAgent).toBeNull();
    expect(row.referer).toBeNull();
  });

  it("keeps the upstream that answered last, the time in ms and a lowercase host", () => {
    const row = requestRow(entry, target(), "local")!;
    expect(row.upstream).toBe("172.18.0.7:80");
    // Serve's error page replaced the app's 5xx page: the app's replica still answered.
    expect(requestRow({ ...entry, up: "web-abc123-dep9xy-2:80, serve-proxy-pages:80" }, target(), "local")!.upstream).toBe("web-abc123-dep9xy-2:80");
    expect(requestRow({ ...entry, up: "serve-proxy-pages:80" }, target(), "local")!.upstream).toBeNull();
    expect(row.durationMs).toBe(1235);
    expect(row.hostname).toBe("a.test");
  });

  it("cuts very long fields", () => {
    const row = requestRow({ ...entry, u: `/${"a".repeat(10_000)}`, ua: "b".repeat(5000) }, target(), "local")!;
    expect(row.path.length).toBe(2048);
    expect(row.userAgent!.length).toBe(512);
  });
});

describe("request log settings and filters", () => {
  it("is off with 4xx and 5xx for a week until set up", () => {
    expect(requestLogConfig(null)).toEqual({ enabled: false, days: 7, statuses: [4, 5], ips: true });
    expect(requestLogConfig({ enabled: true, days: 0, statuses: [5, 5, 9 as never, 2] })).toMatchObject({ enabled: true, days: 7, statuses: [2, 5] });
    expect(requestLogConfig({ enabled: true, days: 400, statuses: [5] }).days).toBe(400);
  });

  it("matches a domain exactly, else its wildcard", () => {
    const targets = new Map<string, LogTarget | null>([
      ["a.test", target()],
      ["*.apps.test", { ...target(), serviceId: "wild" }],
    ]);
    expect(targetFor(targets, "A.TEST")?.serviceId).toBe("svc");
    expect(targetFor(targets, "x.apps.test")?.serviceId).toBe("wild");
    expect(targetFor(targets, "y.x.apps.test")).toBeUndefined();
    expect(targetFor(targets, "b.test")).toBeUndefined();
  });

  it("never gives a wildcard a host that is another service's own domain, log or no log", () => {
    const targets = new Map<string, LogTarget | null>([
      ["*.apps.test", { ...target(), serviceId: "wild" }],
      ["shop.apps.test", null],
      ["blog.apps.test", { ...target(), serviceId: "blog" }],
    ]);
    expect(targetFor(targets, "shop.apps.test")).toBeUndefined();
    expect(targetFor(targets, "blog.apps.test")?.serviceId).toBe("blog");
    expect(targetFor(targets, "other.apps.test")?.serviceId).toBe("wild");
  });

  it("reads filters from a query and ignores what it cannot use", () => {
    const f = filterFromQuery(new URLSearchParams("status=5xx,4,9,x&path=%20/api%20&from=1791180000&to=bad&before=2026-10-05T10:00:00.000Z_42&limit=20"));
    expect(f.statuses).toEqual([5, 4]);
    expect(f.path).toBe("/api");
    expect(f.from?.toISOString()).toBe(new Date(1791180000 * 1000).toISOString());
    expect(f.to).toBeUndefined();
    expect(f.before).toEqual({ time: new Date("2026-10-05T10:00:00.000Z"), id: 42 });
    expect(parseCursor("nope")).toBeNull();
  });
});

describe("Caddy logs the upstream only where it can", () => {
  it("from Caddy 2.8 on; an image without a version counts as older", () => {
    expect(caddyLogAppend("caddy:2.11.4-alpine")).toBe(true);
    expect(caddyLogAppend("caddy:2.8")).toBe(true);
    expect(caddyLogAppend("caddy:2.7.6-alpine")).toBe(false);
    expect(caddyLogAppend("caddy:latest")).toBe(false);
    expect(caddyLogAppend("caddy")).toBe(false);
  });

  it("adds log_append to the log snippet only when asked", () => {
    const visitor = { tunnel: [], ranges: [], header: null };
    expect(caddyMainConfig({}, { email: null, staging: false, visitor, logUpstream: true })).toContain("log_append upstream {http.reverse_proxy.upstream.hostport}");
    expect(caddyMainConfig({}, { email: null, staging: false, visitor })).not.toContain("log_append");
  });
});
