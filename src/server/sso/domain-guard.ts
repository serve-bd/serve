import { AsyncLocalStorage } from "node:async_hooks";
import { emailDomainAllowed } from "./config";

/** Per auth request: why a provider's profile was refused (an email domain, a GitHub organization). */
const refused = new AsyncLocalStorage<{ code: string | null }>();

/** Runs an auth request so a refused profile is reported with its own error code. */
export async function withSignInGuard(run: () => Promise<Response>) {
  const state = { code: null as string | null };
  const res = await refused.run(state, run);
  if (!state.code) return res;
  // The callback turned the blanked email into its own error; say what really happened.
  const location = res.headers.get("location");
  if (!location || !/[?&]error=/.test(location)) return res;
  const url = new URL(location, "http://placeholder");
  url.searchParams.set("error", state.code);
  url.searchParams.delete("error_description");
  const next = url.origin === "http://placeholder" ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  const headers = new Headers(res.headers);
  headers.set("location", next);
  return new Response(res.body, { status: res.status, headers });
}

/** Marks this auth request as refused; the caller blanks the email so better-auth stops. */
export function refuse(code: string) {
  const state = refused.getStore();
  if (state && !state.code) state.code = code;
}

/** Whether this auth request refused the provider's profile. */
export function signInRefused() {
  return !!refused.getStore()?.code;
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
    refuse("email_domain_not_allowed");
    return { email: "" };
  };
}
