import { afterEach, describe, expect, it, vi } from "vitest";
import { activeProviders, buttonLabel, displayName, microsoftSingleTenant, normalizeGitlab, providerEmailsTrusted, providerInput, type SsoProvider } from "@/server/sso/config";
import { bitbucketUserInfo } from "@/server/sso/bitbucket";

const base: SsoProvider = { enabled: true, clientId: "id", clientSecret: "s", allowSignUp: false, allowedDomains: [], defaultOrganizationId: null, defaultRole: "member" };

describe("Microsoft sign-in trusts emails only from one named organization", () => {
  it("tells one organization from Microsoft's shared endpoints", () => {
    expect(microsoftSingleTenant("1b2c3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e")).toBe(true);
    expect(microsoftSingleTenant("contoso.onmicrosoft.com")).toBe(true);
    for (const t of [undefined, "", "common", "organizations", "Consumers"]) expect(microsoftSingleTenant(t)).toBe(false);
  });

  it("other providers' emails count as they are", () => {
    expect(providerEmailsTrusted("microsoft", {})).toBe(false);
    expect(providerEmailsTrusted("microsoft", { tenantId: "common" })).toBe(false);
    expect(providerEmailsTrusted("microsoft", { tenantId: "contoso.com" })).toBe(true);
    expect(providerEmailsTrusted("gitlab", {})).toBe(true);
  });

  it("accepts a tenant ID, a domain or a shared endpoint, nothing else", () => {
    const ok = (tenantId: string) => providerInput.safeParse({ enabled: true, clientId: "x", allowSignUp: false, tenantId }).success;
    expect(ok("1b2c3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e")).toBe(true);
    expect(ok("contoso.onmicrosoft.com")).toBe(true);
    expect(ok("organizations")).toBe(true);
    expect(ok("")).toBe(true);
    expect(ok("https://login.microsoftonline.com/x")).toBe(false);
    expect(ok("../../evil")).toBe(false);
  });
});

describe("GitLab servers", () => {
  it("compares addresses however they were typed, gitlab.com when empty", () => {
    expect(normalizeGitlab(undefined)).toBe("https://gitlab.com");
    expect(normalizeGitlab("  ")).toBe("https://gitlab.com");
    expect(normalizeGitlab("https://GitLab.example.com/")).toBe("https://gitlab.example.com");
  });

  it("refuses a plain http server", () => {
    expect(providerInput.safeParse({ enabled: true, clientId: "x", allowSignUp: false, issuer: "http://gitlab.example.com" }).success).toBe(false);
  });
});

describe("names on buttons and lists", () => {
  it("names the company login after its preset unless it has its own label", () => {
    expect(displayName("oidc", { ...base, preset: "keycloak" })).toBe("Keycloak");
    expect(displayName("oidc", { ...base, preset: "keycloak", label: "Acme login" })).toBe("Acme login");
    expect(buttonLabel("oidc", { ...base, preset: "authentik" })).toBe("Continue with Authentik");
    expect(buttonLabel("oidc", { ...base })).toBe("Sign in with SSO");
    expect(buttonLabel("microsoft", base)).toBe("Continue with Microsoft");
  });

  it("offers the new providers once set up; the company login needs its issuer", () => {
    expect(activeProviders({ passwordEnabled: true, providers: { microsoft: base, gitlab: base, bitbucket: base, oidc: base } })).toEqual(["microsoft", "gitlab", "bitbucket"]);
  });
});

describe("Bitbucket profile", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (emails: { email: string; is_primary: boolean; is_confirmed: boolean }[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.endsWith("/user") ? { uuid: "{abc}", display_name: "Ada", links: { avatar: { href: "https://a/x.png" } } } : { values: emails };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

  it("uses the confirmed primary email and the account's uuid", async () => {
    stub([
      { email: "old@x.test", is_primary: false, is_confirmed: true },
      { email: "ada@x.test", is_primary: true, is_confirmed: true },
    ]);
    expect(await bitbucketUserInfo({ accessToken: "t" })).toEqual({ id: "{abc}", name: "Ada", email: "ada@x.test", emailVerified: true, image: "https://a/x.png" });
  });

  it("never uses an unconfirmed email: none confirmed, no sign-in", async () => {
    stub([{ email: "victim@company.test", is_primary: true, is_confirmed: false }]);
    expect(await bitbucketUserInfo({ accessToken: "t" })).toBeNull();
  });

  it("falls back to another confirmed email when the primary is not confirmed", async () => {
    stub([
      { email: "victim@company.test", is_primary: true, is_confirmed: false },
      { email: "me@mine.test", is_primary: false, is_confirmed: true },
    ]);
    expect((await bitbucketUserInfo({ accessToken: "t" }))?.email).toBe("me@mine.test");
  });
});
