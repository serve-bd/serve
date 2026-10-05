/*
 * Bitbucket sign-in. Bitbucket speaks OAuth 2 but not OpenID Connect: the profile comes from its
 * API, and the email from the account's confirmed primary address (an unconfirmed one is never used).
 */

export const BITBUCKET = {
  authorizationUrl: "https://bitbucket.org/site/oauth2/authorize",
  tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
  scopes: ["account", "email"],
};

type BitbucketUser = { uuid?: string; account_id?: string; display_name?: string; username?: string; links?: { avatar?: { href?: string } } };
type BitbucketEmails = { values?: { email?: string; is_primary?: boolean; is_confirmed?: boolean }[] };

async function api<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.bitbucket.org/2.0${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Bitbucket answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/** The signed-in Bitbucket user, or null when Bitbucket gives no confirmed email. */
export async function bitbucketUserInfo(tokens: { accessToken?: string }) {
  if (!tokens.accessToken) return null;
  const [user, emails] = await Promise.all([api<BitbucketUser>("/user", tokens.accessToken), api<BitbucketEmails>("/user/emails", tokens.accessToken)]);
  const confirmed = (emails.values ?? []).filter((e) => e.email && e.is_confirmed);
  const email = (confirmed.find((e) => e.is_primary) ?? confirmed[0])?.email;
  // The uuid stays the same when the username or email changes.
  const id = user.uuid ?? user.account_id;
  if (!id || !email) return null;
  return { id, name: user.display_name || user.username || email, email, emailVerified: true, image: user.links?.avatar?.href };
}
