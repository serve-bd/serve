import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * API routes for what the dashboard did only through server actions: status pages, database
 * add-ons, deploy rules, HTTP options, request logs, server variables and servers. Each refuses a
 * token without the permission its action needs, never reaches another organization's records,
 * and hands the action only the fields it takes.
 */

const state = vi.hoisted(() => ({
  auth: null as null | {
    tokenId: string;
    userId: string;
    organizationId: string;
    permissions: Set<string>;
    admin: boolean;
    projectIds: string[] | null;
    canAccessProject: (id: string) => boolean;
    can: (p: string) => boolean;
  },
  instanceAdmin: false,
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as [string, ...unknown[]][],
  results: {} as Record<string, { ok: boolean; data?: unknown; error?: string }>,
  services: {} as Record<
    string,
    {
      id: string;
      projectId: string;
      orgId: string;
      name: string;
      type: string;
      database?: unknown;
      deployApproval?: string | null;
      proxy?: unknown;
      compose?: unknown;
      requestLog?: unknown;
    }
  >,
}));

vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", async (actual) => {
  const real = await actual<typeof import("drizzle-orm")>();
  return { ...real, eq: (col: unknown, value: unknown) => ({ eq: [col, value] }), and: (...c: unknown[]) => ({ and: c.filter(Boolean) }), asc: () => null, desc: () => null };
});
vi.mock("@/server/db", () => {
  // A table is its name and a column "table.column", so conditions can be read back.
  const schema = new Proxy({}, { get: (_t, table) => new Proxy({ __table: table }, { get: (t, col) => (col === "__table" ? t.__table : `${String(table)}.${String(col)}`) }) });
  const conds = (w: unknown): [string, unknown][] => {
    const o = (w ?? {}) as { eq?: [string, unknown]; and?: unknown[] };
    return o.eq ? [o.eq] : (o.and ?? []).flatMap(conds);
  };
  const query = (table: string, where: unknown) => (state.tables[table] ?? []).filter((row) => conds(where).every(([col, v]) => row[col.split(".")[1]] === v));
  const builder = (table: string, where: unknown = null): Promise<unknown[]> & Record<string, unknown> => {
    const p = Promise.resolve().then(() => query(table, where)) as Promise<unknown[]> & Record<string, unknown>;
    p.where = (w: unknown) => builder(table, w);
    p.orderBy = () => builder(table, where);
    p.limit = () => builder(table, where);
    p.innerJoin = () => builder(table, where);
    return p;
  };
  const db = { select: () => ({ from: (t: { __table: string }) => builder(t.__table) }) };
  return { db, schema };
});

vi.mock("@/server/api-auth", () => ({
  authenticateToken: async () => (state.auth ? { auth: state.auth } : { error: Response.json({ error: "Invalid or missing API token" }, { status: 401 }) }),
}));
vi.mock("@/server/auth", () => ({ ForbiddenError: class extends Error {}, isInstanceAdmin: async () => state.instanceAdmin }));
vi.mock("@/server/settings", () => ({ getSettings: async () => ({ apiEnabled: true, apiRateLimit: 0, proxyCustomConfig: "gzip_comp_level 5;" }), getSetting: async () => null }));
vi.mock("@/server/status-pages/urls", () => ({ pageUrl: async (p: { slug: string }) => `https://serve.example.com/status/${p.slug}` }));

// The loaders scope records to the token's organization and projects.
vi.mock("@/server/api/data", async (actual) => {
  const real = await actual<typeof import("@/server/api/data")>();
  const { ApiError } = await import("@/server/api/router");
  const loadService = async (auth: { organizationId: string; canAccessProject: (id: string) => boolean }, id: string) => {
    const s = state.services[id];
    if (!s || s.orgId !== auth.organizationId || !auth.canAccessProject(s.projectId)) throw new ApiError(404, "Service not found");
    return { service: { runtime: {}, compose: null, proxy: null, requestLog: null, ...s }, project: { id: s.projectId } };
  };
  return {
    ...real,
    loadService,
    loadProject: async (auth: Parameters<typeof loadService>[0], id: string) => {
      const p = (state.tables.project ?? []).find((x) => x.id === id);
      if (!p || p.organizationId !== auth.organizationId || !auth.canAccessProject(id)) throw new ApiError(404, "Project not found");
      return p;
    },
    loadDomain: async (auth: Parameters<typeof loadService>[0], id: string) => {
      const d = (state.tables.domain ?? []).find((x) => x.id === id);
      if (!d) throw new ApiError(404, "Domain not found");
      await loadService(auth, d.serviceId as string).catch(() => {
        throw new ApiError(404, "Domain not found");
      });
      return d;
    },
    // Servers in the table with this organization as owner are its own.
    loadServer: async (auth: { organizationId: string }, id: string) => {
      const row = (state.tables.server ?? []).find((s) => s.id === id && (s.ownerOrganizationId === auth.organizationId || s.ownerOrganizationId === null));
      if (!row) throw new ApiError(404, "Server not found");
      return row;
    },
  };
});

const action =
  (name: string) =>
  async (...args: unknown[]) => {
    state.calls.push([name, ...args]);
    return state.results[name] ?? { ok: true, data: null };
  };
const actions = (...names: string[]) => Object.fromEntries(names.map((n) => [n, action(n)]));
vi.mock("@/server/actions/status-pages", () =>
  actions(
    "createStatusNotice",
    "addStatusUpdate",
    "editStatusNotice",
    "deleteStatusNotice",
    "createStatusPage",
    "deleteStatusPage",
    "saveStatusPage",
    "setStatusDomain",
    "setStatusVisibility",
    "saveStatusSubscriptions",
    "addStatusComponent",
    "updateStatusComponent",
    "removeStatusComponent",
    "reorderStatusComponents",
    "listStatusSubscribers",
    "removeStatusSubscriber",
  ),
);

/** The real module, with these actions replaced by recorders. */
const partly =
  (...names: string[]) =>
  async (actual: () => Promise<Record<string, unknown>>) => ({ ...(await actual()), ...actions(...names) });
vi.mock("@/server/actions/databases", (actual) => partly("setDatabasePooler", "mainDatabaseChoices", "setMainDatabase", "redeployServices", "deleteVolumeData")(actual));
vi.mock("@/server/actions/database-access", (actual) => partly("setAddonAccess")(actual));
vi.mock("@/server/actions/database-domains", (actual) => partly("retryDatabaseCertificate")(actual));
vi.mock("@/server/actions/deploy-rules", (actual) => partly("saveDeployRules", "setServiceApproval")(actual));
vi.mock("@/server/actions/service-proxy", (actual) => partly("updateServiceProxy", "saveServiceProxyCustom")(actual));
vi.mock("@/server/actions/compose-storage", (actual) => partly("saveComposeMounts")(actual));
vi.mock("@/server/actions/environments", (actual) => partly("savePreviewDatabase")(actual));
vi.mock("@/server/actions/monitoring", (actual) => partly("saveRequestLog", "deleteRequestLog")(actual));
vi.mock("@/server/actions/services", (actual) => partly("pointDomainAtMain")(actual));
vi.mock("@/server/actions/shared-vars", (actual) => partly("saveServerVars", "saveOrgSharedVars", "saveProjectSharedVars", "redeployReferencing")(actual));
vi.mock("@/server/actions/servers", (actual) => partly("checkOsUpdatesAction", "installOsUpdatesAction", "makeDefaultServer")(actual));
vi.mock("@/server/actions/server-proxy", (actual) => partly("saveProxyCustomConfig")(actual));
vi.mock("@/server/actions/main-server", (actual) => partly("setMainServer")(actual));
vi.mock("@/server/crypto", async (actual) => ({ ...(await actual<Record<string, unknown>>()), decryptOrNull: (v: string) => `plain:${v}` }));
// Admins of the organization that owns a server manage it.
vi.mock("@/server/servers/access", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  requireServerAdmin: async (id: string) => {
    const { ForbiddenError } = await import("@/server/auth");
    const { UserError } = await import("@/server/action");
    const row = (state.tables.server ?? []).find((s) => s.id === id);
    if (!row) throw new UserError("Server not found.");
    if (!state.auth?.admin || row.ownerOrganizationId !== state.auth.organizationId)
      throw new ForbiddenError("Only admins of the organization that owns this server, or Root admins, can change it.");
    return { row };
  },
}));

const { createRouter } = await import("@/server/api/router");
const { statusPageRoutes } = await import("@/server/api/routes/status-pages");
const { databaseRoutes } = await import("@/server/api/routes/databases");
const { serviceRoutes } = await import("@/server/api/routes/services");
const { projectRoutes } = await import("@/server/api/routes/projects");
const { infraRoutes } = await import("@/server/api/routes/infra");
const handle = createRouter([...statusPageRoutes, ...databaseRoutes, ...serviceRoutes, ...projectRoutes, ...infraRoutes]);

const call = (method: string, path: string, body?: unknown) =>
  handle(
    new Request(`http://x/api/v1${path}`, { method, headers: { authorization: "Bearer srv_x" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    path.split("?")[0],
  );

function token(permissions: string[], opts: { admin?: boolean; org?: string; projects?: string[] | null } = {}) {
  const set = new Set(permissions);
  state.auth = {
    tokenId: "tok1",
    userId: "u1",
    organizationId: opts.org ?? "o1",
    permissions: set,
    admin: !!opts.admin,
    projectIds: opts.projects ?? null,
    canAccessProject: (id) => !opts.projects || opts.projects.includes(id),
    can: (p) => set.has(p),
  };
}

const called = (name: string) => state.calls.filter((c) => c[0] === name);
const now = new Date("2026-10-01T00:00:00Z");

beforeEach(() => {
  state.calls = [];
  state.results = {};
  state.instanceAdmin = false;
  state.services = {
    s1: {
      id: "s1",
      projectId: "p1",
      orgId: "o1",
      name: "web",
      type: "app",
      proxy: {
        basicAuth: { username: "ada", passwordHash: "$apr1$hash", bcryptHash: "$2a$hash" },
        guests: [{ id: "g1", email: "g@example.com", hash: "$2a$guest" }],
        gzip: false,
        sticky: true,
      },
      requestLog: { enabled: true, days: 7, statuses: [4, 5], ips: true },
    },
    stack: {
      id: "stack",
      projectId: "p1",
      orgId: "o1",
      name: "stack",
      type: "compose",
      compose: { mode: "editor", content: "services:\n  web:\n    image: nginx\n    volumes:\n      - data:/data\n" },
    },
    db1: { id: "db1", projectId: "p1", orgId: "o1", name: "pg", type: "database", database: { engine: "postgres" } },
    other: { id: "other", projectId: "px", orgId: "o2", name: "theirs", type: "app" },
    otherdb: { id: "otherdb", projectId: "px", orgId: "o2", name: "theirs", type: "database", database: { engine: "postgres" } },
  };
  state.tables = {
    statusPage: [
      {
        id: "sp1",
        organizationId: "o1",
        name: "Acme",
        slug: "acme",
        domain: null,
        https: true,
        tunnelId: null,
        certificateId: null,
        visibility: "draft",
        passwordHash: "$2a$10$secret",
        design: { theme: "dark" },
        images: { logo: { hash: "h1", mime: "image/png", data: "QUJD" } },
        subscribe: {},
        teamChannelIds: [],
        createdAt: now,
        updatedAt: now,
      },
      { id: "sp2", organizationId: "o2", name: "Theirs", slug: "theirs", domain: null, https: true, visibility: "public", design: {}, images: {}, createdAt: now, updatedAt: now },
    ],
    statusComponent: [
      { id: "c1", pageId: "sp1", name: "API", description: null, group: "Core", serviceId: "s1", position: 0 },
      { id: "c2", pageId: "sp2", name: "Theirs", description: null, group: null, serviceId: null, position: 0 },
    ],
    server: [
      { id: "srv1", name: "web", ownerOrganizationId: "o1", osUpdates: { packages: [{ name: "openssl" }] } },
      { id: "srv-other", name: "theirs", ownerOrganizationId: "o2", osUpdates: null },
    ],
    serverVar: [
      { id: "v1", serverId: "srv1", organizationId: "o1", key: "REGION", value: "enc1" },
      { id: "v2", serverId: "srv1", organizationId: "o2", key: "THEIRS", value: "enc2" },
    ],
    domain: [
      { id: "d1", serviceId: "s1", hostname: "shop.example.com" },
      { id: "d-other", serviceId: "other", hostname: "theirs.example.com" },
    ],
    project: [
      { id: "p1", organizationId: "o1", name: "shop", deployRules: { approval: { enabled: true, environmentIds: ["e1"] } } },
      { id: "px", organizationId: "o2", name: "theirs", deployRules: null },
    ],
    statusSubscriber: [
      { id: "sub1", pageId: "sp1" },
      { id: "sub2", pageId: "sp2" },
    ],
  };
});

describe("status pages", () => {
  it("need status-pages.manage", async () => {
    token(["projects.view"]);
    const res = await call("POST", "/status-pages", { name: "New" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ missing: ["status-pages.manage"] });
    expect((await call("DELETE", "/status-pages/sp1")).status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it("are not for a token limited to some projects, as in the dashboard", async () => {
    token(["status-pages.manage"], { projects: ["p1"] });
    expect((await call("POST", "/status-pages", { name: "New" })).status).toBe(403);
    expect((await call("GET", "/status-pages/sp1")).status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it("create a page and show it without its password or images", async () => {
    token(["status-pages.manage"]);
    state.results.createStatusPage = { ok: true, data: { id: "sp1" } };
    const res = await call("POST", "/status-pages", { name: "Acme", slug: "acme" });
    expect(res.status).toBe(201);
    expect(called("createStatusPage")).toEqual([["createStatusPage", { name: "Acme", slug: "acme" }]]);
    const { statusPage } = await res.json();
    expect(statusPage).toMatchObject({ id: "sp1", url: "https://serve.example.com/status/acme", hasPassword: true, images: { logo: { hash: "h1", mime: "image/png" } } });
    expect(JSON.stringify(statusPage)).not.toContain("secret");
    expect(JSON.stringify(statusPage)).not.toContain("QUJD");
    expect(statusPage.design.logo).toBeUndefined();
  });

  it("change the look keeping the fields left out, and refuse unknown ones", async () => {
    token(["status-pages.manage"]);
    expect((await call("PATCH", "/status-pages/sp1", { design: { accent: "#0a84ff" } })).status).toBe(200);
    const [, id, input] = called("saveStatusPage")[0] as [string, string, { name: string; slug: string; design: Record<string, unknown> }];
    expect(id).toBe("sp1");
    expect(input).toMatchObject({ name: "Acme", slug: "acme", design: { theme: "dark", accent: "#0a84ff", days: 90 } });
    expect(input.design.logo).toBeUndefined();
    expect((await call("PATCH", "/status-pages/sp1", { design: { logo: { hash: "x" } } })).status).toBe(400);
    expect(called("saveStatusPage")).toHaveLength(1);
  });

  it("do not reach another organization's page, component or subscriber", async () => {
    token(["status-pages.manage"]);
    expect((await call("GET", "/status-pages/sp2")).status).toBe(404);
    expect((await call("PATCH", "/status-pages/sp2", { name: "x" })).status).toBe(404);
    expect((await call("DELETE", "/status-pages/sp2")).status).toBe(404);
    expect((await call("PUT", "/status-pages/sp2/visibility", { visibility: "public" })).status).toBe(404);
    expect((await call("PUT", "/status-pages/sp2/domain", { domain: "status.example.com" })).status).toBe(404);
    expect((await call("POST", "/status-pages/sp2/components", { name: "x" })).status).toBe(404);
    // Another page's component or subscriber through this page's path.
    expect((await call("PATCH", "/status-pages/sp1/components/c2", { name: "x" })).status).toBe(404);
    expect((await call("DELETE", "/status-pages/sp1/components/c2")).status).toBe(404);
    expect((await call("DELETE", "/status-pages/sp1/subscribers/sub2")).status).toBe(404);
    expect((await call("GET", "/status-pages/sp2/subscribers")).status).toBe(404);
    expect(state.calls).toHaveLength(0);
  });

  it("set the domain, visibility and subscriptions", async () => {
    token(["status-pages.manage"]);
    expect((await call("PUT", "/status-pages/sp1/domain", { domain: null })).status).toBe(200);
    expect(called("setStatusDomain")).toEqual([["setStatusDomain", "sp1", { domain: "", https: true, tunnelId: null, certificateId: null }]]);
    expect((await call("PUT", "/status-pages/sp1/visibility", { visibility: "password", password: "hunter22" })).status).toBe(200);
    expect(called("setStatusVisibility")).toEqual([["setStatusVisibility", "sp1", { visibility: "password", password: "hunter22" }]]);
    expect((await call("PUT", "/status-pages/sp1/visibility", { visibility: "secret" })).status).toBe(400);
    const subscribe = { email: true, slack: false, discord: false, webhook: true, rss: true, components: true, outages: false };
    expect((await call("PUT", "/status-pages/sp1/subscriptions", { subscribe })).status).toBe(200);
    expect(called("saveStatusSubscriptions")).toEqual([["saveStatusSubscriptions", "sp1", { subscribe, teamChannelIds: [] }]]);
  });

  it("add, change, reorder and remove components", async () => {
    token(["status-pages.manage"]);
    state.results.addStatusComponent = { ok: true, data: { id: "c1" } };
    const add = await call("POST", "/status-pages/sp1/components", { name: "API", serviceId: "s1" });
    expect(add.status).toBe(201);
    expect(called("addStatusComponent")).toEqual([["addStatusComponent", "sp1", { name: "API", serviceId: "s1", description: null, group: null }]]);
    expect((await add.json()).component).toMatchObject({ id: "c1", name: "API" });
    expect((await call("PATCH", "/status-pages/sp1/components/c1", { description: "The API" })).status).toBe(200);
    expect(called("updateStatusComponent")).toEqual([["updateStatusComponent", "c1", { name: "API", serviceId: "s1", description: "The API", group: "Core" }]]);
    expect((await call("PUT", "/status-pages/sp1/components/order", { ids: ["c1"] })).status).toBe(200);
    expect(called("reorderStatusComponents")).toEqual([["reorderStatusComponents", "sp1", ["c1"]]]);
    expect((await call("DELETE", "/status-pages/sp1/components/c1")).status).toBe(200);
    expect(called("removeStatusComponent")).toEqual([["removeStatusComponent", "c1"]]);
  });

  it("list and remove subscribers", async () => {
    token(["status-pages.manage"]);
    state.results.listStatusSubscribers = { ok: true, data: { offset: 0, hasMore: false, rows: [{ id: "sub1" }] } };
    const res = await call("GET", "/status-pages/sp1/subscribers?kind=email&offset=25");
    expect(await res.json()).toEqual({ subscribers: [{ id: "sub1" }], offset: 0, hasMore: false });
    expect(called("listStatusSubscribers")).toEqual([["listStatusSubscribers", "sp1", { kind: "email", offset: 25 }]]);
    expect((await call("DELETE", "/status-pages/sp1/subscribers/sub1")).status).toBe(200);
    expect(called("removeStatusSubscriber")).toEqual([["removeStatusSubscriber", "sub1"]]);
  });

  it("answer an action's refusal as an error", async () => {
    token(["status-pages.manage"]);
    state.results.setStatusVisibility = { ok: false, error: "Set a password first." };
    const res = await call("PUT", "/status-pages/sp1/visibility", { visibility: "password" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Set a password first.");
  });
});

describe("database add-ons", () => {
  it("need services.manage, and domains.manage for public access", async () => {
    token(["projects.view", "services.deploy"]);
    expect((await call("PUT", "/services/db1/database/pooler", { enabled: true })).status).toBe(403);
    expect((await call("PUT", "/services/db1/database/main", { name: "shop" })).status).toBe(403);
    expect((await call("GET", "/services/db1/database/main")).status).toBe(403);
    token(["services.manage"]);
    const res = await call("PUT", "/services/db1/database/pooler/access", { open: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ missing: ["domains.manage"] });
    expect((await call("POST", "/services/db1/database/retry-certificate", {})).status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it("turn the pooler on with the defaults the dashboard uses", async () => {
    token(["services.manage"]);
    expect((await call("PUT", "/services/db1/database/pooler", { enabled: true, poolSize: 40 })).status).toBe(200);
    expect(called("setDatabasePooler")).toEqual([["setDatabasePooler", "db1", { enabled: true, mode: "transaction", poolSize: 40, maxClients: 1000 }]]);
    expect((await call("PUT", "/services/db1/database/pooler", { enabled: true, poolSize: 900 })).status).toBe(400);
  });

  it("open the pooler or replicas, retry a certificate and pick the main database", async () => {
    token(["services.manage", "domains.manage"]);
    expect((await call("PUT", "/services/db1/database/replicas/access", { open: true, domain: "ro.example.com" })).status).toBe(200);
    expect(called("setAddonAccess")).toEqual([["setAddonAccess", "db1", "replicas", { open: true, domain: "ro.example.com" }]]);
    expect((await call("POST", "/services/db1/database/retry-certificate", { which: "pooler" })).status).toBe(200);
    expect(called("retryDatabaseCertificate")).toEqual([["retryDatabaseCertificate", "db1", "pooler"]]);
    expect((await call("PUT", "/services/db1/database/main", { name: "shop" })).status).toBe(200);
    expect(called("setMainDatabase")).toEqual([["setMainDatabase", "db1", "shop"]]);
  });

  it("do not reach another organization's database, or an app", async () => {
    token(["services.manage", "domains.manage", "services.deploy"], { admin: true });
    expect((await call("PUT", "/services/otherdb/database/pooler", { enabled: true })).status).toBe(404);
    expect((await call("PUT", "/services/otherdb/database/pooler/access", { open: false })).status).toBe(404);
    expect((await call("POST", "/services/otherdb/database/retry-certificate", {})).status).toBe(404);
    expect((await call("GET", "/services/otherdb/database/main")).status).toBe(404);
    expect((await call("PUT", "/services/s1/database/main", { name: "shop" })).status).toBe(400);
    expect((await call("DELETE", "/services/other/volumes/data")).status).toBe(404);
    expect((await call("POST", "/services/redeploy", { serviceIds: ["s1", "other"] })).status).toBe(404);
    expect(state.calls).toHaveLength(0);
  });

  it("redeploy services and delete an unmounted volume", async () => {
    token(["services.deploy"]);
    state.results.redeployServices = { ok: true, data: { queued: 1 } };
    const res = await call("POST", "/services/redeploy", { serviceIds: ["s1", "s1"] });
    expect(await res.json()).toEqual({ queued: 1 });
    expect(called("redeployServices")).toEqual([["redeployServices", ["s1"]]]);
    expect((await call("DELETE", "/services/s1/volumes/cache")).status).toBe(403);
    token(["services.manage"]);
    expect((await call("DELETE", "/services/s1/volumes/cache")).status).toBe(200);
    expect(called("deleteVolumeData")).toEqual([["deleteVolumeData", "s1", "cache"]]);
  });
});

describe("deploy rules", () => {
  it("show a project's rules with every field, and change only what is sent", async () => {
    token(["projects.view"]);
    expect((await (await call("GET", "/projects/p1/deploy-rules")).json()).rules).toEqual({
      approval: { enabled: true, environmentIds: ["e1"] },
      freeze: { now: null, windows: [], timezone: "UTC", environmentIds: [] },
    });
    expect((await call("PATCH", "/projects/p1/deploy-rules", { freeze: { now: { reason: "launch" } } })).status).toBe(403);
    token(["projects.manage"]);
    expect((await call("PATCH", "/projects/p1/deploy-rules", { freeze: { now: { reason: "launch" } } })).status).toBe(200);
    expect(called("saveDeployRules")).toEqual([
      [
        "saveDeployRules",
        "p1",
        { approval: { enabled: true, environmentIds: ["e1"] }, freeze: { now: { until: null, reason: "launch" }, windows: [], timezone: "UTC", environmentIds: [] } },
      ],
    ]);
  });

  it("do not reach another organization's project or service", async () => {
    token(["projects.view", "projects.manage", "deploys.approve"], { admin: true });
    expect((await call("GET", "/projects/px/deploy-rules")).status).toBe(404);
    expect((await call("PATCH", "/projects/px/deploy-rules", {})).status).toBe(404);
    expect((await call("PUT", "/services/other/approval", { mode: "never" })).status).toBe(404);
    token(["projects.manage"], { projects: ["p2"] });
    expect((await call("PATCH", "/projects/p1/deploy-rules", {})).status).toBe(404);
    expect(state.calls).toHaveLength(0);
  });

  it("let only those who approve deploys change a service's approval", async () => {
    token(["projects.view", "services.manage"]);
    expect((await call("PUT", "/services/s1/approval", { mode: "never" })).status).toBe(403);
    token(["deploys.approve"]);
    expect((await call("PUT", "/services/s1/approval", { mode: "never" })).status).toBe(200);
    expect((await call("PUT", "/services/s1/approval", { mode: null })).status).toBe(200);
    expect((await call("PUT", "/services/s1/approval", { mode: "sometimes" })).status).toBe(400);
    expect(called("setServiceApproval")).toEqual([
      ["setServiceApproval", "s1", "never"],
      ["setServiceApproval", "s1", null],
    ]);
  });
});

describe("HTTP options", () => {
  it("show the options without passwords or hashes", async () => {
    token(["projects.view"]);
    const { options } = await (await call("GET", "/services/s1/proxy")).json();
    expect(options).toMatchObject({ basicAuthUser: "ada", guests: [{ id: "g1", email: "g@example.com" }], gzip: false });
    expect(JSON.stringify(options)).not.toMatch(/hash/i);
    expect((await call("GET", "/services/other/proxy")).status).toBe(404);
  });

  it("are changed by organization admins, keeping what is left out", async () => {
    token(["domains.manage"]);
    expect((await call("PATCH", "/services/s1/proxy", { gzip: true })).status).toBe(403);
    token(["domains.manage"], { admin: true });
    expect((await call("PATCH", "/services/other/proxy", { gzip: true })).status).toBe(404);
    expect((await call("PATCH", "/services/s1/proxy", { allow: ["not an ip"] })).status).toBe(400);
    expect(called("updateServiceProxy")).toHaveLength(0);
    expect((await call("PATCH", "/services/s1/proxy", { readTimeout: 600 })).status).toBe(200);
    const [, sid, input] = called("updateServiceProxy")[0] as [string, string, Record<string, unknown>];
    expect(sid).toBe("s1");
    expect(input).toEqual({
      gzip: false,
      readTimeout: 600,
      balancing: "sticky",
      basicAuth: { enabled: true, username: "ada" },
      guests: [{ id: "g1", email: "g@example.com" }],
    });
  });

  it("let only Root admins replace the generated site", async () => {
    token([], { admin: true });
    expect((await call("PUT", "/services/s1/proxy/custom", { content: "location / {}" })).status).toBe(403);
    state.instanceAdmin = true;
    expect((await call("PUT", "/services/other/proxy/custom", { content: null })).status).toBe(404);
    expect((await call("PUT", "/services/s1/proxy/custom", { content: null })).status).toBe(200);
    expect(called("saveServiceProxyCustom")).toEqual([["saveServiceProxyCustom", "s1", null]]);
  });
});

describe("compose storage, request log, preview databases and DNS", () => {
  it("read and replace a stack's mounts, refusing unknown kinds", async () => {
    token(["projects.view"]);
    expect((await (await call("GET", "/services/stack/compose/mounts")).json()).services).toEqual([
      { service: "web", mounts: [{ kind: "volume", source: "data", target: "/data" }] },
    ]);
    const mounts = [{ kind: "bind", source: "/srv/media", target: "/media" }];
    expect((await call("PUT", "/services/stack/compose/mounts/web", { mounts })).status).toBe(403);
    token(["services.manage"]);
    expect((await call("PUT", "/services/stack/compose/mounts/web", { mounts: [{ kind: "tmpfs", target: "/tmp" }] })).status).toBe(400);
    expect((await call("PUT", "/services/s1/compose/mounts/web", { mounts })).status).toBe(400);
    expect((await call("PUT", "/services/other/compose/mounts/web", { mounts })).status).toBe(404);
    expect(called("saveComposeMounts")).toHaveLength(0);
    expect((await call("PUT", "/services/stack/compose/mounts/web", { mounts })).status).toBe(200);
    expect(called("saveComposeMounts")).toEqual([["saveComposeMounts", "stack", "web", mounts]]);
  });

  it("change the request log settings keeping the rest, and delete the log", async () => {
    token(["projects.view"]);
    expect((await (await call("GET", "/services/s1/request-log/settings")).json()).settings).toEqual({ enabled: true, days: 7, statuses: [4, 5], ips: true });
    expect((await call("PATCH", "/services/s1/request-log/settings", { ips: false })).status).toBe(403);
    expect((await call("DELETE", "/services/s1/request-log")).status).toBe(403);
    token(["services.manage"]);
    expect((await call("PATCH", "/services/other/request-log/settings", { ips: false })).status).toBe(404);
    expect((await call("DELETE", "/services/other/request-log")).status).toBe(404);
    expect((await call("PATCH", "/services/s1/request-log/settings", { ips: false })).status).toBe(200);
    expect(called("saveRequestLog")).toEqual([["saveRequestLog", "s1", { enabled: true, days: 7, statuses: [4, 5], ips: false }]]);
    expect((await call("DELETE", "/services/s1/request-log")).status).toBe(200);
    expect(called("deleteRequestLog")).toEqual([["deleteRequestLog", "s1"]]);
  });

  it("set and clear a preview database, only from the organization's own databases", async () => {
    token(["services.deploy"]);
    expect((await call("DELETE", "/services/s1/preview-database")).status).toBe(403);
    token(["services.manage"]);
    expect((await call("PUT", "/services/s1/preview-database", { sourceServiceId: "otherdb", variable: "DATABASE_URL" })).status).toBe(404);
    expect((await call("PUT", "/services/other/preview-database", { sourceServiceId: "db1", variable: "DATABASE_URL" })).status).toBe(404);
    expect(called("savePreviewDatabase")).toHaveLength(0);
    expect((await call("PUT", "/services/s1/preview-database", { sourceServiceId: "db1", variable: "DATABASE_URL", mode: "branch" })).status).toBe(200);
    expect((await call("DELETE", "/services/s1/preview-database")).status).toBe(200);
    expect(called("savePreviewDatabase")).toEqual([
      ["savePreviewDatabase", "s1", { sourceServiceId: "db1", variable: "DATABASE_URL", mode: "branch" }],
      ["savePreviewDatabase", "s1", null],
    ]);
  });

  it("point a domain at the main server", async () => {
    token(["projects.view"]);
    expect((await call("POST", "/domains/d1/point-at-main")).status).toBe(403);
    token(["domains.manage"]);
    expect((await call("POST", "/domains/d-other/point-at-main")).status).toBe(404);
    expect((await call("POST", "/domains/d1/point-at-main")).status).toBe(200);
    expect(called("pointDomainAtMain")).toEqual([["pointDomainAtMain", "d1"]]);
  });
});

describe("server variables", () => {
  it("list the organization's own variables of a server, values only with variables.view-secrets", async () => {
    token(["projects.view"]);
    expect((await (await call("GET", "/servers/srv1/variables")).json()).variables).toEqual([{ key: "REGION" }]);
    token(["projects.view", "variables.view-secrets"]);
    expect((await (await call("GET", "/servers/srv1/variables")).json()).variables).toEqual([{ key: "REGION", value: "plain:enc1" }]);
    expect((await call("GET", "/servers/srv-other/variables")).status).toBe(404);
  });

  it("are replaced by admins, and redeploy what uses them only with services.deploy", async () => {
    const variables = [{ key: "REGION", value: "eu" }];
    token(["variables.edit", "variables.view-secrets", "services.deploy"]);
    expect((await call("PUT", "/servers/srv1/variables", { variables })).status).toBe(403);
    token(["variables.edit"], { admin: true });
    expect((await call("PUT", "/servers/srv-other/variables", { variables })).status).toBe(404);
    expect((await call("PUT", "/servers/srv1/variables", { variables, redeploy: true })).status).toBe(403);
    expect(state.calls).toHaveLength(0);
    token(["services.deploy"], { admin: true });
    state.results.redeployReferencing = { ok: true, data: { count: 2 } };
    expect(await (await call("PUT", "/servers/srv1/variables", { variables, redeploy: true })).json()).toEqual({ ok: true, redeployed: 2 });
    expect(state.calls).toEqual([
      ["saveServerVars", "srv1", variables],
      ["redeployReferencing", { serverId: "srv1" }],
    ]);
  });

  it("redeploy after organization and project variables too", async () => {
    token(["services.deploy"], { admin: true });
    state.results.redeployReferencing = { ok: true, data: { count: 1 } };
    expect(await (await call("PUT", "/variables", { variables: [], redeploy: true })).json()).toEqual({ ok: true, redeployed: 1 });
    expect(called("redeployReferencing")).toEqual([["redeployReferencing", "org"]]);
    token(["variables.edit", "variables.view-secrets"]);
    expect(await (await call("PUT", "/projects/p1/variables", { variables: [] })).json()).toEqual({ ok: true, redeployed: 0 });
    expect((await call("PUT", "/projects/p1/variables", { variables: [], redeploy: true })).status).toBe(403);
    expect(called("saveProjectSharedVars")).toHaveLength(1);
  });
});

describe("servers", () => {
  it("show and run OS updates for admins who manage the server", async () => {
    token(["projects.view"]);
    expect((await call("POST", "/servers/srv1/os-updates/check")).status).toBe(403);
    token([], { admin: true });
    expect((await (await call("GET", "/servers/srv1/os-updates")).json()).osUpdates).toEqual({ packages: [{ name: "openssl" }] });
    expect((await call("GET", "/servers/srv-other/os-updates")).status).toBe(403);
    expect((await call("GET", "/servers/nope/os-updates")).status).toBe(404);
    expect((await call("POST", "/servers/srv1/os-updates/check")).status).toBe(202);
    expect((await call("POST", "/servers/srv1/os-updates/install", { packages: "some" })).status).toBe(400);
    expect((await call("POST", "/servers/srv1/os-updates/install", { packages: ["openssl"] })).status).toBe(202);
    expect(state.calls).toEqual([
      ["checkOsUpdatesAction", "srv1"],
      ["installOsUpdatesAction", "srv1", ["openssl"]],
    ]);
  });

  it("make a default server for admins only", async () => {
    token(["projects.view", "services.manage"]);
    expect((await call("POST", "/servers/srv1/default")).status).toBe(403);
    token([], { admin: true });
    state.results.makeDefaultServer = { ok: false, error: "This organization cannot deploy to that server." };
    expect((await call("POST", "/servers/srv-other/default")).status).toBe(400);
    expect(called("makeDefaultServer")).toEqual([["makeDefaultServer", "srv-other"]]);
  });

  it("keep the instance's proxy configuration to Root admins", async () => {
    token([], { admin: true });
    expect((await call("GET", "/proxy/custom-config")).status).toBe(403);
    expect((await call("PUT", "/proxy/custom-config", { config: "" })).status).toBe(403);
    state.instanceAdmin = true;
    expect(await (await call("GET", "/proxy/custom-config")).json()).toEqual({ config: "gzip_comp_level 5;" });
    expect((await call("PUT", "/proxy/custom-config", { config: "gzip_comp_level 6;" })).status).toBe(200);
    expect(called("saveProxyCustomConfig")).toEqual([["saveProxyCustomConfig", "gzip_comp_level 6;"]]);
  });

  it("switch an app's main server within the organization", async () => {
    token(["services.deploy"]);
    expect((await call("PUT", "/services/s1/main-server", { serverId: "srv1" })).status).toBe(403);
    token(["services.manage"]);
    expect((await call("PUT", "/services/other/main-server", { serverId: "srv1" })).status).toBe(404);
    state.results.setMainServer = { ok: true, data: { manual: [], warnings: [] } };
    expect(await (await call("PUT", "/services/s1/main-server", { serverId: "srv1" })).json()).toEqual({ manual: [], warnings: [] });
    expect(called("setMainServer")).toEqual([["setMainServer", "s1", "srv1"]]);
  });
});
