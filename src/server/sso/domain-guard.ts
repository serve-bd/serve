import { AsyncLocalStorage } from "node:async_hooks";
import { emailDomainAllowed } from "./config";

/** Per auth request: set when a provider returned an email outside its allowed domains. */
const blocked = new AsyncLocalStorage<{ email: string | null }>();

/** Runs an auth request so a blocked email can be reported with its own error code. */
export async function withDomainGuard(run: () => Promise<Response>) {
  const state = { email: null as string | null };
  const res = await blocked.run(state, run);
  if (!state.email) return res;
  // The callback turned the blanked email into email_not_found; say what really happened.
  const location = res.headers.get("location");
  if (!location || !/[?&]error=/.test(location)) return res;
  const url = new URL(location, "http://placeholder");
  url.searchParams.set("error", "email_domain_not_allowed");
  url.searchParams.delete("error_description");
  const next = url.origin === "http://placeholder" ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  const headers = new Headers(res.headers);
  headers.set("location", next);
  return new Response(res.body, { status: res.status, headers });
}

/** Whether this auth request hit an email outside the allowed domains. */
export function domainBlocked() {
  return !!blocked.getStore()?.email;
}

/**
 * For a provider's mapProfileToUser: blanks the email when its domain is not allowed, which
 * makes better-auth refuse the sign-in (and a link from the Account page) before any account
 * is found, created or linked.
 */
export function guardProfileEmail(allowedDomains: string[]) {
  return (profile: { email?: string | null }) => {
    const email = profile.email ?? "";
    if (!allowedDomains.length || (email && emailDomainAllowed(allowedDomains, email))) return {};
    const state = blocked.getStore();
    if (state) state.email = email || "(none)";
    return { email: "" };
  };
}
