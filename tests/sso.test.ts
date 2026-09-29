import { describe, expect, it, vi } from "vitest";
import { ssoErrorMessage } from "@/lib/sso-errors";
import {
  activeProviders,
  buttonLabel,
  callbackUrl,
  configHash,
  discoveryUrl,
  providerIdOf,
  providerInput,
  redact,
  type SignInSettings,
  type SsoProvider,
  signUpAllowed,
} from "@/server/sso/config";

const provider = (patch: Partial<SsoProvider> = {}): SsoProvider => ({
  enabled: true,
  clientId: "id",
  clientSecret: "enc:secret",
  allowSignUp: true,
  allowedDomains: [],
  defaultOrganizationId: null,
  defaultRole: "member",
  ...patch,
});

describe("sso config", () => {
  it("finds the provider of an OAuth callback only", () => {
    expect(providerIdOf("/callback/github", { id: "github" })).toBe("github");
    expect(providerIdOf("/callback/oidc", { id: "oidc" })).toBe("oidc");
    expect(providerIdOf("/callback/twitter", { id: "twitter" })).toBeNull();
    expect(providerIdOf("/sign-up/email", {})).toBeNull();
    expect(providerIdOf(undefined, undefined)).toBeNull();
  });

  it("builds callback and discovery URLs", () => {
    expect(callbackUrl("https://serve.example.com/", "google")).toBe("https://serve.example.com/api/auth/callback/google");
    expect(discoveryUrl("https://login.example.com/")).toBe("https://login.example.com/.well-known/openid-configuration");
    expect(discoveryUrl("https://login.example.com/.well-known/openid-configuration")).toBe("https://login.example.com/.well-known/openid-configuration");
  });

  it("limits new accounts to allowed domains and subdomains", () => {
    expect(signUpAllowed(provider({ allowSignUp: false }), "a@example.com")).toBe(false);
    expect(signUpAllowed(provider(), "a@anything.io")).toBe(true);
    const only = provider({ allowedDomains: ["example.com"] });
    expect(signUpAllowed(only, "A@Example.com")).toBe(true);
    expect(signUpAllowed(only, "a@eu.example.com")).toBe(true);
    expect(signUpAllowed(only, "a@badexample.com")).toBe(false);
    expect(signUpAllowed(only, "a@example.com.evil.io")).toBe(false);
  });

  it("offers only complete, enabled providers", () => {
    const settings: SignInSettings = {
      passwordEnabled: true,
      providers: { github: provider(), google: provider({ enabled: false }), oidc: provider({ issuer: undefined }) },
    };
    expect(activeProviders(settings)).toEqual(["github"]);
    settings.providers.oidc = provider({ issuer: "https://login.example.com" });
    expect(activeProviders(settings)).toEqual(["github", "oidc"]);
  });

  it("changes the instance key when credentials or the rules baked into providers change", () => {
    const a: SignInSettings = { passwordEnabled: true, providers: { github: provider() } };
    const b: SignInSettings = { passwordEnabled: true, providers: { github: provider({ allowSignUp: false, allowedDomains: ["x.io"] }) } };
    const c: SignInSettings = { passwordEnabled: true, providers: { github: provider({ clientSecret: "enc:other" }) } };
    const d: SignInSettings = { passwordEnabled: true, providers: { github: provider({ allowedOrgs: ["acme"] }) } };
    // Sign-up, domains and organizations are part of the provider setup better-auth builds once.
    expect(configHash(a)).not.toBe(configHash(b));
    expect(configHash(a)).not.toBe(configHash(c));
    expect(configHash(a)).not.toBe(configHash(d));
    expect(configHash(a)).toBe(configHash({ passwordEnabled: false, providers: { github: provider() } }));
  });

  it("never exposes the secret", () => {
    const view = redact(provider());
    expect(view).not.toHaveProperty("clientSecret");
    expect(view.hasSecret).toBe(true);
  });

  it("validates provider input", () => {
    expect(providerInput.safeParse({ enabled: true, clientId: "x", allowSignUp: false }).success).toBe(true);
    expect(providerInput.safeParse({ enabled: true, clientId: "", allowSignUp: false }).success).toBe(false);
    expect(providerInput.safeParse({ enabled: true, clientId: "x", allowSignUp: true, allowedDomains: ["not a domain"] }).success).toBe(false);
    expect(providerInput.safeParse({ enabled: true, clientId: "x", allowSignUp: false, issuer: "http://login.example.com" }).success).toBe(false);
    expect(providerInput.safeParse({ enabled: true, clientId: "x", allowSignUp: false, issuer: "https://login.example.com" }).success).toBe(true);
  });

  it("labels buttons", () => {
    expect(buttonLabel("github", provider())).toBe("Continue with GitHub");
    expect(buttonLabel("oidc", provider({ label: "Sign in with Acme" }))).toBe("Sign in with Acme");
    expect(buttonLabel("oidc", undefined)).toBe("Sign in with SSO");
  });

  it("explains callback errors", () => {
    expect(ssoErrorMessage("signup_disabled")).toMatch(/invite/);
    expect(ssoErrorMessage("account_not_linked")).toMatch(/link it/);
    expect(ssoErrorMessage("whatever")).toMatch(/try again/);
  });
});

describe("allowed email domains", () => {
  it("accepts *@, @ and *. forms and counts subdomains", async () => {
    const { providerInput, emailDomainAllowed } = await import("@/server/sso/config");
    const parsed = providerInput.safeParse({ enabled: true, clientId: "id", allowSignUp: false, allowedDomains: ["*@Acme.com", "@corp.io", "*.team.dev"] });
    expect(parsed.success && parsed.data.allowedDomains).toEqual(["acme.com", "corp.io", "team.dev"]);
    expect(emailDomainAllowed(["acme.com"], "a@eu.acme.com")).toBe(true);
    expect(emailDomainAllowed(["acme.com"], "a@notacme.com")).toBe(false);
    expect(emailDomainAllowed([], "a@x.com")).toBe(true);
  });

  it("blanks a disallowed email and reports it with its own error code", async () => {
    const { guardProfileEmail, withSignInGuard, signInRefused } = await import("@/server/sso/domain-guard");
    const guard = guardProfileEmail(["acme.com"]);
    let seen = false;
    const res = await withSignInGuard(async () => {
      expect(guard({ email: "me@acme.com" })).toEqual({});
      expect(guard({ email: "me@gmail.com" })).toEqual({ email: "" });
      seen = signInRefused();
      return new Response(null, { status: 302, headers: { location: "/login?error=email_not_found" } });
    });
    expect(seen).toBe(true);
    expect(res.headers.get("location")).toBe("/login?error=email_domain_not_allowed");
  });

  it("leaves other requests alone", async () => {
    const { withSignInGuard } = await import("@/server/sso/domain-guard");
    const res = await withSignInGuard(async () => new Response(null, { status: 302, headers: { location: "/login?error=state_mismatch" } }));
    expect(res.headers.get("location")).toBe("/login?error=state_mismatch");
  });
});

describe("GitHub organization rule", () => {
  const github = (member: boolean) =>
    vi.fn(async (url: string) => {
      if (url.endsWith("/user")) return Response.json({ id: 7, login: "sam", name: "Sam", email: null, avatar_url: "https://x/a.png" });
      if (url.endsWith("/user/emails")) return Response.json([{ email: "sam@gmail.com", primary: true, verified: true }]);
      if (url.includes("/public_members/")) return new Response(null, { status: member ? 204 : 404 });
      if (url.includes("/user/memberships/orgs/acme"))
        return member ? Response.json({ state: "active" }) : new Response("{}", { status: 404, headers: { "x-oauth-scopes": "read:org, read:user, user:email" } });
      return new Response("{}", { status: 404 });
    });

  it("lets active members in and allows them to sign up", async () => {
    const { githubMembersOnly } = await import("@/server/sso/github-orgs");
    const { signUpAllowed } = await import("@/server/sso/config");
    vi.stubGlobal("fetch", github(true));
    const info = await githubMembersOnly(["acme"], [])({ accessToken: "t" });
    expect(info?.user).toMatchObject({ email: "sam@gmail.com", emailVerified: true, name: "Sam" });
    expect(signUpAllowed(provider({ allowSignUp: false, allowedOrgs: ["acme"] }), "sam@gmail.com")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("refuses people outside the organization with its own error", async () => {
    const { githubMembersOnly } = await import("@/server/sso/github-orgs");
    const { withSignInGuard } = await import("@/server/sso/domain-guard");
    vi.stubGlobal("fetch", github(false));
    let email: string | null | undefined;
    const res = await withSignInGuard(async () => {
      email = (await githubMembersOnly(["acme"], [])({ accessToken: "t" }))?.user.email;
      return new Response(null, { status: 302, headers: { location: "/login?error=email_not_found" } });
    });
    expect(email).toBe("");
    expect(res.headers.get("location")).toBe("/login?error=github_org_not_allowed");
    vi.unstubAllGlobals();
  });

  it("accepts organization URLs and @names", () => {
    const parsed = providerInput.safeParse({ enabled: true, clientId: "id", allowSignUp: false, allowedOrgs: ["https://github.com/Acme/", "@team-x"] });
    expect(parsed.success && parsed.data.allowedOrgs).toEqual(["acme", "team-x"]);
  });
});
