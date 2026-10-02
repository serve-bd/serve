import { preferHttps, publicBaseUrl } from "./github-app";

/** False for localhost, .local and private network hosts: a git provider on the internet cannot reach them. */
export function isPublicUrl(url: string) {
  try {
    const host = new URL(url).hostname;
    return !(host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host));
  } catch {
    return false;
  }
}

export type BaseUrl = { url: string; ok: true } | { url: string; ok: false; error: string };

/**
 * Where git providers send webhooks. SERVE_WEBHOOK_BASE_URL lets an operator point
 * providers on a private network (or a test Gitea) at an internal address.
 */
export async function webhookBaseUrl(provider: string): Promise<BaseUrl> {
  const override = process.env.SERVE_WEBHOOK_BASE_URL?.replace(/\/$/, "");
  if (override) return { url: override, ok: true };
  const url = await publicBaseUrl();
  if (isPublicUrl(url)) return { url: await preferHttps(url), ok: true };
  return { url, ok: false, error: `Set a public dashboard domain so ${provider} can reach Serve.` };
}

/** Base of OAuth redirect URIs. Local addresses only work in development with SERVE_ALLOW_LOCAL_OAUTH=1. */
export async function oauthBaseUrl(): Promise<BaseUrl> {
  const url = await publicBaseUrl();
  const allowLocal = process.env.SERVE_ALLOW_LOCAL_OAUTH === "1" && process.env.NODE_ENV !== "production";
  if (isPublicUrl(url) || allowLocal) return { url, ok: true };
  return { url, ok: false, error: "OAuth needs a public dashboard address the provider can redirect to. Set a dashboard domain in Settings → Dashboard." };
}
