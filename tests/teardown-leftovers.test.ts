import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting a service goes on when a DNS record, a replica or a certificate cannot go with it, but
// what was left is reported (activity log, and the warning returned), never hidden.

const state = vi.hoisted(() => ({
  domains: [] as Record<string, unknown>[],
  activity: [] as { action: string; message: string }[],
  dnsError: null as Error | null,
  replicaError: null as Error | null,
}));
const tables = vi.hoisted(() => ({ service: { t: "service" }, domain: { t: "domain" }, deployment: { t: "deployment" }, project: { t: "project" }, keptDatabase: { t: "kept" } }));
vi.mock("@/server/db", () => {
  const where = (table: unknown) => async () => (table === tables.domain ? state.domains : []);
  return {
    db: {
      select: () => ({ from: (table: unknown) => ({ where: where(table) }) }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
      delete: () => ({ where: async () => {} }),
      insert: () => ({ values: async () => {} }),
    },
    schema: new Proxy(tables, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? {} }),
    sql: { notify: async () => {} },
  };
});
vi.mock("@/server/queue", () => ({ CANCEL_CHANNEL: "c", enqueue: vi.fn() }));
vi.mock("@/server/databases/branches", () => ({ removePreviewBranches: async () => {} }));
vi.mock("@/server/deploy/distribution", () => ({ runServerIds: (id: string) => [id] }));
vi.mock("@/server/git/repo-webhooks", () => ({ removeRepoWebhook: async () => {} }));
vi.mock("@/server/activity", () => ({ logActivity: async (e: { action: string; message: string }) => void state.activity.push(e) }));
vi.mock("@/server/cloudflare/api", () => ({
  Cloudflare: {
    forAccount: async () => ({
      removeDnsRecord: async () => {
        if (state.dnsError) throw state.dnsError;
      },
    }),
  },
}));
vi.mock("@/server/databases/addons", () => ({
  removeReplicaInstance: async () => {
    if (state.replicaError) throw state.replicaError;
  },
}));
vi.mock("@/server/ssl/certificates", () => ({ retireCertificateFor: async () => {}, cloudflareAccountFor: async () => null }));
vi.mock("@/server/cloudflare/tunnels", () => ({ syncTunnelIngress: async () => {} }));

const { teardownServices } = await import("@/server/services/teardown");

const app = { id: "a1", name: "shop", projectId: "p1", serverId: "s1", parentServiceId: null, type: "app", database: null, source: null } as never;
const db = {
  id: "d1",
  name: "main-db",
  projectId: "p1",
  serverId: "s1",
  parentServiceId: null,
  type: "database",
  source: null,
  database: { engine: "postgres", replica: { enabled: true, instances: [{ id: "r1", serverId: "s2" }] } },
} as never;

describe("tearing services down", () => {
  beforeEach(() => {
    state.domains = [{ hostname: "shop.example.com", serviceId: "a1", cloudflareAccountId: "cf", cloudflareZoneId: "z", cloudflareRecordId: "r" }];
    state.activity = [];
    state.dnsError = null;
    state.replicaError = null;
  });

  it("returns nothing and logs nothing when everything went", async () => {
    expect(await teardownServices([app], true)).toBeNull();
    expect(state.activity).toEqual([]);
  });

  it("reports a DNS record and a replica that could not be removed", async () => {
    state.dnsError = new Error("Cloudflare returned HTTP 403");
    state.replicaError = new Error("server s2 does not answer");
    const warning = await teardownServices([app, db], true);
    expect(warning).toContain("DNS record of shop.example.com: Cloudflare returned HTTP 403");
    expect(warning).toContain("Read replica r1 of main-db: server s2 does not answer");
    expect(state.activity).toEqual([expect.objectContaining({ action: "cleanup.leftover", message: warning })]);
  });

  it("keeps a removed service's DNS when only Serve forgets it", async () => {
    state.dnsError = new Error("would have been reported");
    expect(await teardownServices([app], false, { leaveRunning: true })).toBeNull();
  });
});
