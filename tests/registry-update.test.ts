import { describe, expect, it, vi } from "vitest";

// Editing a registry: the saved password is never sent to a new host.
const logins: string[] = [];
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({
  db: { update: () => ({ set: () => ({ where: async () => {} }) }) },
  schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
}));
vi.mock("@/server/crypto", () => ({ encrypt: (v: string) => `enc:${v}` }));
vi.mock("@/server/auth", () => ({ requirePermission: async () => ({ isRoot: true, org: { id: "org" }, user: { id: "u" } }) }));
vi.mock("@/server/registries", () => ({
  getRegistry: async () => ({ id: "r", host: "ghcr.io", username: "me", password: "enc" }),
  registryAuth: () => ({ username: "me", password: "stored-secret" }),
  checkRegistryLogin: async (l: { serveraddress: string; password: string }) => {
    logins.push(`${l.serveraddress}:${l.password}`);
  },
}));

const { updateRegistry } = await import("@/server/actions/registries");

describe("registry edits", () => {
  it("asks for the password again when the host changes", async () => {
    const r = await updateRegistry("r", { kind: "generic", name: "x", host: "registry.attacker.example", username: "me", password: "" });
    expect(r).toEqual({ ok: false, error: "Enter the password again: the host changed." });
    expect(logins).toEqual([]);
  });

  it("keeps the stored password for the same host", async () => {
    const r = await updateRegistry("r", { kind: "generic", name: "renamed", host: "ghcr.io", username: "me", password: "" });
    expect(r.ok).toBe(true);
    expect(logins).toHaveLength(1);
    expect(logins[0]).toContain("stored-secret");
  });
});
