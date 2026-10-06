import { publicBaseUrl } from "@/server/git/github-app";

/** Where visitors open a page: its own domain, or /status/<slug> on the dashboard's. */
export async function pageUrl(page: { slug: string; domain: string | null; https: boolean }) {
  if (page.domain) return `${page.https ? "https" : "http"}://${page.domain}`;
  return `${await publicBaseUrl()}/status/${page.slug}`;
}
