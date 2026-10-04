import { describe, expect, it, vi } from "vitest";

// Confirming it is you with a provider signs in again: the old session of the same user is the one
// replaced (its organization kept, the row removed), never another user's.

const rows = vi.hoisted(() => new Map<string, { id: string; userId: string; activeOrganizationId: string | null }>());
vi.mock("@/server/db", () => {
  const schema = new Proxy({}, { get: () => new Proxy({}, { get: (_t, col) => col }) });
  let token = "";
  const db = {
    select: () => ({ from: () => ({ where: async () => (rows.has(token) ? [rows.get(token)] : []) }) }),
  };
  return { db, schema, setToken: (t: string) => (token = t) };
});
vi.mock("drizzle-orm", () => ({ eq: (_col: unknown, value: string) => value }));

const dbModule = (await import("@/server/db")) as unknown as { setToken: (t: string) => void };
const { providerSessionPath, replacedSession } = await import("@/server/replaced-session");

function ctx(path: string, cookie: string | null) {
  if (cookie) dbModule.setToken(cookie);
  return {
    path,
    getSignedCookie: async () => cookie,
    context: { secret: "s", authCookies: { sessionToken: { name: "serve.session_token" } } },
  };
}

rows.set("old", { id: "s-old", userId: "u1", activeOrganizationId: "org-2" });

describe("the session a provider sign-in replaces", () => {
  it("is found for the same user on a provider callback", async () => {
    expect(await replacedSession(ctx("/callback/github", "old"), "u1")).toEqual({ id: "s-old", userId: "u1", activeOrganizationId: "org-2" });
  });

  it("is left alone for another user, without a cookie, or outside a provider sign-in", async () => {
    expect(await replacedSession(ctx("/callback/github", "old"), "u2")).toBeNull();
    expect(await replacedSession(ctx("/callback/github", null), "u1")).toBeNull();
    expect(await replacedSession(ctx("/sign-in/email", "old"), "u1")).toBeNull();
    expect(await replacedSession(null, "u1")).toBeNull();
  });

  it("knows the provider sign-in paths", () => {
    expect(providerSessionPath("/callback/oidc")).toBe(true);
    expect(providerSessionPath("/sign-in/social")).toBe(true);
    expect(providerSessionPath("/passkey/verify-authentication")).toBe(false);
    expect(providerSessionPath(undefined)).toBe(false);
  });
});
