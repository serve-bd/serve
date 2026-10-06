import { publicBaseUrl } from "@/server/git/github-app";

/**
 * Where visitors open a page: its own domain, or /status/<slug> on the dashboard's. Through a
 * Cloudflare Tunnel the page is plain HTTP here, but Cloudflare serves it on https.
 */
export async function pageUrl(page: { slug: string; domain: string | null; https: boolean; tunnelId?: string | null }) {
  if (page.domain) return `${page.https || page.tunnelId ? "https" : "http"}://${page.domain}`;
  return `${await publicBaseUrl()}/status/${page.slug}`;
}
