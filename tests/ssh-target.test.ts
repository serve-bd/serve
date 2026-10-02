import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ privateKey: "KEY" }] }) }) },
  schema: { privateKey: { id: "id" }, server: {} },
}));
vi.mock("@/server/crypto", () => ({ decrypt: (v: string) => v }));
vi.mock("@/server/docker/client", () => ({ docker: {} }));

import { sshTargetFor, type ServerRow } from "@/server/servers/context";

const row = (host: string) =>
  ({ id: "s1", host, port: 2222, username: "root", privateKeyId: "k1", hostKey: null, tunnel: null, ownerOrganizationId: null }) as unknown as ServerRow;

describe("sshTargetFor", () => {
  it("dials an IPv6 address saved in brackets without them", async () => {
    expect((await sshTargetFor(row("[2001:db8::5]"))).host).toBe("2001:db8::5");
    expect((await sshTargetFor(row("2001:db8::5"))).host).toBe("2001:db8::5");
    expect((await sshTargetFor(row("srv.example.com"))).host).toBe("srv.example.com");
  });
});
