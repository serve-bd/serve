import { z } from "zod";

/**
 * Single sign-on for the dashboard: GitHub, Google, Microsoft, GitLab, Bitbucket and one OpenID
 * Connect provider (a company login). Stored in the `signIn` setting; client secrets are encrypted.
 */

export type SsoProviderId = "github" | "google" | "microsoft" | "gitlab" | "bitbucket" | "oidc";

export const SSO_PROVIDERS: SsoProviderId[] = ["github", "google", "microsoft", "gitlab", "bitbucket", "oidc"];

/**
 * Microsoft's shared sign-in endpoints: any work or school account (organizations), any personal
 * account (consumers), or both (common). Anything else names one organization (a tenant).
 */
export const MICROSOFT_SHARED_TENANTS = ["organizations", "common", "consumers"];

/** One Microsoft organization: its tenant ID or a domain of it (contoso.onmicrosoft.com). */
export const microsoftSingleTenant = (tenantId: string | undefined) => !!tenantId && !MICROSOFT_SHARED_TENANTS.includes(tenantId.toLowerCase());

/**
 * Whether an email from this provider can be trusted to say who someone is, enough to create an
 * account or to apply an email domain rule. Microsoft accounts can carry any email their
 * organization lets them set ("nOAuth"): only one named organization is trusted.
 */
export const providerEmailsTrusted = (id: SsoProviderId, p: Pick<SsoProvider, "tenantId">) => id !== "microsoft" || microsoftSingleTenant(p.tenantId);

export const GITLAB_COM = "https://gitlab.com";

/** A GitLab server address as it is compared (gitlab.com when empty). */
export const normalizeGitlab = (url: string | undefined) => (url?.trim() ? url.trim().replace(/\/+$/, "") : GITLAB_COM).toLowerCase();

/** OpenID Connect providers with a known setup: where the issuer is, and how the button reads. */
export const OIDC_PRESETS = [
  { id: "keycloak", name: "Keycloak", issuer: "https://auth.example.com/realms/<realm>" },
  { id: "authentik", name: "Authentik", issuer: "https://auth.example.com/application/o/<app-slug>/" },
  { id: "okta", name: "Okta", issuer: "https://<your-org>.okta.com" },
  { id: "auth0", name: "Auth0", issuer: "https://<tenant>.auth0.com" },
  { id: "zitadel", name: "Zitadel", issuer: "https://<instance>.zitadel.cloud" },
  { id: "pocket-id", name: "Pocket ID", issuer: "https://id.example.com" },
  { id: "authelia", name: "Authelia", issuer: "https://auth.example.com" },
  { id: "kanidm", name: "Kanidm", issuer: "https://idm.example.com/oauth2/openid/<client-id>" },
  { id: "casdoor", name: "Casdoor", issuer: "https://door.example.com" },
  { id: "logto", name: "Logto", issuer: "https://auth.example.com/oidc" },
  { id: "dex", name: "Dex", issuer: "https://dex.example.com" },
  { id: "gitea", name: "Gitea or Forgejo", issuer: "https://git.example.com" },
  { id: "infomaniak", name: "Infomaniak", issuer: "https://login.infomaniak.com" },
] as const;

export type OidcPresetId = (typeof OIDC_PRESETS)[number]["id"];

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
  /** OpenID Connect: the issuer. GitLab: the server's address for a GitLab of your own (empty: gitlab.com). */
  issuer?: string;
  /** Microsoft only: the organization (tenant ID or domain), or organizations, common or consumers. */
  tenantId?: string;
  /** OpenID Connect only: the known provider it was set up as (setup help and the button's name). */
  preset?: OidcPresetId;
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
  /** The GitLab server (normalized) that GitLab accounts were linked with, like oidcLinkedIssuer. */
  gitlabLinkedServer?: string;
};

export const defaultSignIn: SignInSettings = { passwordEnabled: true, providers: {} };

export const providerNames: Record<SsoProviderId, string> = {
  github: "GitHub",
  google: "Google",
  microsoft: "Microsoft",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  oidc: "OpenID Connect",
};

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

/** A provider's name as people see it: the company login's own label or preset name. */
export function displayName(id: SsoProviderId, p: SsoProvider | undefined) {
  if (id !== "oidc") return providerNames[id];
  return p?.label?.trim() || OIDC_PRESETS.find((x) => x.id === p?.preset)?.name || providerNames.oidc;
}

/** Button label on the login page. */
export function buttonLabel(id: SsoProviderId, p: SsoProvider | undefined) {
  if (id === "oidc") {
    const preset = OIDC_PRESETS.find((x) => x.id === p?.preset);
    return p?.label?.trim() || (preset ? `Continue with ${preset.name}` : "Sign in with SSO");
  }
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
      return [
        id,
        p.clientId,
        p.clientSecret,
        p.issuer ?? "",
        p.tenantId ?? "",
        (p.scopes ?? []).join(" "),
        p.allowSignUp,
        p.allowedDomains.join(","),
        (p.allowedOrgs ?? []).join(","),
      ];
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
    tenantId: z
      .string()
      .trim()
      .max(100)
      // A tenant ID (a GUID), a domain of the organization, or one of the shared endpoints.
      .regex(
        /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|organizations|common|consumers|([a-z0-9-]+\.)+[a-z]{2,63})?$/i,
        "Enter the tenant ID, like 1b2c3d4e-…, or a domain of the organization",
      )
      .optional(),
    preset: z.enum(OIDC_PRESETS.map((x) => x.id) as [OidcPresetId, ...OidcPresetId[]]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.issuer !== undefined && v.issuer !== "") {
      try {
        const url = new URL(v.issuer);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
          ctx.addIssue({ code: "custom", path: ["issuer"], message: "The address must use https" });
        }
      } catch {
        ctx.addIssue({ code: "custom", path: ["issuer"], message: "Enter an address, like https://login.example.com" });
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
