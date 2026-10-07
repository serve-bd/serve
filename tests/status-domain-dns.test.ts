import { beforeEach, describe, expect, it, vi } from "vitest";

// A status page on the public IP route gets its A record from Serve when a connected Cloudflare
// account manages the name, and loses it with the page. Records someone else made stay theirs.

const state = vi.hoisted(() => ({
  page: { id: "pg", name: "Status", domain: "status.example.com", tunnelId: null as string | null, https: true, certificateId: null },
  account: "cf1" as string | null,
  serverIp: "203.0.113.7" as string | null,
  records: [] as { id: string; type: string; name: string; content: string; comment?: string }[],
  upserts: [] as unknown[][],
  upsertError: null as Error | null,
  admin: true,
  certs: [] as Record<string, unknown>[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => {
  const certificate = { t: "certificate" };
  return {
    db: {
      select: () => ({ from: (table: unknown) => ({ where: async () => (table === certificate ? state.certs : [state.page]) }) }),
      delete: () => ({ where: async () => {} }),
    },
    schema: new Proxy({ certificate } as Record<string, unknown>, { get: (t, k: string) => t[k] ?? new Proxy({}, { get: () => ({}) }) }),
  };
});
vi.mock("@/server/db/schema", () => ({ LOCAL_SERVER_ID: "local" }));
vi.mock("@/server/auth", () => ({ requirePermission: async () => ({ org: { id: "org" }, user: { id: "u" }, projectIds: null, isAdmin: state.admin }) }));
vi.mock("@/server/activity", () => ({ logActivity: async () => {} }));
vi.mock("@/server/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/server/settings", () => ({ getSettings: async () => ({ serverIp: state.serverIp }) }));
vi.mock("@/server/cloudflare/tunnels", () => ({ syncTunnelIngress: async () => {} }));
vi.mock("@/server/ssl/certificates", () => ({ cloudflareAccountFor: async () => state.account, retireCertificateFor: async () => {} }));
vi.mock("@/server/cloudflare/api", () => ({
  Cloudflare: {
    forAccount: async () => ({
      zoneFor: async () => ({ id: "z1" }),
      upsertARecord: async (...args: unknown[]) => {
        if (state.upsertError) throw state.upsertError;
        state.upserts.push(args);
        return { id: "r-new" };
      },
      dnsRecords: async () => state.records,
      removeDnsRecord: async (_zone: string, id: string) =>
        void state.records.splice(
          state.records.findIndex((r) => r.id === id),
          1,
        ),
    }),
  },
}));

const { createStatusRecord, deleteStatusPage } = await import("@/server/actions/status-pages");

describe("a status page's A record", () => {
  beforeEach(() => {
    state.page = { ...state.page, domain: "status.example.com", tunnelId: null };
    state.account = "cf1";
    state.serverIp = "203.0.113.7";
    state.records = [];
    state.upserts = [];
    state.upsertError = null;
    state.admin = true;
    state.certs = [];
  });

  it("goes through Cloudflare's proxy when the page's certificate is a Cloudflare Origin one, which browsers do not trust", async () => {
    state.certs = [{ id: "c1", provider: "cloudflare-origin", status: "active", certPath: "/c", keyPath: "/k", domains: ["*.example.com"], expiresAt: null }];
    await createStatusRecord("pg");
    expect(state.upserts).toEqual([["z1", "status.example.com", "203.0.113.7", true]]);
  });

  it("is made by organization admins only, as for app domains", async () => {
    state.admin = false;
    expect(await createStatusRecord("pg")).toEqual({ ok: false, error: expect.stringContaining("admins") });
    expect(state.upserts).toEqual([]);
  });

  it("is created DNS only, pointing at the address the page shows", async () => {
    expect(await createStatusRecord("pg")).toEqual({ ok: true, data: null });
    expect(state.upserts).toEqual([["z1", "status.example.com", "203.0.113.7", false]]);
  });

  it("says why when Cloudflare refuses (a record someone else made)", async () => {
    state.upsertError = new Error("status.example.com already has a CNAME record (elsewhere.net).");
    const r = await createStatusRecord("pg");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("already has a CNAME record") });
  });

  it("is not Serve's to make without a connected account, a public IP, or on a tunnel", async () => {
    state.account = null;
    expect((await createStatusRecord("pg")).ok).toBe(false);
    state.account = "cf1";
    state.serverIp = null;
    expect(await createStatusRecord("pg")).toEqual({ ok: false, error: expect.stringContaining("public IP") });
    state.serverIp = "203.0.113.7";
    state.page.tunnelId = "t1";
    expect((await createStatusRecord("pg")).ok).toBe(false);
    expect(state.upserts).toEqual([]);
  });

  it("goes with the page, and only the one Serve made", async () => {
    state.records = [
      { id: "mine", type: "A", name: "status.example.com", content: "203.0.113.7", comment: "Managed by Serve" },
      { id: "theirs", type: "TXT", name: "status.example.com", content: "verify" },
    ];
    expect(await deleteStatusPage("pg")).toEqual({ ok: true, data: null });
    expect(state.records.map((r) => r.id)).toEqual(["theirs"]);
  });
});
