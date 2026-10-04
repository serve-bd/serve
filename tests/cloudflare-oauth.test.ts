import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.SERVE_ENCRYPTION_KEY ??= "test-key-for-cloudflare-oauth";

/** The one stored account, and what the transaction wrote to it. */
const store: { row: Record<string, unknown> | null; updates: Record<string, unknown>[] } = { row: null, updates: [] };

vi.mock("@/server/db", () => {
  const tx = {
    execute: async () => {},
    select: () => ({ from: () => ({ where: async () => (store.row ? [store.row] : []) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          store.updates.push(values);
          store.row = { ...store.row, ...values };
        },
      }),
    }),
  };
  return { db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) }, schema: { cloudflareAccount: { id: "id" }, cloudflareCredential: { id: "id" } } };
});

import { decrypt, encrypt } from "@/server/crypto";
import { credentialToken as accountToken, readOauthState, startOauth } from "@/server/cloudflare/oauth";

const account = (over: Record<string, unknown> = {}) =>
  ({
    id: "a1",
    organizationId: "o1",
    authType: "oauth",
    secret: encrypt("old-access"),
    refreshToken: encrypt("old-refresh"),
    tokenExpiresAt: new Date(Date.now() + 60_000),
    originCaKey: null,
    ...over,
  }) as never;

beforeEach(() => {
  process.env.CLOUDFLARE_OAUTH_CLIENT_ID = "client-1";
  store.row = null;
  store.updates = [];
});
afterEach(() => {
  delete process.env.CLOUDFLARE_OAUTH_CLIENT_ID;
  delete process.env.CLOUDFLARE_OAUTH_REDIRECT_URI;
  vi.unstubAllGlobals();
});

describe("startOauth", () => {
  const input = { userId: "u1", organizationId: "o1", accountId: null, callback: "http://10.0.0.5:8000/api/cloudflare/oauth/callback" };

  it("goes through the relay, which goes on to Cloudflare with PKCE", () => {
    const relay = new URL(startOauth(input));
    expect(relay.origin + relay.pathname).toBe("https://serve.bd/connect/cloudflare");
    expect(relay.searchParams.get("return")).toBe(input.callback);
    const auth = new URL(relay.searchParams.get("auth")!);
    expect(auth.origin + auth.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(auth.searchParams.get("client_id")).toBe("client-1");
    expect(auth.searchParams.get("redirect_uri")).toBe("https://serve.bd/connect/cloudflare");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("scope")).toContain("argotunnel.write");
  });

  it("keeps the verifier out of sight of the relay: the state is encrypted", () => {
    const auth = new URL(new URL(startOauth(input)).searchParams.get("auth")!);
    const raw = auth.searchParams.get("state")!;
    const state = readOauthState(raw)!;
    expect(state).toMatchObject({ userId: "u1", organizationId: "o1", callback: input.callback });
    expect(state.verifier.length).toBeGreaterThan(40);
    expect(raw).not.toContain(state.verifier);
    expect(auth.toString()).not.toContain(state.verifier);
  });

  it("goes straight to Cloudflare when the client is registered with the instance's own address", () => {
    process.env.CLOUDFLARE_OAUTH_REDIRECT_URI = input.callback;
    const auth = new URL(startOauth(input));
    expect(auth.origin).toBe("https://dash.cloudflare.com");
    expect(auth.searchParams.get("redirect_uri")).toBe(input.callback);
  });

  it("uses Serve's own client by default", () => {
    delete process.env.CLOUDFLARE_OAUTH_CLIENT_ID;
    const auth = new URL(new URL(startOauth(input)).searchParams.get("auth")!);
    expect(auth.searchParams.get("client_id")).toBe("ea2e921d3fb6f1acfd6e24bd319b8b77");
  });
});

describe("readOauthState", () => {
  it("refuses tampered, foreign and expired states", () => {
    expect(readOauthState(null)).toBeNull();
    expect(readOauthState("v1:garbage")).toBeNull();
    // Some other encrypted value of this instance is not a sign-in.
    expect(readOauthState(encrypt(JSON.stringify({ userId: "u1", exp: Date.now() + 60_000 })))).toBeNull();
    expect(readOauthState(encrypt(JSON.stringify({ p: "cf-oauth", userId: "u1", exp: Date.now() - 1 })))).toBeNull();
  });
});

describe("accountToken", () => {
  it("uses a pasted token as it is", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await accountToken(account({ authType: "token", tokenExpiresAt: null }))).toBe("old-access");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses an OAuth token that is not close to expiry", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await accountToken(account({ tokenExpiresAt: new Date(Date.now() + 3600_000) }))).toBe("old-access");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renews a token close to expiry and stores the new refresh token", async () => {
    store.row = account();
    const fetch = vi.fn(async (_url: string, init: { body: URLSearchParams }) => {
      expect(init.body.get("grant_type")).toBe("refresh_token");
      expect(init.body.get("refresh_token")).toBe("old-refresh");
      expect(init.body.get("client_id")).toBe("client-1");
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await accountToken(store.row as never)).toBe("new-access");
    expect(store.updates).toHaveLength(1);
    expect(decrypt(store.updates[0].refreshToken as string)).toBe("new-refresh");
    expect((store.updates[0].tokenExpiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 3500_000);
  });

  it("takes the token another process renewed while it waited for the lock", async () => {
    const stale = account();
    store.row = account({ secret: encrypt("renewed-elsewhere"), tokenExpiresAt: new Date(Date.now() + 3600_000) });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await accountToken(stale)).toBe("renewed-elsewhere");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renews a fresh token when forced, but not one renewed while it waited", async () => {
    store.row = account({ tokenExpiresAt: new Date(Date.now() + 3600_000) });
    vi.stubGlobal("fetch", async () => Response.json({ access_token: "forced", refresh_token: "r2", expires_in: 3600 }));
    expect(await accountToken(store.row as never, { force: true })).toBe("forced");
    const seen = account({ tokenExpiresAt: new Date(Date.now() + 3600_000) });
    store.row = account({ secret: encrypt("renewed-elsewhere"), tokenExpiresAt: new Date(Date.now() + 3600_000) });
    expect(await accountToken(seen, { force: true })).toBe("renewed-elsewhere");
  });

  it("asks to reconnect when Cloudflare no longer accepts the grant", async () => {
    store.row = account();
    vi.stubGlobal("fetch", async () => Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 }));
    await expect(accountToken(store.row as never)).rejects.toThrow(/removed or has expired. Reconnect/);
    expect(store.updates).toHaveLength(0);
  });

  it("keeps the grant on a passing Cloudflare error", async () => {
    store.row = account();
    vi.stubGlobal("fetch", async () => new Response("bad gateway", { status: 502 }));
    await expect(accountToken(store.row as never)).rejects.toThrow(/did not issue a token: HTTP 502/);
    expect(store.updates).toHaveLength(0);
  });
});
