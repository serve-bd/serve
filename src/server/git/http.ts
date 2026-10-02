import { getSetting } from "@/server/settings";

export type GitHttpResponse = { status: number; ok: boolean; header: (name: string) => string | null; text: string };

/**
 * One request to a git provider's API. Hosted providers (github.com, gitlab.com…) are fetched
 * as usual. A self-hosted server never redirects Serve elsewhere, and for organizations other
 * than Root it is reached only on a public address, checked on the connection itself (its
 * DNS can change after it was added).
 */
export async function gitHttp(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
  target: { selfHosted: boolean; organizationId: string | null | undefined },
): Promise<GitHttpResponse> {
  const timeoutMs = init.timeoutMs ?? 15_000;
  const root = target.selfHosted && !!target.organizationId && target.organizationId === (await getSetting("rootOrganizationId"));
  if (target.selfHosted && !root) {
    const { publicRequest } = await import("@/server/net/public-fetch");
    const res = await publicRequest(url, { method: init.method ?? "GET", headers: init.headers, body: init.body, timeoutMs, maxBytes: 16 * 1024 * 1024 });
    const value = (name: string) => {
      const v = res.headers[name.toLowerCase()];
      return v === undefined ? null : Array.isArray(v) ? v.join(", ") : v;
    };
    return { status: res.status, ok: res.status >= 200 && res.status < 300, header: value, text: res.text };
  }
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    redirect: target.selfHosted ? "error" : "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, ok: res.ok, header: (name) => res.headers.get(name), text: await res.text() };
}
