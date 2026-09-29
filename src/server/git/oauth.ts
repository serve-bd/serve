import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";
import { env } from "@/server/env";

export type OAuthProvider = "gitlab" | "gitea" | "bitbucket";
type OAuthApp = typeof schema.gitOAuthApp.$inferSelect;
type Credential = typeof schema.gitCredential.$inferSelect;

/** Tokens stored (encrypted, as JSON) in git_credential.secret for OAuth credentials. */
export type OAuthTokens = { accessToken: string; refreshToken: string | null; expiresAt: number | null };

export const oauthScopes: Record<OAuthProvider, string[]> = {
  gitlab: ["api", "read_user", "read_repository"],
  gitea: ["read:user", "write:repository"],
  bitbucket: ["account", "repository", "webhook", "pullrequest"],
};

/** Web root of the provider (not its API). */
export function webBase(provider: OAuthProvider, baseUrl: string | null) {
  const base = baseUrl?.replace(/\/$/, "");
  if (provider === "gitlab") return base ?? "https://gitlab.com";
  if (provider === "bitbucket") return "https://bitbucket.org";
  if (!base) throw new Error("Enter the address of your Gitea or Forgejo server.");
  return base;
}

/** Page where the user creates the OAuth application. */
export function appSetupUrl(provider: OAuthProvider, baseUrl: string | null) {
  if (provider === "gitlab") return `${webBase(provider, baseUrl)}/-/user_settings/applications`;
  if (provider === "gitea") return baseUrl ? `${webBase(provider, baseUrl)}/user/settings/applications` : null;
  return "https://bitbucket.org/account/workspaces/";
}

export function redirectUri(base: string, provider: OAuthProvider) {
  return `${base.replace(/\/$/, "")}/api/git/oauth/${provider}/callback`;
}

export function authorizeUrl(app: Pick<OAuthApp, "provider" | "baseUrl" | "clientId">, redirect: string, state: string) {
  const web = webBase(app.provider, app.baseUrl);
  const path = app.provider === "gitlab" ? "/oauth/authorize" : app.provider === "gitea" ? "/login/oauth/authorize" : "/site/oauth2/authorize";
  const url = new URL(web + path);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  // Bitbucket takes the callback URL from the consumer settings and its permissions from there too.
  if (app.provider !== "bitbucket") {
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("scope", oauthScopes[app.provider].join(" "));
  }
  return url.toString();
}

function tokenUrl(provider: OAuthProvider, baseUrl: string | null) {
  const web = webBase(provider, baseUrl);
  return provider === "gitlab" ? `${web}/oauth/token` : provider === "gitea" ? `${web}/login/oauth/access_token` : `${web}/site/oauth2/access_token`;
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

async function tokenRequest(app: OAuthApp, params: Record<string, string>): Promise<OAuthTokens> {
  const secret = decrypt(app.clientSecret);
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
  if (app.provider === "bitbucket") headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${secret}`).toString("base64")}`;
  else {
    body.set("client_id", app.clientId);
    body.set("client_secret", secret);
  }
  const res = await fetch(tokenUrl(app.provider, app.baseUrl), { method: "POST", headers, body, signal: AbortSignal.timeout(15000) });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || `The provider returned HTTP ${res.status}.`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : null,
  };
}

export function exchangeCode(app: OAuthApp, code: string, redirect: string) {
  return tokenRequest(app, { grant_type: "authorization_code", code, ...(app.provider === "bitbucket" ? {} : { redirect_uri: redirect }) });
}

export function refreshTokens(app: OAuthApp, refreshToken: string) {
  return tokenRequest(app, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export function readTokens(cred: Pick<Credential, "secret">): OAuthTokens {
  return JSON.parse(decrypt(cred.secret)) as OAuthTokens;
}

/** Tokens are refreshed when they expire within this window. */
const REFRESH_MARGIN = 5 * 60_000;

/**
 * The token to use for a credential: the stored token, or for OAuth credentials a
 * fresh access token (refreshed and saved when it is about to expire, or when `force`).
 */
export async function credentialToken(cred: Credential, opts: { force?: boolean } = {}): Promise<string> {
  if (!cred.oauthAppId) return decrypt(cred.secret);
  const tokens = readTokens(cred);
  const expiring = tokens.expiresAt !== null && tokens.expiresAt - Date.now() < REFRESH_MARGIN;
  if (!opts.force && !expiring) return tokens.accessToken;
  if (!tokens.refreshToken) return tokens.accessToken;
  const [app] = await db.select().from(schema.gitOAuthApp).where(eq(schema.gitOAuthApp.id, cred.oauthAppId));
  if (!app) throw new Error("The OAuth app of this connection was deleted.");
  let next: OAuthTokens;
  try {
    next = await refreshTokens(app, tokens.refreshToken);
  } catch (e) {
    throw new Error(`Could not refresh the ${app.name} connection: ${(e as Error).message} Reconnect it on the Git providers page.`);
  }
  // Some providers keep the refresh token unchanged and omit it.
  next.refreshToken ??= tokens.refreshToken;
  await db
    .update(schema.gitCredential)
    .set({ secret: encrypt(JSON.stringify(next)) })
    .where(eq(schema.gitCredential.id, cred.id));
  cred.secret = encrypt(JSON.stringify(next));
  return next.accessToken;
}

/** Run a provider call with the credential's token; retry once with a refreshed token on 401. */
export async function withCredentialToken<T>(cred: Credential, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await credentialToken(cred);
  try {
    return await fn(token);
  } catch (e) {
    if (!cred.oauthAppId || !(e instanceof Error) || !/rejected|401/.test(e.message)) throw e;
    return fn(await credentialToken(cred, { force: true }));
  }
}

/* ---------------------------------- State --------------------------------- */

export type OAuthState = { appId: string; organizationId: string; userId: string; exp: number };

function stateKey() {
  return crypto.createHash("sha256").update(`git-oauth:${env.authSecret}`).digest();
}

export function signOAuthState(state: Omit<OAuthState, "exp">) {
  const payload = Buffer.from(JSON.stringify({ ...state, exp: Date.now() + 30 * 60_000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", stateKey()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyOAuthState(token: string | null): OAuthState | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", stateKey()).update(payload).digest("base64url");
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString()) as OAuthState;
    return state.exp > Date.now() ? state : null;
  } catch {
    return null;
  }
}
