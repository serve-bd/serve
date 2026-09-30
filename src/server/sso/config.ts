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
  /** Only emails from these domains may sign in, sign up or link (empty: any). */
  allowedDomains: string[];
  /** GitHub only: only active members of these GitHub organizations may sign in, and they may sign up. */
  allowedOrgs?: string[];
  /** GitHub only: per GitHub organization, the organization and role its members get. */
  githubOrgs?: GithubOrgRule[];
  /** New accounts join this organization with `defaultRole`; null: no organization until invited. */
  defaultOrganizationId: string | null;
  defaultRole: SsoRole;
  /** Role for new members when `defaultRole` is member: developer, viewer or a custom role id. */
  defaultRoleId?: string | null;
  /** OpenID Connect only. */
  issuer?: string;
  scopes?: string[];
  /** Button text, like "Sign in with Acme". */
  label?: string;
};

/** Members of a GitHub organization join `organizationId` (if set) with this role. */
export type GithubOrgRule = { org: string; organizationId: string | null; role: SsoRole; roleId: string | null };

/** The GitHub organization rules, also for settings saved before rules had their own organization. */
export function githubRules(p: Pick<SsoProvider, "allowedOrgs" | "githubOrgs" | "defaultOrganizationId" | "defaultRole" | "defaultRoleId">): GithubOrgRule[] {
  if (p.githubOrgs?.length) return p.githubOrgs;
  return (p.allowedOrgs ?? []).map((org) => ({ org, organizationId: p.defaultOrganizationId, role: p.defaultRole, roleId: p.defaultRoleId ?? null }));
}

export type SignInSettings = {
  /** Email and password sign-in. Can only be turned off while a provider works for an admin. */
  passwordEnabled: boolean;
  providers: Partial<Record<SsoProviderId, SsoProvider>>;
  /** The issuer (normalized) that the company login accounts were linked with. Kept when the provider is removed. */
  oidcLinkedIssuer?: string;
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

/** Whether an email may sign in through a provider with this domain list (empty allows any; subdomains count). */
export function emailDomainAllowed(allowedDomains: string[], email: string) {
  if (!allowedDomains.length) return true;
  const domain = emailDomain(email);
  return allowedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Whether a new account with this email may be created through the provider. Members of an
 * allowed GitHub organization may sign up (membership was checked when the profile was read).
 */
export function signUpAllowed(provider: Pick<SsoProvider, "allowSignUp" | "allowedDomains" | "allowedOrgs">, email: string) {
  return (provider.allowSignUp || !!provider.allowedOrgs?.length) && emailDomainAllowed(provider.allowedDomains, email);
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
/** An issuer as it is compared: the same address however it was typed (trailing slash, discovery path). */
export function normalizeIssuer(issuer: string) {
  return issuer
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/\.well-known\/openid-configuration$/, "")
    .replace(/\/+$/, "");
}

export function discoveryUrl(issuer: string) {
  const base = issuer.trim().replace(/\/$/, "");
  return base.endsWith("/.well-known/openid-configuration") ? base : `${base}/.well-known/openid-configuration`;
}

/** Stable fingerprint of the parts that change the auth instance (ids, secrets, issuer, scopes, enabled). */
export function configHash(settings: SignInSettings) {
  return JSON.stringify(
    activeProviders(settings).map((id) => {
      const p = settings.providers[id]!;
      // Everything baked into the provider setup: a change must rebuild it.
      return [id, p.clientId, p.clientSecret, p.issuer ?? "", (p.scopes ?? []).join(" "), p.allowSignUp, p.allowedDomains.join(","), (p.allowedOrgs ?? []).join(",")];
    }),
  );
}

const domain = z
  .string()
  .trim()
  .toLowerCase()
  // Accept the ways people write it: *@example.com, @example.com, *.example.com.
  .transform((d) => d.replace(/^\*?@/, "").replace(/^\*\./, ""))
  .pipe(z.string().regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter domains like example.com"));

const githubOrgName = z
  .string()
  .trim()
  .toLowerCase()
  .transform((o) =>
    o
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/^@/, "")
      .replace(/\/$/, ""),
  )
  .pipe(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})$/, "Enter GitHub organization names like acme"));

export const providerInput = z
  .object({
    enabled: z.boolean(),
    clientId: z.string().trim().min(1, "Enter the client ID").max(300),
    /** Empty keeps the saved secret. */
    clientSecret: z.string().trim().max(1000).optional(),
    allowSignUp: z.boolean(),
    allowedDomains: z.array(domain).max(50).default([]),
    allowedOrgs: z.array(githubOrgName).max(20).default([]),
    githubOrgs: z
      .array(
        z.object({
          org: githubOrgName,
          organizationId: z.string().trim().min(1).nullable().default(null),
          role: z.enum(["member", "admin"]).default("member"),
          roleId: z.string().trim().min(1).max(64).nullable().default(null),
        }),
      )
      .max(20)
      .optional(),
    defaultOrganizationId: z.string().trim().min(1).nullable().default(null),
    defaultRole: z.enum(["member", "admin"]).default("member"),
    defaultRoleId: z.string().trim().min(1).max(64).nullable().default(null),
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
