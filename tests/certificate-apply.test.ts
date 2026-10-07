import { beforeEach, describe, expect, it, vi } from "vitest";

// A certificate that some proxy could not take says so, on the certificate, instead of passing as loaded.

const state = vi.hoisted(() => ({ updates: [] as Record<string, unknown>[], logs: "" }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [{ name: "shop", logs: state.logs }] }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push(values);
          if (typeof values.logs === "string") state.logs = values.logs;
        },
      }),
    }),
  },
  schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
}));
vi.mock("@/server/db/schema", () => ({ LOCAL_SERVER_ID: "local" }));
const syncServiceProxy = vi.fn();
const reloadProxy = vi.fn();
vi.mock("@/server/proxy/nginx", () => ({
  servicesUsingCertificate: async () => ["svc1"],
  syncServiceProxy,
  reloadProxy,
  syncDashboardProxy: vi.fn(),
  syncStatusProxy: vi.fn(),
}));
vi.mock("@/server/settings", () => ({ getSettings: async () => ({}) }));
vi.mock("@/server/servers/context", () => ({ getServer: async () => ({}) }));
vi.mock("@/server/databases/domain-tls", () => ({ refreshDatabaseCertificates: async () => {} }));
vi.mock("@/server/notify", () => ({ notify: vi.fn() }));
vi.mock("@/server/queue", () => ({ enqueue: vi.fn() }));

const { applyCertificate } = await import("@/server/ssl/certificates");
const cert = { id: "c1", domains: ["shop.example.com"], organizationId: "org", serverId: "srv" } as never;

describe("applying a certificate", () => {
  beforeEach(() => {
    state.updates = [];
    state.logs = "";
    syncServiceProxy.mockReset().mockResolvedValue(undefined);
    reloadProxy.mockReset().mockResolvedValue(undefined);
  });

  it("returns nothing and records nothing when every proxy took it", async () => {
    expect(await applyCertificate(cert)).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("names what did not take it, in the result and on the certificate", async () => {
    syncServiceProxy.mockRejectedValue(new Error("nginx: [emerg] bad config"));
    reloadProxy.mockRejectedValue(new Error("server unreachable"));
    const problems = await applyCertificate(cert);
    expect(problems).toEqual(["shop: nginx: [emerg] bad config", "Proxy reload: server unreachable"]);
    expect(state.updates.at(-1)?.lastError).toMatch(/^Not loaded everywhere yet: shop: nginx.*Proxy reload: server unreachable$/);
    expect(state.logs).toContain("Not loaded everywhere yet");
  });
});
