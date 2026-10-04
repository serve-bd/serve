import { beforeEach, describe, expect, it, vi } from "vitest";
import { Exposition, escapeHelp, escapeLabelValue } from "@/lib/prometheus";
import { buildExposition, type ExportInput, replicaOf } from "@/server/metrics-export/build";
import { cacheKey, staleWhileRevalidate, ttlCache } from "@/server/metrics-export/cache";
import type { ApiAuth } from "@/server/api-auth";
import type { Permission } from "@/lib/permissions";
import { grafanaDashboard, metricsUrl, prometheusScrapeConfig } from "@/lib/metrics-export";

const settings = { rootOrganizationId: "root" as string | null };
const instanceAdmins = new Set(["admin-user"]);
vi.mock("@/server/settings", () => ({ getSetting: async (k: "rootOrganizationId") => settings[k] }));
vi.mock("@/server/auth", () => ({ isInstanceAdmin: async (id: string) => instanceAdmins.has(id) }));
vi.mock("@/server/api-auth", () => ({ authenticateToken: async () => ({}) }));
const scrapes: unknown[] = [];
vi.mock("@/server/metrics-export", () => ({
  metricsText: async (scope: unknown) => {
    scrapes.push(scope);
    return "serve_service_up 1\n";
  },
}));

const { metricsRoutes, hostMetricsAllowed } = await import("@/server/api/routes/metrics");
const { resetRateLimits } = await import("@/server/api/rate-limit");

/** Every sample line of a metric: "labels value". */
function samples(text: string, name: string) {
  return text.split("\n").filter((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `));
}

describe("Prometheus text format", () => {
  it("escapes label values and help text", () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
    expect(escapeHelp('line\\one\ntwo "quoted"')).toBe('line\\\\one\\ntwo "quoted"');
    const e = new Exposition();
    e.gauge("x_value", "Help with\na line feed")({ name: 'my "app"\\prod\nnew' }, 1);
    expect(e.render()).toBe(["# HELP x_value Help with\\na line feed", "# TYPE x_value gauge", 'x_value{name="my \\"app\\"\\\\prod\\nnew"} 1', ""].join("\n"));
  });

  it("writes HELP and TYPE once per metric, before its samples", () => {
    const e = new Exposition();
    const g = e.gauge("a_bytes", "A");
    const c = e.counter("b_total", "B");
    g({ s: "1" }, 10);
    c({ s: "1" }, 3);
    g({ s: "2" }, 20);
    const lines = e.render().trim().split("\n");
    expect(lines).toEqual(["# HELP a_bytes A", "# TYPE a_bytes gauge", 'a_bytes{s="1"} 10', 'a_bytes{s="2"} 20', "# HELP b_total B", "# TYPE b_total counter", 'b_total{s="1"} 3']);
  });

  it("keeps counters and gauges apart", () => {
    const e = new Exposition();
    expect(() => e.counter("requests", "no _total")).toThrow();
    e.gauge("same_total", "x");
    expect(() => e.counter("same_total", "x")).toThrow();
    const c = e.counter("ok_total", "x");
    c({}, -1); // a counter never goes below zero: left out
    c({}, Number.NaN);
    const g = e.gauge("temp", "x");
    g({}, -5);
    g({ l: "skipped" }, null);
    const text = e.render();
    expect(samples(text, "ok_total")).toEqual([]);
    expect(text).not.toContain("# TYPE ok_total"); // no samples, no family
    expect(samples(text, "temp")).toEqual(["temp -5"]);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("refuses bad metric and label names", () => {
    const e = new Exposition();
    expect(() => e.gauge("1bad", "x")).toThrow();
    expect(() => e.gauge("good", "x")({ "bad-label": "v" }, 1)).toThrow();
  });
});

const NOW = 1_800_000_000_000;

function input(over: Partial<ExportInput> = {}): ExportInput {
  return {
    now: NOW,
    services: [
      { id: "svc1", name: "web", slug: "web-x1", type: "app", status: "running", organization: "acme", project: "Shop", environment: "production", serverId: "local" },
      { id: "svc2", name: 'db "main"', slug: "db-x2", type: "database", status: "stopped", organization: "acme", project: "Shop", environment: "production", serverId: "local" },
    ],
    serverNames: new Map([
      ["local", "This server"],
      ["s2", "edge"],
    ]),
    samples: new Map([
      ["svc1", { cpuPercent: 150, memory: 1000, memoryLimit: 4000, netRx: 10, netTx: 20, at: NOW - 30_000 }],
      // Too old: the service stopped.
      ["svc2", { cpuPercent: 5, memory: 1, memoryLimit: 1, netRx: 1, netTx: 1, at: NOW - 600_000 }],
      // Another organization's service.
      ["foreign9", { cpuPercent: 99, memory: 9, memoryLimit: 9, netRx: 9, netTx: 9, at: NOW }],
    ]),
    containers: [
      { serviceId: "svc1", serverId: "local", name: "web-x1-abc123-1", state: "running", restartCount: 0 },
      { serviceId: "svc1", serverId: "s2", name: "web-x1-abc123-2", state: "restarting", restartCount: 4 },
      { serviceId: "foreign9", serverId: "local", name: "secret-app-zzzzzz-1", state: "running", restartCount: 7 },
    ],
    requests: new Map([["svc1", { requests: 600, s5xx: 30 }]]),
    deployments: [
      { serviceId: "svc1", status: "success", count: 3 },
      { serviceId: "svc1", status: "failed", count: 1 },
      { serviceId: "foreign9", status: "success", count: 50 },
    ],
    lastDeploy: new Map([["svc1", NOW - 3_600_000]]),
    servers: null,
    ...over,
  };
}

describe("metrics export", () => {
  it("labels services and exposes their latest samples", () => {
    const text = buildExposition(input());
    const l = 'organization="acme",project="Shop",environment="production",service="web",service_id="svc1",server="This server"';
    expect(text).toContain(`serve_service_up{${l}} 1`);
    expect(text).toContain(`serve_service_cpu_cores{${l}} 1.5`);
    expect(text).toContain(`serve_service_memory_bytes{${l}} 1000`);
    expect(text).toContain(`serve_service_network_receive_bytes_total{${l}} 10`);
    expect(text).toContain("# TYPE serve_service_network_receive_bytes_total counter");
    expect(text).toContain("# TYPE serve_service_cpu_cores gauge");
    expect(text).toContain(`serve_service_status{${l},status="running"} 1`);
    expect(text).toContain(`serve_service_status{${l},status="crashed"} 0`);
    expect(text).toContain(`serve_service_deployments_total{${l}} 4`);
    expect(text).toContain(`serve_service_deployments{${l},status="failed"} 1`);
    expect(text).toContain(`serve_service_last_deploy_timestamp_seconds{${l}} ${(NOW - 3_600_000) / 1000}`);
    // Requests over 5 minutes, as a rate.
    expect(text).toContain(`serve_service_http_requests_per_second{${l}} 2`);
    expect(text).toContain(`serve_service_http_5xx_per_second{${l}} 0.1`);
    // Escaped name of the database; no stale figures for it.
    expect(text).toContain('service="db \\"main\\""');
    expect(samples(text, "serve_service_cpu_cores").filter((s) => s.includes("svc2"))).toEqual([]);
  });

  it("lists replicas with their own server, state and restarts", () => {
    const text = buildExposition(input());
    expect(text).toContain('server="edge",replica="2",container="web-x1-abc123-2"} 4');
    expect(samples(text, "serve_replica_up").filter((s) => s.includes('replica="2"'))[0]).toMatch(/ 0$/);
    expect(text).toMatch(/serve_replica_state\{[^}]*replica="2"[^}]*state="restarting"\} 1/);
    expect(samples(text, "serve_service_replicas_running").find((s) => s.includes("svc1"))).toMatch(/ 1$/);
    expect(replicaOf("web-x1", "web-x1-abc123-12")).toBe("12");
    expect(replicaOf("stack", "stack-redis-1")).toBe("stack-redis-1");
  });

  it("never shows another organization's services", () => {
    const text = buildExposition(input());
    expect(text).not.toContain("foreign9");
    expect(text).not.toContain("secret-app");
    expect(text).not.toContain(" 99");
    // 50 deployments of the other service are not counted anywhere.
    expect(text).not.toMatch(/ 50$/m);
  });

  it("leaves out request rates without permission, and servers unless given", () => {
    const text = buildExposition(input({ requests: null }));
    expect(text).not.toContain("serve_service_http_");
    expect(text).not.toContain("serve_server_");
  });

  it("adds host figures for Root admins", () => {
    const text = buildExposition(
      input({
        servers: [
          { id: "local", name: "This server", reachable: true, cpuPercent: 25, cores: 8, memoryUsed: 5, memoryTotal: 10, diskUsed: 1, diskTotal: 2, load: [0.5, 0.25, 0.125] },
          { id: "s2", name: "edge", reachable: false, cpuPercent: null, cores: null, memoryUsed: null, memoryTotal: null, diskUsed: null, diskTotal: null, load: null },
        ],
      }),
    );
    expect(text).toContain('serve_server_up{server="This server",server_id="local"} 1');
    expect(text).toContain('serve_server_up{server="edge",server_id="s2"} 0');
    expect(text).toContain('serve_server_cpu_usage_ratio{server="This server",server_id="local"} 0.25');
    expect(text).toContain('serve_server_load15{server="This server",server_id="local"} 0.13');
    expect(text).not.toContain('serve_server_cpu_usage_ratio{server="edge"');
  });

  it("is valid with no services at all", () => {
    expect(buildExposition(input({ services: [], containers: [], deployments: [] }))).toBe("");
  });
});

describe("GET /api/v1/metrics", () => {
  const route = metricsRoutes[0];
  const auth = (over: Record<string, unknown> = {}): ApiAuth => ({
    tokenId: "t1",
    userId: "u1",
    organizationId: "org1",
    permissions: new Set<Permission>(["projects.view"]),
    admin: false,
    projectIds: null,
    canAccessProject: () => true,
    can: (p) => p === "projects.view",
    ...over,
  });
  beforeEach(() => {
    resetRateLimits();
    scrapes.length = 0;
    settings.rootOrganizationId = "root";
  });

  it("needs projects.view and answers the text format", async () => {
    expect(route.needs).toEqual(["projects.view"]);
    const res = (await route.handler({ auth: auth(), params: {}, body: undefined, query: undefined, request: new Request("http://x") })) as Response;
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await res.text()).toBe("serve_service_up 1\n");
    expect(scrapes[0]).toEqual({ organizationId: "org1", projectIds: null, requests: false, hosts: false });
  });

  it("gives host figures only to Root admins' tokens of the Root organization", async () => {
    expect(await hostMetricsAllowed(auth({ organizationId: "root", userId: "admin-user" }))).toBe(true);
    // A Root admin's token in another organization.
    expect(await hostMetricsAllowed(auth({ organizationId: "org1", userId: "admin-user" }))).toBe(false);
    // A plain member of the Root organization.
    expect(await hostMetricsAllowed(auth({ organizationId: "root", userId: "u1" }))).toBe(false);
    // A token limited to some projects.
    expect(await hostMetricsAllowed(auth({ organizationId: "root", userId: "admin-user", projectIds: ["p1"] }))).toBe(false);
    // No Root organization yet.
    settings.rootOrganizationId = null;
    expect(await hostMetricsAllowed(auth({ organizationId: "root", userId: "admin-user" }))).toBe(false);
  });

  it("passes the token's projects and log permission to the export", async () => {
    await route.handler({ auth: auth({ projectIds: ["p1"], can: () => true }), params: {}, body: undefined, query: undefined, request: new Request("http://x") });
    expect(scrapes[0]).toEqual({ organizationId: "org1", projectIds: ["p1"], requests: true, hosts: false });
  });

  it("rate limits scrapes per token", async () => {
    const call = (tokenId: string) =>
      route.handler({ auth: auth({ tokenId }), params: {}, body: undefined, query: undefined, request: new Request("http://x") }) as Promise<Response>;
    for (let i = 0; i < 60; i++) expect((await call("t1")).status).toBe(200);
    const over = await call("t1");
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call("t2")).status).toBe(200);
  });
});

describe("output cache", () => {
  it("loads once per key within the time to live, and again after", async () => {
    let t = 0;
    const cache = ttlCache<string>(5_000, () => t);
    let loads = 0;
    const load = async () => `v${++loads}`;
    const [a, b] = await Promise.all([cache.get("org1", load), cache.get("org1", load)]);
    expect([a, b, loads]).toEqual(["v1", "v1", 1]);
    expect(await cache.get("org2", load)).toBe("v2");
    t = 4_999;
    expect(await cache.get("org1", load)).toBe("v1");
    t = 5_000;
    expect(await cache.get("org1", load)).toBe("v3");
  });

  it("does not keep a failed load", async () => {
    const cache = ttlCache<string>(5_000, () => 0);
    await expect(cache.get("k", async () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    expect(await cache.get("k", async () => "ok")).toBe("ok");
  });

  it("keys by organization, projects, request and host access", () => {
    const base = { organizationId: "o", projectIds: null, requests: true, hosts: false };
    const keys = new Set([
      cacheKey(base),
      cacheKey({ ...base, organizationId: "o2" }),
      cacheKey({ ...base, projectIds: ["b", "a"] }),
      cacheKey({ ...base, requests: false }),
      cacheKey({ ...base, hosts: true }),
    ]);
    expect(keys.size).toBe(5);
    expect(cacheKey({ ...base, projectIds: ["a", "b"] })).toBe(cacheKey({ ...base, projectIds: ["b", "a"] }));
  });

  it("serves the last container list while it refreshes", async () => {
    let t = 0;
    const cache = staleWhileRevalidate<string[]>(30_000, 300_000, () => t);
    expect(await cache.get("local", async () => ["a"])).toEqual(["a"]);
    t = 40_000;
    let release!: (v: string[]) => void;
    const slow = new Promise<string[]>((r) => {
      release = r;
    });
    // Stale: answered at once with the old list, refreshed in the background.
    expect(await cache.get("local", () => slow)).toEqual(["a"]);
    release(["b"]);
    await slow;
    await new Promise((r) => setTimeout(r, 0));
    expect(await cache.get("local", async () => ["c"])).toEqual(["b"]);
    // Too old and the refresh fails: nothing rather than figures from long ago.
    t = 1_000_000;
    expect(await cache.get("local", async () => Promise.reject(new Error("down")))).toBeNull();
  });
});

describe("scrape config and Grafana dashboard", () => {
  it("builds a scrape config from the dashboard address", () => {
    expect(metricsUrl("https://serve.example.com/")).toBe("https://serve.example.com/api/v1/metrics");
    const yml = prometheusScrapeConfig("http://10.0.0.5:3000/serve", "srv_abc");
    expect(yml).toContain("scheme: http\n");
    expect(yml).toContain("metrics_path: /serve/api/v1/metrics\n");
    expect(yml).toContain("credentials: srv_abc\n");
    expect(yml).toContain('targets: ["10.0.0.5:3000"]');
    expect(yml).toContain("scrape_interval: 30s");
    expect(prometheusScrapeConfig("https://serve.example.com")).toContain("credentials: srv_your_token_here");
  });

  it("charts only metrics the endpoint exports", () => {
    const d = grafanaDashboard();
    const exprs = d.panels.flatMap((p) => p.targets.map((t) => t.expr));
    const used = new Set(exprs.flatMap((e) => e.match(/serve_[a-z0-9_]+/g) ?? []));
    const text = buildExposition(input({ servers: [] }));
    for (const name of used) expect(text, name).toContain(`# TYPE ${name} `);
    expect(d.templating.list.map((v) => v.name)).toEqual(["datasource", "project", "service"]);
    expect(JSON.parse(JSON.stringify(d)).panels).toHaveLength(6);
  });
});
