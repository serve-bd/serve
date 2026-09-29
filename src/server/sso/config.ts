import { z } from "zod";

/**
 * Single sign-on for the dashboard: GitHub, Google and one OpenID Connect provider
 * (a company login). Stored in the `signIn` setting; client secrets are encrypted.
 */

export type SsoProviderId = "github" | "google" | "oidc";

export const SSO_PROVIDERS: SsoProviderId[] = ["github", "google", "oidc"];

export type SsoRole = "member" | "admin";

export type SsoProvider = {
  enabled: boolean;
  clientId: string;
  /** Encrypted. */
  clientSecret: string;
  /** Create accounts for people who have none yet. Off: only existing users can sign in. */
  allowSignUp: boolean;
  /** Only these email domains may sign up (empty: any). Existing users are never blocked by it. */
  allowedDomains: string[];
  /** New accounts join this organization with `defaultRole`; null: no organization until invited. */
  defaultOrganizationId: string | null;
  defaultRole: SsoRole;
  /** OpenID Connect only. */
  issuer?: string;
  scopes?: string[];
  /** Button text, like "Sign in with Acme". */
  label?: string;
};

export type SignInSettings = {
  /** Email and password sign-in. Can only be turned off while a provider works for an admin. */
  passwordEnabled: boolean;
  providers: Partial<Record<SsoProviderId, SsoProvider>>;
};

export const defaultSignIn: SignInSettings = { passwordEnabled: true, providers: {} };

export const providerNames: Record<SsoProviderId, string> = { github: "GitHub", google: "Google", oidc: "OpenID Connect" };

/** The provider id better-auth uses in its callback path and account rows. */
export function providerIdOf(path: string | undefined, params: Record<string, unknown> | undefined): SsoProviderId | null {
  const id = (params?.providerId ?? params?.id) as string | undefined;
  if (!path || !id) return null;
  if (!path.startsWith("/callback/")) return null;
  return (SSO_PROVIDERS as string[]).includes(id) ? (id as SsoProviderId) : null;
}

/** Callback URL to register with the provider (the OpenID Connect provider uses the same route as the others). */
export function callbackUrl(base: string, id: SsoProviderId) {
  return `${base.replace(/\/$/, "")}/api/auth/callback/${id}`;
}

export function emailDomain(email: string) {
  return email.trim().toLowerCase().split("@").pop() ?? "";
}

/** Whether a new account with this email may be created through the provider. */
export function signUpAllowed(provider: Pick<SsoProvider, "allowSignUp" | "allowedDomains">, email: string) {
  if (!provider.allowSignUp) return false;
  if (!provider.allowedDomains.length) return true;
  const domain = emailDomain(email);
  return provider.allowedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Providers the login page offers: enabled and complete. */
export function activeProviders(settings: SignInSettings) {
  return SSO_PROVIDERS.filter((id) => {
    const p = settings.providers[id];
    return !!p?.enabled && !!p.clientId && !!p.clientSecret && (id !== "oidc" || !!p.issuer);
  });
}

/** Button label on the login page. */
export function buttonLabel(id: SsoProviderId, p: SsoProvider | undefined) {
  if (id === "oidc") return p?.label?.trim() || "Sign in with SSO";
  return `Continue with ${providerNames[id]}`;
}

/** OpenID discovery document of an issuer. */
export function discoveryUrl(issuer: string) {
  const base = issuer.trim().replace(/\/$/, "");
  return base.endsWith("/.well-known/openid-configuration") ? base : `${base}/.well-known/openid-configuration`;
}

/** Stable fingerprint of the parts that change the auth instance (ids, secrets, issuer, scopes, enabled). */
export function configHash(settings: SignInSettings) {
  return JSON.stringify(
    activeProviders(settings).map((id) => {
      const p = settings.providers[id]!;
      return [id, p.clientId, p.clientSecret, p.issuer ?? "", (p.scopes ?? []).join(" ")];
    }),
  );
}

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter domains like example.com");

export const providerInput = z
  .object({
    enabled: z.boolean(),
    clientId: z.string().trim().min(1, "Enter the client ID").max(300),
    /** Empty keeps the saved secret. */
    clientSecret: z.string().trim().max(1000).optional(),
    allowSignUp: z.boolean(),
    allowedDomains: z.array(domain).max(50).default([]),
    defaultOrganizationId: z.string().trim().min(1).nullable().default(null),
    defaultRole: z.enum(["member", "admin"]).default("member"),
    issuer: z.string().trim().max(500).optional(),
    scopes: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[\w:./-]+$/, "Scopes are words like openid or email"),
      )
      .max(30)
      .optional(),
    label: z.string().trim().max(60).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.issuer !== undefined && v.issuer !== "") {
      try {
        const url = new URL(v.issuer);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
          ctx.addIssue({ code: "custom", path: ["issuer"], message: "The issuer must use https" });
        }
      } catch {
        ctx.addIssue({ code: "custom", path: ["issuer"], message: "Enter the issuer URL, like https://login.example.com" });
      }
    }
  });

export type ProviderInput = z.input<typeof providerInput>;

/** A provider as the settings page sees it: never the secret. */
export type ProviderView = Omit<SsoProvider, "clientSecret"> & { hasSecret: boolean };

export function redact(p: SsoProvider): ProviderView {
  const { clientSecret, ...rest } = p;
  return { ...rest, hasSecret: !!clientSecret };
}
