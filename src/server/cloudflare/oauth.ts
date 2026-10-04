import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";

/**
 * "Connect with Cloudflare": OAuth with Serve's public Cloudflare client. The client uses PKCE, so it
 * has no secret and every instance shares it. Cloudflare only returns to registered addresses, so it
 * returns to a page on serve.bd that forwards the browser to the instance that started the sign-in.
 * That page only sees the code: the PKCE verifier stays on the instance, inside the encrypted state.
 */

const AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";

/** Serve's public OAuth client. Not a secret. */
const CLIENT_ID = "ea2e921d3fb6f1acfd6e24bd319b8b77";
const RELAY_URL = "https://serve.bd/connect/cloudflare";
/**
 * The permissions Serve uses, as Cloudflare's OAuth scope ids (GET /oauth/scopes). Tunnels need
 * Cloudflare Tunnel Write; Cloudflare One Connectors Write is its newer name.
 */
const SCOPES = ["zone.read", "dns.write", "zone-settings.write", "ssl-and-certificates.write", "argotunnel.write", "teams-connectors.write"];

/** Renew this long before the access token runs out, so no request races the expiry. */
const RENEW_BEFORE_MS = 5 * 60_000;
/** How long a started sign-in may take. */
const STATE_TTL_MS = 15 * 60_000;

export function oauthConfig() {
  const clientId = process.env.CLOUDFLARE_OAUTH_CLIENT_ID ?? CLIENT_ID;
  if (!clientId) return null;
  return {
    clientId,
    /** Where Cloudflare sends the browser back. Set it to the instance's own callback for a client registered with that address. */
    redirectUri: process.env.CLOUDFLARE_OAUTH_REDIRECT_URI ?? RELAY_URL,
    scopes: process.env.CLOUDFLARE_OAUTH_SCOPES?.split(/[\s,]+/).filter(Boolean) ?? SCOPES,
  };
}

export type OauthState = {
  p: "cf-oauth";
  userId: string;
  organizationId: string;
  /** Reconnect this account instead of adding one. */
  accountId: string | null;
  verifier: string;
  /** The instance's callback, which the relay page forwards to. */
  callback: string;
  exp: number;
};

/** The Cloudflare consent page for a new sign-in, and where to send the browser first. */
export function startOauth(input: { userId: string; organizationId: string; accountId: string | null; callback: string }) {
  const config = oauthConfig();
  if (!config) throw new Error("Connect with Cloudflare is not set up on this instance. Paste an API token instead.");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  // Encrypted, not only signed: it carries the verifier past the relay page.
  const state = encrypt(JSON.stringify({ p: "cf-oauth", ...input, verifier, exp: Date.now() + STATE_TTL_MS } satisfies OauthState));
  const auth = new URL(AUTHORIZE_URL);
  auth.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  if (config.redirectUri !== RELAY_URL) return auth.toString();
  // The relay remembers, in this browser, where to return this state, then goes on to Cloudflare.
  const relay = new URL(RELAY_URL);
  relay.searchParams.set("return", input.callback);
  relay.searchParams.set("auth", auth.toString());
  return relay.toString();
}

export function readOauthState(raw: string | null): OauthState | null {
  if (!raw) return null;
  try {
    const state = JSON.parse(decrypt(raw)) as OauthState;
    return state.p === "cf-oauth" && state.exp > Date.now() ? state : null;
  } catch {
    return null;
  }
}

type TokenAnswer = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };

export class OauthGrantError extends Error {}

async function tokenRequest(params: Record<string, string>): Promise<TokenAnswer> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => null)) as (TokenAnswer & { error?: string; error_description?: string }) | null;
  if (!res.ok || !json?.access_token) {
    const reason = json?.error_description || json?.error || `HTTP ${res.status}`;
    // The grant is gone (revoked, expired or already used): only a new sign-in helps.
    if (json?.error === "invalid_grant") throw new OauthGrantError(reason);
    throw new Error(`Cloudflare did not issue a token: ${reason}`);
  }
  return json;
}

export async function exchangeCode(code: string, verifier: string) {
  const config = oauthConfig();
  if (!config) throw new Error("Connect with Cloudflare is not set up on this instance.");
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: verifier });
}

/** The columns to store for a token answer. */
export function tokenColumns(t: TokenAnswer) {
  return {
    apiToken: encrypt(t.access_token),
    ...(t.refresh_token ? { refreshToken: encrypt(t.refresh_token) } : {}),
    tokenExpiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
  };
}

type AccountRow = typeof schema.cloudflareAccount.$inferSelect;

function fresh(row: AccountRow) {
  return !row.tokenExpiresAt || row.tokenExpiresAt.getTime() - Date.now() > RENEW_BEFORE_MS;
}

/**
 * A working token for an account. A pasted token is used as it is. An OAuth token is renewed when it
 * is close to expiry, under a lock: Cloudflare replaces the refresh token on each use, so two
 * processes renewing at once would lose the account.
 */
export async function accountToken(row: AccountRow): Promise<string> {
  if (row.authType !== "oauth" || fresh(row)) return decrypt(row.apiToken);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cf-oauth:${row.id}`}))`);
    const [current] = await tx.select().from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.id, row.id));
    if (!current) throw new Error("Cloudflare account not found.");
    if (fresh(current)) return decrypt(current.apiToken);
    const config = oauthConfig();
    if (!config || !current.refreshToken) throw new Error(`Cloudflare access for ${current.name} has expired. Reconnect it on the Cloudflare page.`);
    let answer: TokenAnswer;
    try {
      answer = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(current.refreshToken), client_id: config.clientId });
    } catch (e) {
      if (e instanceof OauthGrantError) throw new Error(`Cloudflare access for ${current.name} was removed or has expired. Reconnect it on the Cloudflare page.`);
      throw e;
    }
    await tx.update(schema.cloudflareAccount).set(tokenColumns(answer)).where(eq(schema.cloudflareAccount.id, row.id));
    return answer.access_token;
  });
}

/** Revoke an OAuth grant on disconnect. Best effort: the account is removed either way. */
export async function revokeOauth(row: AccountRow) {
  const config = oauthConfig();
  if (row.authType !== "oauth" || !config || !row.refreshToken) return;
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: decrypt(row.refreshToken), token_type_hint: "refresh_token", client_id: config.clientId }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}
