import { describe, expect, it } from "vitest";
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

  it("changes the instance key when credentials change, not when sign-up rules do", () => {
    const a: SignInSettings = { passwordEnabled: true, providers: { github: provider() } };
    const b: SignInSettings = { passwordEnabled: true, providers: { github: provider({ allowSignUp: false, allowedDomains: ["x.io"] }) } };
    const c: SignInSettings = { passwordEnabled: true, providers: { github: provider({ clientSecret: "enc:other" }) } };
    expect(configHash(a)).toBe(configHash(b));
    expect(configHash(a)).not.toBe(configHash(c));
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
