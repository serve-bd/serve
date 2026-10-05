import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { accounts: [] as string[], updates: [] as unknown[] };
vi.mock("@/server/db", () => {
  const chain = (rows: () => unknown[]) => ({ from: () => ({ where: async () => rows() }) });
  return {
    schema: { cloudflareAccount: { id: "id", organizationId: "org" }, domain: { id: "id" } },
    db: {
      select: () => chain(() => state.accounts.map((id) => ({ id }))),
      update: () => ({ set: (v: unknown) => ({ where: async () => void state.updates.push(v) }) }),
    },
  };
});
vi.mock("drizzle-orm", () => ({ and: () => null, eq: () => null }));
vi.mock("@/server/ssl/certificates", () => ({ cloudflareAccountFor: async () => (state.accounts.includes("acc-new") ? "acc-new" : null) }));
vi.mock("@/server/cloudflare/api", () => ({ Cloudflare: { forAccount: async () => ({ zoneFor: async () => ({ id: "zone-new" }) }) } }));

import { domainCloudflare } from "@/server/cloudflare/domain-link";

const domain = (d: Record<string, unknown>) => ({ id: "d1", hostname: "serve.bd", cloudflareAccountId: null, cloudflareZoneId: "zone-old", ...d }) as never;

describe("domainCloudflare", () => {
  beforeEach(() => {
    state.accounts = [];
    state.updates = [];
  });

  it("keeps the saved account while it is connected", async () => {
    state.accounts = ["acc-1"];
    expect(await domainCloudflare(domain({ cloudflareAccountId: "acc-1" }), "org")).toEqual({ accountId: "acc-1", zoneId: "zone-old" });
    expect(state.updates).toEqual([]);
  });

  it("finds the account connected again by the zone that holds the name, and saves it", async () => {
    state.accounts = ["acc-new"];
    expect(await domainCloudflare(domain({}), "org")).toEqual({ accountId: "acc-new", zoneId: "zone-new" });
    expect(state.updates).toEqual([{ cloudflareAccountId: "acc-new", cloudflareZoneId: "zone-new" }]);
  });

  it("is null when no connected account holds the zone", async () => {
    expect(await domainCloudflare(domain({}), "org")).toBeNull();
  });
});
