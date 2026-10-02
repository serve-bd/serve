import { emailDomainAllowed } from "./config";
import { refuse, rememberGithubOrgs } from "./domain-guard";

type Token = { accessToken?: string };
type GithubUser = { id: number; login: string; name: string | null; email: string | null; avatar_url: string };
type GithubEmail = { email: string; primary: boolean; verified: boolean };

const api = (path: string, token: string) =>
  fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "serve" },
    signal: AbortSignal.timeout(10_000),
  });

/** Public membership needs no token and no approval, so it still works when the organization restricts apps. */
export async function isPublicMember(org: string, login: string) {
  const res = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/public_members/${encodeURIComponent(login)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "serve" },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  return res.status === 204;
}

export type MembershipResult = "member" | "not-member" | "restricted" | "no-scope";

/** The token's user membership in an organization, and why it could not be seen (needs read:org). */
export async function membership(org: string, token: string): Promise<MembershipResult> {
  const res = await api(`/user/memberships/orgs/${encodeURIComponent(org)}`, token);
  const scopes = (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim());
  if (res.ok) return ((await res.json()) as { state?: string }).state === "active" ? "member" : "not-member";
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  console.warn(`[sign-in] GitHub membership check for ${org}: HTTP ${res.status} ${body.message ?? ""} (scopes: ${scopes.join(" ") || "none"})`);
  if (!scopes.includes("read:org") && !scopes.includes("admin:org") && !scopes.includes("write:org")) return "no-scope";
  if (res.status === 403 && /restrict/i.test(body.message ?? "")) return "restricted";
  return "not-member";
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
    // A verified address first: the domain rule below is only worth something for one.
    const verified = emails.filter((e) => e.verified);
    const email = profile.email ?? (verified.find((e) => e.primary) ?? verified[0] ?? emails.find((e) => e.primary) ?? emails[0])?.email ?? null;
    const emailVerified = emails.find((e) => e.email === email)?.verified ?? false;
    let allowed = true;
    if (!email || !emailDomainAllowed(allowedDomains, email) || (allowedDomains.length && !emailVerified)) {
      refuse("email_domain_not_allowed");
      allowed = false;
    } else {
      const results = await Promise.all(
        allowedOrgs.map(async (org) => {
          const r = await membership(org, token.accessToken!).catch(() => "not-member" as const);
          if (r === "member") return r;
          // Private memberships can be hidden (app restrictions, missing scope): a public member still counts.
          return (await isPublicMember(org, profile.login).catch(() => false)) ? "member" : r;
        }),
      );
      rememberGithubOrgs(allowedOrgs.filter((_, i) => results[i] === "member"));
      if (!results.includes("member")) {
        // The most useful reason: a fixable setup problem beats "not a member".
        refuse(results.includes("restricted") ? "github_org_restricted" : results.includes("no-scope") ? "github_org_no_scope" : "github_org_not_allowed");
        allowed = false;
      }
    }
    return {
      user: { id: profile.id, name: profile.name || profile.login || "", email: allowed ? email : "", image: profile.avatar_url, emailVerified },
      data: profile as unknown as Record<string, unknown>,
    };
  };
}
