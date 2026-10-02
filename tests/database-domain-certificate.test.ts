import { beforeEach, describe, expect, it, vi } from "vitest";

// A database moved from its own port to a tunnel under the same name gives its certificate up,
// unless another database still uses the name directly.

const state = vi.hoisted(() => ({
  cert: { id: "c1", name: "db.example.com", domains: ["db.example.com"], provider: "letsencrypt-http", organizationId: "org", serverId: "srv" },
  databases: [] as { domain: string | null; tunnel: string | null }[],
  deleted: 0,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => {
  let call = 0;
  const select = () => ({
    from: () => {
      const n = call++;
      const rows = () => (n % 2 === 0 ? [state.cert] : state.databases);
      return { where: async () => rows(), innerJoin: () => ({ where: async () => rows() }) };
    },
  });
  return {
    db: {
      select,
      delete: () => ({
        where: async () => {
          state.deleted++;
          call = 0;
        },
      }),
      reset: () => {
        call = 0;
      },
    },
    schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
  };
});
vi.mock("@/server/db/schema", () => ({ LOCAL_SERVER_ID: "local" }));
vi.mock("@/server/proxy/nginx", () => ({ servicesUsingCertificate: async () => [] }));
vi.mock("@/server/settings", () => ({ getSettings: async () => ({}) }));
vi.mock("@/server/servers/context", () => ({
  getServer: async () => {
    throw new Error("gone");
  },
}));
vi.mock("@/server/notify", () => ({ notify: vi.fn() }));
vi.mock("@/server/queue", () => ({ enqueue: vi.fn() }));

import { db } from "@/server/db";
import { retireCertificate } from "@/server/ssl/certificates";

describe("retiring a database domain's certificate", () => {
  beforeEach(() => {
    state.deleted = 0;
    (db as unknown as { reset: () => void }).reset();
  });

  it("retires it when the only database on the name now goes through a tunnel", async () => {
    state.databases = [{ domain: "db.example.com", tunnel: "t1" }];
    await retireCertificate("c1");
    expect(state.deleted).toBe(1);
  });

  it("keeps it while another database uses the name on its own port", async () => {
    state.databases = [
      { domain: "db.example.com", tunnel: "t1" },
      { domain: "db.example.com", tunnel: null },
    ];
    await retireCertificate("c1");
    expect(state.deleted).toBe(0);
  });
});
