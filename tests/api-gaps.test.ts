import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * API routes for deploy approval, the console (serve exec, serve ssh), Tailscale, Cloudflare
 * Tunnels, private networks, log drains and new tokens: each refuses a token without the
 * permission it needs, and never reaches another organization's records.
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
  isRoot: false,
  rateLimit: 0,
  tables: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as [string, ...unknown[]][],
  actionResult: { ok: true, data: null } as { ok: boolean; data?: unknown; error?: string },
  services: {} as Record<string, { id: string; projectId: string; orgId: string; name: string; hostAccess?: boolean }>,
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
    return p;
  };
  const db = { select: () => ({ from: (t: { __table: string }) => builder(t.__table) }) };
  return { db, schema };
});

vi.mock("@/server/api-auth", () => ({
  authenticateToken: async () => (state.auth ? { auth: state.auth } : { error: Response.json({ error: "Invalid or missing API token" }, { status: 401 }) }),
}));
vi.mock("@/server/auth", () => ({
  ForbiddenError: class extends Error {},
  isInstanceAdmin: async () => state.instanceAdmin,
  requireOrg: async () => ({
    user: { id: state.auth!.userId, name: "Ada", email: "ada@example.com" },
    org: { id: state.auth!.organizationId },
    isAdmin: state.auth!.admin,
    isInstanceAdmin: state.auth!.admin && state.instanceAdmin,
    isRoot: state.isRoot,
    can: (p: string) => state.auth!.permissions.has(p),
    canAccessProject: () => true,
    projectIds: null,
    permissions: state.auth!.permissions,
  }),
}));
vi.mock("@/server/settings", () => ({ getSettings: async () => ({ apiEnabled: true, apiRateLimit: state.rateLimit, dashboardTunnelId: null }), getSetting: async () => null }));
vi.mock("@/server/activity", () => ({ logActivity: async (a: unknown) => void state.calls.push(["logActivity", a]) }));

// The loaders scope records to the token's organization and projects.
vi.mock("@/server/api/data", async (actual) => {
  const real = await actual<typeof import("@/server/api/data")>();
  const { ApiError } = await import("@/server/api/router");
  const loadService = async (auth: { organizationId: string; canAccessProject: (id: string) => boolean }, id: string) => {
    const s = state.services[id];
    if (!s || s.orgId !== auth.organizationId || !auth.canAccessProject(s.projectId)) throw new ApiError(404, "Service not found");
    return { service: { id: s.id, name: s.name, projectId: s.projectId, runtime: { hostAccess: !!s.hostAccess }, compose: null }, project: { id: s.projectId } };
  };
  return {
    ...real,
    loadService,
    loadDeployment: async (auth: Parameters<typeof loadService>[0], id: string) => {
      const d = (state.tables.deployment ?? []).find((x) => x.id === id);
      if (!d) throw new ApiError(404, "Deployment not found");
      await loadService(auth, d.serviceId as string).catch(() => {
        throw new ApiError(404, "Deployment not found");
      });
      return { deployment: { ...d, logs: "", createdAt: null, startedAt: null, finishedAt: null }, service: {} };
    },
  };
});
vi.mock("@/server/security", () => ({ serviceHasHostAccess: (s: { runtime: { hostAccess: boolean } }) => s.runtime.hostAccess }));
vi.mock("@/server/services/exec", () => ({
  execTargets: async () => [
    { id: "c1aaaaaaaaaaaa", name: "web-abc123-1", composeService: null, docker: {} },
    { id: "c2bbbbbbbbbbbb", name: "web-abc123-2", composeService: null, docker: {} },
  ],
  pickContainer: async () => ({ id: "c1aaaaaaaaaaaa", name: "web-abc123-1", docker: {} }),
  execCommand: async (id: string, command: string, opts: { onData?: (t: string) => void }) => {
    state.calls.push(["execCommand", id, command]);
    opts.onData?.("hello\n");
    return { exitCode: 3, output: "hello\n", timedOut: false };
  },
}));
const sessions = vi.hoisted(() => new Map<string, { id: string; userId: string; scope: string; input: string[] }>());
vi.mock("@/server/services/terminal", () => ({
  hostScope: (id: string) => `host:${id}`,
  openSession: async (o: { userId: string; scope: string }) => {
    const s = { id: `t${sessions.size + 1}`, userId: o.userId, scope: o.scope, input: [] };
    sessions.set(s.id, s);
    return s;
  },
  openHostSession: async (o: { userId: string; serverId: string; command?: string }) => {
    state.calls.push(["openHostSession", o.serverId, o.command]);
    const s = { id: `h${sessions.size + 1}`, userId: o.userId, scope: `host:${o.serverId}`, input: [] };
    sessions.set(s.id, s);
    return s;
  },
  getSession: (id: string, userId: string) => {
    const s = sessions.get(id);
    return s && s.userId === userId ? s : null;
  },
  writeSession: (s: { input: string[] }, data: string) => void s.input.push(data),
  resizeSession: async () => {},
  closeSession: (id: string) => void sessions.delete(id),
  subscribe: () => () => {},
}));
vi.mock("@/server/servers/context", () => ({
  getServerRow: async (id: string) => {
    const row = (state.tables.server ?? []).find((s) => s.id === id);
    if (!row) throw new Error("Server not found.");
    return row;
  },
}));

const action =
  (name: string) =>
  async (...args: unknown[]) => {
    state.calls.push([name, ...args]);
    return state.actionResult;
  };
vi.mock("@/server/actions/deploy-rules", () => ({ approveDeployment: action("approveDeployment"), rejectDeployment: action("rejectDeployment") }));
vi.mock("@/server/actions/tailscale", () => ({
  tailscaleJoinCommand: action("tailscaleJoinCommand"),
  connectThroughTailscale: action("connectThroughTailscale"),
  stopUsingTailscale: action("stopUsingTailscale"),
}));
vi.mock("@/server/actions/integrations", () => ({ enableTunnel: action("enableTunnel"), disableTunnel: action("disableTunnel") }));
vi.mock("@/server/actions/mesh", () => ({
  createNetwork: action("createNetwork"),
  renameNetwork: action("renameNetwork"),
  deleteNetwork: action("deleteNetwork"),
  setNetworkMember: action("setNetworkMember"),
}));
vi.mock("@/server/mesh", () => ({
  meshNetworks: async () => [
    { id: "n-mine", name: "mine", organizationId: "o1", servers: [{ id: "srv-mine", name: "web", joined: true }] },
    { id: "n-other", name: "theirs", organizationId: "o2", servers: [] },
  ],
}));
vi.mock("@/server/actions/log-drains", () => ({
  addLogDrain: action("addLogDrain"),
  updateLogDrain: action("updateLogDrain"),
  setLogDrainEnabled: action("setLogDrainEnabled"),
  deleteLogDrain: action("deleteLogDrain"),
  testLogDrain: action("testLogDrain"),
}));
vi.mock("@/server/log-drains/view", () => ({
  logDrainsProps: async (orgId: string) => ({
    drains:
      orgId === "o1"
        ? [
            {
              id: "ld1",
              name: "logs",
              kind: "http",
              url: "https://logs.example.com",
              enabled: true,
              headerName: "Authorization",
              username: null,
              hasSecret: true,
              projectIds: ["p1"],
              serviceIds: null,
              index: null,
              sourcetype: null,
              insecure: false,
            },
          ]
        : [],
  }),
}));
vi.mock("@/server/actions/org", () => ({ createApiToken: action("createApiToken") }));

const { createRouter } = await import("@/server/api/router");
const { consoleRoutes } = await import("@/server/api/routes/console");
const { networkingRoutes } = await import("@/server/api/routes/networking");
const { logDrainRoutes } = await import("@/server/api/routes/log-drains");
const { projectRoutes } = await import("@/server/api/routes/projects");
const { orgRoutes } = await import("@/server/api/routes/org");
const handle = createRouter([...projectRoutes, ...consoleRoutes, ...networkingRoutes, ...logDrainRoutes, ...orgRoutes]);

const call = (method: string, path: string, body?: unknown) =>
  handle(new Request(`http://x/api/v1${path}`, { method, headers: { authorization: "Bearer srv_x" }, body: body === undefined ? undefined : JSON.stringify(body) }), path);

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

beforeEach(() => {
  state.calls = [];
  state.actionResult = { ok: true, data: null };
  state.instanceAdmin = false;
  state.isRoot = false;
  state.rateLimit = 0;
  sessions.clear();
  state.services = {
    s1: { id: "s1", projectId: "p1", orgId: "o1", name: "web" },
    s2: { id: "s2", projectId: "p2", orgId: "o1", name: "api" },
    host: { id: "host", projectId: "p1", orgId: "o1", name: "agent", hostAccess: true },
    other: { id: "other", projectId: "px", orgId: "o2", name: "theirs" },
  };
  state.tables = {
    deployment: [
      { id: "d1", serviceId: "s1", status: "waiting" },
      { id: "d-other", serviceId: "other", status: "waiting" },
    ],
    server: [
      { id: "srv-mine", name: "web", ownerOrganizationId: "o1", organizationIds: [], mesh: { enabled: true }, meshIndex: 1, isLocal: false },
      { id: "srv-new", name: "new", ownerOrganizationId: "o1", organizationIds: [], mesh: null, meshIndex: null, isLocal: false },
      { id: "srv-root", name: "root", ownerOrganizationId: null, organizationIds: null, mesh: null, meshIndex: null, isLocal: false },
    ],
    cloudflareAccount: [
      { id: "cf1", organizationId: "o1", name: "Mine" },
      { id: "cf2", organizationId: "o2", name: "Theirs" },
    ],
    cloudflareTunnel: [{ id: "tun2", cloudflareAccountId: "cf2", organizationId: "o2" }],
    tailscaleTailnet: [{ id: "tn1", name: "corp" }],
    apiToken: [],
  };
});

describe("deploy approval", () => {
  it("needs deploys.approve", async () => {
    token(["projects.view", "services.deploy"]);
    const res = await call("POST", "/deployments/d1/approve");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ missing: ["deploys.approve"] });
    expect(called("approveDeployment")).toHaveLength(0);
  });

  it("approves, and rejects with a reason", async () => {
    token(["deploys.approve"]);
    expect((await call("POST", "/deployments/d1/approve")).status).toBe(200);
    expect(called("approveDeployment")).toEqual([["approveDeployment", "d1"]]);
    expect((await call("POST", "/deployments/d1/reject", { reason: "Not on Friday" })).status).toBe(200);
    expect(called("rejectDeployment")).toEqual([["rejectDeployment", "d1", "Not on Friday"]]);
  });

  it("does not reach another organization's deployment, or a project the token is not limited to", async () => {
    token(["deploys.approve"]);
    expect((await call("POST", "/deployments/d-other/approve")).status).toBe(404);
    token(["deploys.approve"], { projects: ["p2"] });
    expect((await call("POST", "/deployments/d1/reject", {})).status).toBe(404);
    expect(called("approveDeployment").length + called("rejectDeployment").length).toBe(0);
  });

  it("answers 409 for a deployment that no longer waits", async () => {
    token(["deploys.approve"]);
    state.actionResult = { ok: false, error: "This deployment is not waiting for approval anymore." };
    expect((await call("POST", "/deployments/d1/approve")).status).toBe(409);
  });
});

describe("exec and shells in a service", () => {
  it("needs console.access", async () => {
    token(["projects.view", "services.deploy"]);
    expect((await call("POST", "/services/s1/exec", { command: "ls" })).status).toBe(403);
    expect((await call("POST", "/services/s1/terminal", {})).status).toBe(403);
    expect(called("execCommand")).toHaveLength(0);
  });

  it("streams the output and ends with the exit code", async () => {
    token(["console.access"]);
    const res = await call("POST", "/services/s1/exec", { command: "echo hello" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("hello\n\n\u00003");
    expect(called("execCommand")).toEqual([["execCommand", "c1aaaaaaaaaaaa", "echo hello"]]);
  });

  it("picks a replica by its number, and says which ones run", async () => {
    token(["console.access"]);
    await call("POST", "/services/s1/exec", { command: "hostname", replica: 2 });
    expect(called("execCommand")[0][1]).toBe("c2bbbbbbbbbbbb");
    const res = await call("POST", "/services/s1/exec", { command: "hostname", replica: 5 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("There is no running replica 5. Running: 1, 2.");
  });

  it("does not reach another organization's service", async () => {
    token(["console.access"], { admin: true });
    expect((await call("POST", "/services/other/exec", { command: "ls" })).status).toBe(404);
    expect((await call("POST", "/services/other/terminal", {})).status).toBe(404);
  });

  it("keeps a service with host access to Root admins", async () => {
    token(["console.access"], { admin: true });
    const res = await call("POST", "/services/host/exec", { command: "ls" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/host-level access/);
    state.instanceAdmin = true;
    expect((await call("POST", "/services/host/exec", { command: "ls" })).status).toBe(200);
  });

  it("opens a shell, takes keystrokes without counting them, and keeps it to its user and service", async () => {
    token(["console.access"]);
    const open = await call("POST", "/services/s1/terminal", { cols: 100, rows: 30 });
    expect(open.status).toBe(201);
    const { id } = await open.json();
    state.rateLimit = 1;
    for (let i = 0; i < 5; i++) expect((await call("POST", `/services/s1/terminal/${id}`, { type: "input", data: "x" })).status).toBe(204);
    expect(sessions.get(id)?.input).toHaveLength(5);
    // Another service's path, or another user, does not reach it.
    state.rateLimit = 0;
    expect((await call("POST", `/services/s2/terminal/${id}`, { type: "input", data: "x" })).status).toBe(404);
    state.auth!.userId = "u2";
    expect((await call("POST", `/services/s1/terminal/${id}`, { type: "input", data: "x" })).status).toBe(404);
  });
});

describe("a shell on a server", () => {
  it("needs an admin token with console.access", async () => {
    token(["console.access"]);
    expect((await call("POST", "/servers/srv-mine/terminal", {})).status).toBe(403);
    token(["projects.view"], { admin: true });
    expect((await call("POST", "/servers/srv-mine/terminal", {})).status).toBe(403);
  });

  it("is for admins who manage the server, as in the dashboard", async () => {
    token(["console.access"], { admin: true });
    const res = await call("POST", "/servers/srv-root/terminal", {});
    expect(res.status).toBe(403);
    expect(called("openHostSession")).toHaveLength(0);
    const mine = await call("POST", "/servers/srv-mine/terminal", { command: "uptime" });
    expect(mine.status).toBe(201);
    expect(called("openHostSession")).toEqual([["openHostSession", "srv-mine", "uptime"]]);
    state.instanceAdmin = true;
    expect((await call("POST", "/servers/srv-root/terminal", {})).status).toBe(201);
  });
});

describe("Tailscale", () => {
  it("is for Root admins only", async () => {
    token(["projects.view"], { admin: true });
    expect((await call("GET", "/servers/srv-root/tailscale")).status).toBe(403);
    expect((await call("POST", "/servers/srv-root/tailscale/connect", {})).status).toBe(403);
    expect(called("connectThroughTailscale")).toHaveLength(0);
  });

  it("uses the only tailnet when none is named", async () => {
    token([], { admin: true });
    state.instanceAdmin = true;
    expect((await call("POST", "/servers/srv-root/tailscale/connect", { force: true })).status).toBe(200);
    expect(called("connectThroughTailscale")).toEqual([["connectThroughTailscale", "srv-root", "tn1", true]]);
    state.tables.tailscaleTailnet.push({ id: "tn2", name: "lab" });
    expect((await call("POST", "/servers/srv-root/tailscale/join-command", {})).status).toBe(400);
  });
});

describe("Cloudflare Tunnels", () => {
  it("needs integrations.manage and the organization's own account", async () => {
    token(["projects.view"]);
    expect((await call("POST", "/cloudflare/accounts/cf1/tunnels", { serverId: "srv-mine" })).status).toBe(403);
    token(["integrations.manage"]);
    expect((await call("POST", "/cloudflare/accounts/cf2/tunnels", { serverId: "srv-mine" })).status).toBe(404);
    expect((await call("DELETE", "/cloudflare/accounts/cf2/tunnels/tun2")).status).toBe(404);
    expect((await call("DELETE", "/cloudflare/accounts/cf1/tunnels/tun2")).status).toBe(404);
    expect(called("enableTunnel").length + called("disableTunnel").length).toBe(0);
    expect((await call("POST", "/cloudflare/accounts/cf1/tunnels", { serverId: "srv-mine" })).status).toBe(201);
    expect(called("enableTunnel")).toEqual([["enableTunnel", "cf1", "srv-mine"]]);
  });
});

describe("private networks", () => {
  it("are for admins, and show only the organization's own networks", async () => {
    token(["projects.view"]);
    expect((await call("GET", "/private-networks")).status).toBe(403);
    token([], { admin: true });
    const { networks, servers } = await (await call("GET", "/private-networks")).json();
    expect(networks.map((n: { id: string }) => n.id)).toEqual(["n-mine"]);
    expect(servers.map((s: { id: string }) => s.id)).toEqual(["srv-mine", "srv-new"]);
  });

  it("refuse another organization's network, and a server that has not joined", async () => {
    token([], { admin: true });
    expect((await call("DELETE", "/private-networks/n-other")).status).toBe(404);
    expect((await call("PUT", "/private-networks/n-other/members", { serverId: "srv-mine", member: true })).status).toBe(404);
    const res = await call("PUT", "/private-networks/n-mine/members", { serverId: "srv-new", member: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/has not joined the private network/);
    expect(called("deleteNetwork").length + called("setNetworkMember").length).toBe(0);
    expect((await call("PUT", "/private-networks/n-mine/members", { serverId: "srv-mine", member: false })).status).toBe(200);
    expect(called("setNetworkMember")).toEqual([["setNetworkMember", "n-mine", "srv-mine", false]]);
  });

  it("show every network to a Root admin in the Root organization", async () => {
    token([], { admin: true });
    state.instanceAdmin = true;
    state.isRoot = true;
    const { networks } = await (await call("GET", "/private-networks")).json();
    expect(networks.map((n: { id: string }) => n.id)).toEqual(["n-mine", "n-other"]);
  });
});

describe("log drains", () => {
  it("need integrations.manage", async () => {
    token(["projects.view"]);
    expect((await call("GET", "/log-drains")).status).toBe(403);
  });

  it("keep the fields a change leaves out, the header name included", async () => {
    token(["integrations.manage"]);
    expect((await call("PUT", "/log-drains/ld1", { name: "renamed" })).status).toBe(200);
    const [, id, input] = called("updateLogDrain")[0] as [string, string, Record<string, unknown>];
    expect(id).toBe("ld1");
    expect(input).toMatchObject({ name: "renamed", kind: "http", url: "https://logs.example.com", headerName: "Authorization", headerValue: "", projectIds: ["p1"] });
    expect(called("setLogDrainEnabled")).toHaveLength(0);
    await call("PUT", "/log-drains/ld1", { enabled: false });
    expect(called("updateLogDrain")).toHaveLength(1);
    expect(called("setLogDrainEnabled")).toEqual([["setLogDrainEnabled", "ld1", false]]);
  });

  it("do not reach another organization's drain", async () => {
    token(["integrations.manage"], { org: "o2" });
    expect((await call("PUT", "/log-drains/ld1", { name: "x" })).status).toBe(404);
    expect(called("updateLogDrain")).toHaveLength(0);
  });
});

describe("new tokens", () => {
  it("expire no later than the token that makes them", async () => {
    token(["projects.view"]);
    state.tables.apiToken = [{ id: "tok1", expiresAt: new Date(Date.now() + 10.5 * 86_400_000) }];
    state.actionResult = { ok: true, data: { token: "srv_0123456789abcdef" } };
    expect((await call("POST", "/tokens", { name: "ci", scopes: ["projects.view"], expiresInDays: 30 })).status).toBe(400);
    expect((await call("POST", "/tokens", { name: "ci", scopes: ["projects.view"], expiresInDays: null })).status).toBe(400);
    expect((await call("POST", "/tokens", { name: "ci", scopes: ["projects.view"] })).status).toBe(201);
    expect(called("createApiToken")).toEqual([["createApiToken", { name: "ci", scopes: ["projects.view"], projectIds: null, expiresInDays: 10 }]]);
  });
});
