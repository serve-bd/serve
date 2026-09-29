import { emailDomainAllowed } from "./config";
import { refuse } from "./domain-guard";

type Token = { accessToken?: string };
type GithubUser = { id: number; login: string; name: string | null; email: string | null; avatar_url: string };
type GithubEmail = { email: string; primary: boolean; verified: boolean };

const api = (path: string, token: string) =>
  fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "serve" },
    signal: AbortSignal.timeout(10_000),
  });

/** Whether the token's user is an active member of the organization (needs the read:org scope). */
export async function isActiveMember(org: string, token: string) {
  const res = await api(`/user/memberships/orgs/${encodeURIComponent(org)}`, token);
  if (!res.ok) return false;
  return ((await res.json()) as { state?: string }).state === "active";
}

/**
 * GitHub profile reader that only lets in active members of the allowed organizations, checked
 * on every sign-in and link. Same user fields as better-auth's own GitHub provider.
 */
export function githubMembersOnly(allowedOrgs: string[], allowedDomains: string[]) {
  return async (token: Token) => {
    if (!token.accessToken) return null;
    const userRes = await api("/user", token.accessToken);
    if (!userRes.ok) return null;
    const profile = (await userRes.json()) as GithubUser;
    const emails = await api("/user/emails", token.accessToken)
      .then((r) => (r.ok ? (r.json() as Promise<GithubEmail[]>) : []))
      .catch(() => [] as GithubEmail[]);
    const email = profile.email ?? (emails.find((e) => e.primary) ?? emails[0])?.email ?? null;
    const emailVerified = emails.find((e) => e.email === email)?.verified ?? false;
    let allowed = true;
    if (!email || !emailDomainAllowed(allowedDomains, email)) {
      refuse("email_domain_not_allowed");
      allowed = false;
    } else {
      const member = await Promise.all(allowedOrgs.map((org) => isActiveMember(org, token.accessToken!).catch(() => false)));
      if (!member.some(Boolean)) {
        refuse("github_org_not_allowed");
        allowed = false;
      }
    }
    return {
      user: { id: profile.id, name: profile.name || profile.login || "", email: allowed ? email : "", image: profile.avatar_url, emailVerified },
      data: profile as unknown as Record<string, unknown>,
    };
  };
}
