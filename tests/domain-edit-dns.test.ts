import { beforeEach, describe, expect, it, vi } from "vitest";

// Editing a domain on the public IP route sets its A record in Cloudflare: made, proxied or not,
// or removed. Only organization admins change DNS records, and only in their own accounts.

const state = vi.hoisted(() => ({
  domain: {} as Record<string, unknown>,
  accounts: ["acc1"],
  admin: true,
  upserts: [] as unknown[][],
  removed: [] as string[],
  saved: {} as Record<string, unknown>,
}));
vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", async (actual) => {
  const real = await actual<typeof import("drizzle-orm")>();
  return { ...real, eq: (col: unknown, value: unknown) => ({ eq: [col, value] }), and: (...c: unknown[]) => ({ and: c }) };
});
vi.mock("@/server/db", () => {
  const tables = { domain: { t: "domain" }, cloudflareAccount: { t: "account" } };
  const schema = new Proxy(tables, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? new Proxy({}, { get: (_x, col) => col }) });
  const conds = (w: unknown): [unknown, unknown][] => {
    const o = w as { eq?: [unknown, unknown]; and?: unknown[] };
    return o.eq ? [o.eq] : (o.and ?? []).flatMap(conds);
  };
  return {
    schema,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: async (w: unknown) => {
            if (table === tables.cloudflareAccount) {
              const id = conds(w)[0]?.[1];
              return state.accounts.includes(id as string) ? [{ id }] : [];
            }
            return [state.domain];
          },
        }),
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              state.saved = v;
              return [{ ...state.domain, ...v }];
            },
          }),
        }),
      }),
    },
  };
});
vi.mock("@/server/auth", () => ({ requirePermission: async () => ({ isAdmin: state.admin, org: { id: "org" }, user: { id: "u" } }), ForbiddenError: class extends Error {} }));
vi.mock("@/server/activity", () => ({ logActivity: async () => {} }));
vi.mock("@/server/queue", () => ({ enqueue: async () => {} }));
vi.mock("@/server/services/access", () => ({ serviceInOrg: async () => ({ service: { id: "s", name: "web", projectId: "p", type: "app", serverId: "srv" } }) }));
vi.mock("@/server/servers/access", () => ({ serverPublicIp: async () => "203.0.113.7", resolveServerForOrg: vi.fn() }));
vi.mock("@/server/proxy/nginx", () => ({ syncServiceProxy: async () => {}, removeServiceProxy: async () => {} }));
vi.mock("@/server/ssl/certificates", () => ({ ensureCertificateFor: async () => null }));
vi.mock("@/server/cloudflare/api", () => ({
  Cloudflare: {
    forAccount: async () => ({
      zone: async (id: string) => (id === "z1" ? { id: "z1", name: "example.com" } : null),
      upsertARecord: async (...args: unknown[]) => {
        state.upserts.push(args);
        return { id: "rec-new" };
      },
      removeDnsRecord: async (_zone: string, id: string) => void state.removed.push(id),
    }),
  },
}));

const { updateDomain } = await import("@/server/actions/services");
const dns = (record: boolean, proxied: boolean, accountId = "acc1", zoneId = "z1") => ({ dns: { accountId, zoneId, record, proxied } });

describe("editing a domain's DNS record", () => {
  beforeEach(() => {
    state.domain = {
      id: "d1",
      serviceId: "s",
      hostname: "app.example.com",
      tunnelId: null,
      https: true,
      certificateId: null,
      cloudflareAccountId: null,
      cloudflareZoneId: null,
      cloudflareRecordId: null,
    };
    state.accounts = ["acc1"];
    state.admin = true;
    state.upserts = [];
    state.removed = [];
    state.saved = {};
  });

  it("makes the A record, proxied as asked, and remembers it", async () => {
    expect(await updateDomain("d1", dns(true, false))).toEqual({ ok: true, data: null });
    expect(state.upserts).toEqual([["z1", "app.example.com", "203.0.113.7", false]]);
    expect(state.saved).toMatchObject({ cloudflareAccountId: "acc1", cloudflareZoneId: "z1", cloudflareRecordId: "rec-new" });
  });

  it("removes the record Serve made when asked to", async () => {
    Object.assign(state.domain, { cloudflareAccountId: "acc1", cloudflareZoneId: "z1", cloudflareRecordId: "rec-old" });
    expect((await updateDomain("d1", dns(false, false))).ok).toBe(true);
    expect(state.removed).toEqual(["rec-old"]);
    expect(state.saved).toMatchObject({ cloudflareRecordId: null });
  });

  it("refuses members who are not admins, other organizations' accounts and zones that do not hold the name", async () => {
    state.admin = false;
    expect(await updateDomain("d1", dns(true, true))).toEqual({ ok: false, error: expect.stringContaining("admins") });
    state.admin = true;
    expect(await updateDomain("d1", dns(true, true, "someone-elses"))).toEqual({ ok: false, error: "Cloudflare account not found." });
    expect(await updateDomain("d1", dns(true, true, "acc1", "z-other"))).toEqual({ ok: false, error: expect.stringContaining("not part of") });
    state.domain.hostname = "app.example.org";
    expect(await updateDomain("d1", dns(true, true))).toEqual({ ok: false, error: expect.stringContaining("not part of") });
    expect(state.upserts).toEqual([]);
  });

  it("leaves a tunnel domain's record to the route setting", async () => {
    state.domain.tunnelId = "t1";
    expect((await updateDomain("d1", dns(true, true))).ok).toBe(true);
    expect(state.upserts).toEqual([]);
  });
});
