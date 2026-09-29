import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
vi.mock("@/server/servers/context", () => ({ getServer: vi.fn() }));
vi.mock("@/server/docker/client", () => ({ imageExists: vi.fn(), pullImage: vi.fn(), LABEL: { managed: "serve.managed", kind: "serve.kind" } }));
vi.mock("@/server/settings", () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));

const { reattachCandidates } = await import("@/server/cloudflare/tunnels");
const { relativeRecordName } = await import("@/lib/dns-name");

const d = (id: string, o: Partial<{ wantsTunnel: boolean; tunnelId: string | null; hostname: string; tunnelError: string | null; serverId: string }> = {}) => ({
  id,
  wantsTunnel: o.wantsTunnel ?? true,
  tunnelId: o.tunnelId ?? null,
  hostname: o.hostname ?? `${id}.example.com`,
  tunnelError: o.tunnelError ?? null,
  serverId: o.serverId ?? "s1",
});

describe("reattachCandidates", () => {
  const all = [
    d("waiting"),
    d("routed", { tunnelId: "t1" }),
    d("ip", { wantsTunnel: false }),
    d("other-server", { serverId: "s2" }),
    d("wildcard", { hostname: "*.example.com" }),
    d("failed", { tunnelError: "record exists" }),
  ];
  it("picks domains of the server that want a tunnel and have none", () => {
    expect(reattachCandidates(all, "s1").map((x) => x.id)).toEqual(["waiting", "failed"]);
  });
  it("skips earlier failures in automatic runs", () => {
    expect(reattachCandidates(all, "s1", { skipFailed: true }).map((x) => x.id)).toEqual(["waiting"]);
  });
  it("limits to one domain for a manual reconnect", () => {
    expect(reattachCandidates(all, "s1", { domainId: "failed" }).map((x) => x.id)).toEqual(["failed"]);
  });
});

describe("relativeRecordName", () => {
  it("handles apex, subdomains and two-label suffixes", () => {
    expect(relativeRecordName("example.com")).toBe("@");
    expect(relativeRecordName("app.example.com")).toBe("app");
    expect(relativeRecordName("a.b.example.com")).toBe("a.b");
    expect(relativeRecordName("example.co.uk")).toBe("@");
    expect(relativeRecordName("app.example.co.uk")).toBe("app");
    expect(relativeRecordName("shop.example.com.bd")).toBe("shop");
  });
});
