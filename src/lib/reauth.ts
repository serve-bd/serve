/**
 * Confirming it is you before a sensitive account change. better-auth refuses some changes (adding
 * a passkey, unlinking a sign-in method, listing devices) once the sign-in is older than a day,
 * with the code SESSION_NOT_FRESH. The Account page then asks for the password, or a provider
 * sign-in for accounts without one, and tries again.
 */

export type ReauthMethods = {
  /** The account has a password it can confirm with. */
  password: boolean;
  /** Linked sign-in providers that are still on, to sign in with again. */
  providers: { id: string; label: string }[];
};

/**
 * How the user can confirm it is them. The password, when the account has one; with password
 * sign-in turned off, a linked provider instead (the password stays the fallback when none is
 * linked, as the session itself already proved who this is).
 */
export function reauthMethods(input: { linked: string[]; passwordSignIn: boolean; activeProviders: { id: string; label: string }[] }): ReauthMethods {
  const hasPassword = input.linked.includes("credential");
  const providers = input.activeProviders.filter((p) => input.linked.includes(p.id));
  return { password: hasPassword && (input.passwordSignIn || providers.length === 0), providers: hasPassword && input.passwordSignIn ? [] : providers };
}

type AuthError = { code?: string | null; message?: string | null; status?: number } | null | undefined;

/** better-auth's error for a change that needs a recent sign-in. */
export function needsFreshSession(error: AuthError) {
  return error?.code === "SESSION_NOT_FRESH" || error?.code === "SESSION_EXPIRED";
}

/** A sentence for an error from an account change; never better-auth's raw codes. */
export function authErrorMessage(error: AuthError, fallback: string) {
  if (!error) return fallback;
  if (needsFreshSession(error)) return "Confirm it's you to continue.";
  if (error.code === "UNAUTHORIZED" || error.status === 401) return "You were signed out. Sign in again to continue.";
  if (error.code === "TOO_MANY_REQUESTS" || error.status === 429) return error.message || "Too many tries. Wait a few minutes and try again.";
  const message = error.message?.trim();
  // A bare code or an unhelpful default reads worse than the fallback.
  if (!message || /^[A-Z_]+$/.test(message) || /session is not fresh/i.test(message)) return fallback;
  return message;
}

/** The OAuth return of a provider confirmation: back to the Account page, which resumes. */
export const REAUTH_RETURN = "/account";
export const REAUTH_ERROR_RETURN = "/account?reauth=failed";

/** A delete refused until the user signs in again (accounts without a password): the page asks, then tries again. */
export const DELETE_REAUTH = "Confirm it's you to delete this: sign in again.";
