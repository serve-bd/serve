import { beforeEach, describe, expect, it, vi } from "vitest";

// "Confirm it's you": what a stale sign-in is offered, and the password check that makes it recent.

const state = vi.hoisted(() => ({
  session: { user: { id: "u1" }, session: { id: "s1" } } as { user: { id: string }; session: { id: string } } | null,
  accounts: [{ providerId: "credential" }] as { providerId: string }[],
  passwordOn: true,
  goodPassword: "right-password",
  sessionUpdates: [] as Record<string, unknown>[],
  getSessionCalls: [] as unknown[],
  verifyCalls: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/db", () => {
  const schema = new Proxy({}, { get: () => new Proxy({}, { get: (_t, col) => col }) });
  const db = {
    select: () => ({ from: () => ({ where: async () => state.accounts }) }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => void state.sessionUpdates.push(v) }) }),
  };
  return { db, schema };
});
vi.mock("@/server/settings", () => ({
  getSetting: async () => ({
    passwordEnabled: state.passwordOn,
    providers: { github: { enabled: true, clientId: "id", clientSecret: "secret" }, google: { enabled: false } },
  }),
}));
vi.mock("@/server/auth", () => ({
  passwordLoginAllowed: async () => state.passwordOn,
  authFor: () => ({
    api: {
      getSession: async (opts: unknown) => {
        state.getSessionCalls.push(opts);
        return state.session;
      },
      verifyPassword: async ({ body }: { body: { password: string } }) => {
        state.verifyCalls++;
        if (!state.session) throw Object.assign(new Error("Unauthorized"), { status: "UNAUTHORIZED", statusCode: 401 });
        if (body.password !== state.goodPassword) throw Object.assign(new Error("Invalid password"), { status: "BAD_REQUEST", statusCode: 400 });
        return { status: true };
      },
    },
  }),
}));

const { confirmPassword, identityMethods } = await import("@/server/actions/reauth");
const { authErrorMessage, needsFreshSession, reauthMethods } = await import("@/lib/reauth");

const github = { id: "github", label: "GitHub" };
const google = { id: "google", label: "Google" };

describe("how a user confirms it is them", () => {
  it("asks for the password when the account has one", () => {
    expect(reauthMethods({ linked: ["credential", "github"], passwordSignIn: true, activeProviders: [github] })).toEqual({ password: true, providers: [] });
  });

  it("offers each linked provider that is on to accounts without a password", () => {
    expect(reauthMethods({ linked: ["github", "google"], passwordSignIn: true, activeProviders: [github, google] })).toEqual({ password: false, providers: [github, google] });
    // Linked but turned off by an admin: it cannot sign in, so it is not offered.
    expect(reauthMethods({ linked: ["github", "google"], passwordSignIn: true, activeProviders: [github] })).toEqual({ password: false, providers: [github] });
  });

  it("uses a provider instead of the password while password sign-in is off", () => {
    expect(reauthMethods({ linked: ["credential", "github"], passwordSignIn: false, activeProviders: [github] })).toEqual({ password: false, providers: [github] });
    // No provider to use: the password stays the way.
    expect(reauthMethods({ linked: ["credential"], passwordSignIn: false, activeProviders: [github] })).toEqual({ password: true, providers: [] });
  });

  it("has nothing to offer when no linked method is on", () => {
    expect(reauthMethods({ linked: ["github"], passwordSignIn: true, activeProviders: [] })).toEqual({ password: false, providers: [] });
  });
});

describe("account errors in plain words", () => {
  it("never shows better-auth's freshness error", () => {
    const error = { code: "SESSION_NOT_FRESH", message: "Session is not fresh", status: 403 };
    expect(needsFreshSession(error)).toBe(true);
    expect(needsFreshSession({ code: "SESSION_EXPIRED" })).toBe(true);
    expect(authErrorMessage(error, "Could not add the passkey.")).not.toMatch(/fresh/i);
    expect(authErrorMessage({ message: "Session is not fresh" }, "Could not add the passkey.")).toBe("Could not add the passkey.");
  });

  it("explains a sign-out and keeps readable messages", () => {
    expect(authErrorMessage({ code: "UNAUTHORIZED", status: 401 }, "x")).toBe("You were signed out. Sign in again to continue.");
    expect(authErrorMessage({ message: "Invalid password" }, "x")).toBe("Invalid password");
    expect(authErrorMessage({ message: "FAILED_TO_GET_SESSION" }, "Could not save")).toBe("Could not save");
    expect(authErrorMessage(null, "Could not save")).toBe("Could not save");
    expect(needsFreshSession({ code: "INVALID_PASSWORD" })).toBe(false);
    expect(needsFreshSession(null)).toBe(false);
  });
});

describe("confirming with the password", () => {
  let user = 0;
  beforeEach(() => {
    // A user of its own per test: the attempt limit is per user.
    user++;
    state.session = { user: { id: `u${user}` }, session: { id: `s${user}` } };
    state.accounts = [{ providerId: "credential" }];
    state.passwordOn = true;
    state.sessionUpdates = [];
    state.getSessionCalls = [];
    state.verifyCalls = 0;
  });

  it("makes the sign-in recent and rewrites the session cookie copy", async () => {
    const before = Date.now();
    expect(await confirmPassword("right-password")).toEqual({ ok: true, data: null });
    expect(state.sessionUpdates).toHaveLength(1);
    expect((state.sessionUpdates[0].createdAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    // Read from the database before and after, never from the minute-long cookie copy.
    expect(state.getSessionCalls).toEqual([expect.objectContaining({ query: { disableCookieCache: true } }), expect.objectContaining({ query: { disableCookieCache: true } })]);
  });

  it("says a wrong password plainly and changes nothing", async () => {
    expect(await confirmPassword("nope")).toEqual({ ok: false, error: "That password is not right." });
    expect(await confirmPassword("")).toMatchObject({ ok: false, error: "Enter your password" });
    expect(state.sessionUpdates).toHaveLength(0);
  });

  it("stops guessing after ten tries in 15 minutes", async () => {
    for (let i = 0; i < 10; i++) await confirmPassword("nope");
    expect(await confirmPassword("right-password")).toEqual({ ok: false, error: "Too many tries. Wait 15 minutes and try again." });
    expect(state.verifyCalls).toBe(10);
    expect(state.sessionUpdates).toHaveLength(0);
  });

  it("asks to sign in again once the session is gone", async () => {
    state.session = null;
    expect(await confirmPassword("right-password")).toEqual({ ok: false, error: "You were signed out. Sign in again to continue." });
    expect(await identityMethods()).toEqual({ ok: false, error: "You were signed out. Sign in again to continue." });
  });

  it("refuses the password for accounts that confirm with a provider", async () => {
    state.accounts = [{ providerId: "github" }];
    expect(await confirmPassword("right-password")).toMatchObject({ ok: false, error: expect.stringMatching(/sign-in provider/) });
    expect(state.verifyCalls).toBe(0);
    expect(await identityMethods()).toEqual({ ok: true, data: { userId: `u${user}`, password: false, providers: [github] } });
  });

  it("follows password sign-in being turned off", async () => {
    state.accounts = [{ providerId: "credential" }, { providerId: "github" }];
    state.passwordOn = false;
    expect(await confirmPassword("right-password")).toMatchObject({ ok: false });
    expect(state.sessionUpdates).toHaveLength(0);
  });
});
