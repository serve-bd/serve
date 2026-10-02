import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, encrypt } from "@/server/crypto";
import { env } from "@/server/env";
import { getSettings } from "@/server/settings";
import type { RemoteRepo } from "./providers";

const API = "https://api.github.com";

/** Stored (encrypted) as the secret of a `github-app` git credential. */
export type GithubAppSecret = {
  appId: number;
  slug: string;
  htmlUrl: string;
  pem: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  installationId: number | null;
  /** Account the app is installed on. */
  account: string | null;
};

type Credential = typeof schema.gitCredential.$inferSelect;

export function readAppSecret(cred: Credential): GithubAppSecret {
  return JSON.parse(decrypt(cred.secret)) as GithubAppSecret;
}

export async function writeAppSecret(credentialId: string, secret: GithubAppSecret) {
  await db
    .update(schema.gitCredential)
    .set({ secret: encrypt(JSON.stringify(secret)) })
    .where(eq(schema.gitCredential.id, credentialId));
}

/** Public base URL GitHub redirects and delivers webhooks to. */
export async function publicBaseUrl() {
  const settings = await getSettings();
  if (settings.dashboardDomain) return `${settings.dashboardHttps || settings.dashboardTunnelId ? "https" : "http"}://${settings.dashboardDomain}`;
  return env.appUrl.replace(/\/$/, "");
}

/* -------------------------------------------------------------------------- */
/*                                Signed state                                */
/* -------------------------------------------------------------------------- */

export type AppState = {
  credentialId: string;
  organizationId: string;
  userId: string;
  /** GitHub organization the app should belong to; unset for a personal account. */
  owner?: string;
  exp: number;
};

function stateKey() {
  return crypto.createHash("sha256").update(`github-app:${env.authSecret}`).digest();
}

/** HMAC-signed state for the GitHub redirects, valid for one hour. */
export function signState(state: Omit<AppState, "exp">) {
  const payload = Buffer.from(JSON.stringify({ ...state, exp: Date.now() + 3600_000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", stateKey()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(token: string | null): AppState | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", stateKey()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AppState;
    return state.exp > Date.now() ? state : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Manifest                                  */
/* -------------------------------------------------------------------------- */

export async function buildManifest(credentialId: string) {
  const base = await publicBaseUrl();
  const settings = await getSettings();
  const host = new URL(base).hostname.replace(/[^a-z0-9-]/gi, "-").slice(0, 24);
  return {
    // A white-labelled instance names the app after itself.
    name: (settings.instanceName && settings.instanceName !== "Serve" ? `${settings.instanceName} ${credentialId.slice(0, 4)}` : `Serve ${host} ${credentialId.slice(0, 4)}`).slice(
      0,
      34,
    ),
    url: base,
    hook_attributes: { url: `${base}/api/webhooks/github/${credentialId}`, active: true },
    redirect_url: `${base}/api/github/manifest`,
    callback_urls: [`${base}/api/github/setup`],
    setup_url: `${base}/api/github/setup`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: "read", metadata: "read", pull_requests: "write", statuses: "write" },
    default_events: ["push", "pull_request"],
  };
}

/** Exchange the one-time manifest code for the app's credentials. */
export async function convertManifest(code: string) {
  const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub rejected the app setup (HTTP ${res.status}). Start again from the dashboard.`);
  return (await res.json()) as {
    id: number;
    slug: string;
    html_url: string;
    pem: string;
    webhook_secret: string;
    client_id: string;
    client_secret: string;
    owner?: { login?: string };
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Tokens                                   */
/* -------------------------------------------------------------------------- */

/** JWT (RS256) that authenticates as the app itself, valid for 9 minutes. */
export function appJwt(appId: number, pem: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) })).toString("base64url");
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).sign(pem, "base64url");
  return `${header}.${payload}.${signature}`;
}

async function githubJson<T>(url: string, token: string, init: RequestInit = {}, scheme = "Bearer"): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { accept: "application/vnd.github+json", authorization: `${scheme} ${token}`, "x-github-api-version": "2022-11-28", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(`GitHub: ${body.message ?? `HTTP ${res.status}`}`);
  }
  return (await res.json()) as T;
}

export async function getInstallation(secret: GithubAppSecret, installationId: number) {
  return githubJson<{ id: number; account: { login: string; type: string } }>(`${API}/app/installations/${installationId}`, appJwt(secret.appId, secret.pem));
}

/**
 * Whether an installation GitHub reported without Serve's signed state may be stored for this app:
 * the installation it already has, or one on the account it is installed on (or was created on).
 * Anyone can install an app made public in GitHub, and a link with their installation id must not
 * point the organization's connection at their account.
 */
export function unsignedInstallationAllowed(secret: GithubAppSecret, installation: { id: number; account: { login: string } }) {
  if (secret.installationId === installation.id) return true;
  return !!secret.account && secret.account.toLowerCase() === installation.account.login.toLowerCase();
}

const tokenCache = new Map<string, { token: string; expires: number }>();

/** Installation access token (1 hour), cached until 5 minutes before expiry. */
export async function installationToken(cred: Credential): Promise<string> {
  const cached = tokenCache.get(cred.id);
  if (cached && cached.expires - Date.now() > 5 * 60_000) return cached.token;
  const secret = readAppSecret(cred);
  if (!secret.installationId) throw new Error("The GitHub App is not installed yet. Finish the installation from the Git providers page.");
  let res: { token: string; expires_at: string };
  try {
    res = await githubJson<{ token: string; expires_at: string }>(`${API}/app/installations/${secret.installationId}/access_tokens`, appJwt(secret.appId, secret.pem), {
      method: "POST",
    });
  } catch (error) {
    const message = (error as Error).message;
    if (/Integration not found|Bad credentials|A JSON web token/i.test(message)) {
      throw new Error(`GitHub no longer accepts the "${secret.slug}" app. It may have been deleted on GitHub. Reconnect GitHub in Git providers.`);
    }
    if (/Not Found/i.test(message)) {
      throw new Error(`The "${secret.slug}" GitHub App is no longer installed. Install it again from Git providers.`);
    }
    throw error;
  }
  tokenCache.set(cred.id, { token: res.token, expires: new Date(res.expires_at).getTime() });
  return res.token;
}

export async function listAppRepositories(cred: Credential): Promise<RemoteRepo[]> {
  const token = await installationToken(cred);
  const out: RemoteRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await githubJson<{
      total_count: number;
      repositories: { full_name: string; clone_url: string; default_branch: string; private: boolean; pushed_at: string | null; description: string | null }[];
    }>(`${API}/installation/repositories?per_page=100&page=${page}`, token);
    out.push(
      ...res.repositories.map((r) => ({
        fullName: r.full_name,
        cloneUrl: r.clone_url,
        defaultBranch: r.default_branch,
        private: r.private,
        updatedAt: r.pushed_at,
        description: r.description,
      })),
    );
    if (out.length >= res.total_count || res.repositories.length < 100) break;
  }
  return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** "owner/repo" for any GitHub URL form, lowercased. */
export function repoFullName(url: string) {
  return url
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Invalidate the cached token (after uninstall or permission changes). */
export function forgetToken(credentialId: string) {
  tokenCache.delete(credentialId);
}

/** Whether GitHub could reach a dashboard address at all (not localhost or a private network). */
function reachableFromGithub(base: string) {
  const host = new URL(base).hostname.replace(/^\[|\]$/g, "");
  return !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i.test(host) && !host.endsWith(".local");
}

/**
 * Points each GitHub App's webhook at the dashboard's current address. The address is fixed when an
 * app is created, so after the dashboard domain changes GitHub would keep sending pushes to the old
 * one and nothing deploys on push. Returns the apps that were changed.
 */
export async function syncAppWebhooks() {
  const base = await publicBaseUrl();
  if (!reachableFromGithub(base)) return [];
  const apps = await db.select().from(schema.gitCredential).where(eq(schema.gitCredential.provider, "github-app"));
  const changed: string[] = [];
  for (const cred of apps) {
    try {
      const secret = readAppSecret(cred);
      const jwt = appJwt(secret.appId, secret.pem);
      const url = `${base}/api/webhooks/github/${cred.id}`;
      const config = await githubJson<{ url?: string }>(`${API}/app/hook/config`, jwt);
      if (config.url === url) continue;
      await githubJson(`${API}/app/hook/config`, jwt, { method: "PATCH", body: JSON.stringify({ url, content_type: "json" }) });
      changed.push(cred.name);
    } catch (e) {
      console.warn(`Could not update the webhook of ${cred.name}:`, (e as Error).message);
    }
  }
  return changed;
}
