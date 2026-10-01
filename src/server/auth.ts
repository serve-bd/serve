import { createHmac, randomBytes } from "node:crypto";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { requestIsHttps } from "@/lib/request-https";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { type GenericOAuthConfig, genericOAuth, organization, twoFactor } from "better-auth/plugins";
import { and, asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { decryptOrNull, timingSafeEqual } from "@/server/crypto";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import type { MemberRole } from "@/server/db/schema";
import { newId } from "@/server/id";
import { getSetting, getSettings } from "@/server/settings";
import { dashboardVisitorIp } from "@/server/proxy/trusted-proxies";
import { guardProfileEmail, matchedGithubOrgs, signInRefused } from "@/server/sso/domain-guard";
import { githubMembersOnly } from "@/server/sso/github-orgs";
import {
  activeProviders,
  callbackUrl,
  configHash,
  discoveryUrl,
  providerIdOf,
  providerNames,
  githubRules,
  type SignInSettings,
  type SsoProvider,
  type SsoProviderId,
  signUpAllowed,
} from "@/server/sso/config";
import { cannotMessage, type Permission } from "@/lib/permissions";
import { accessFrom, organizationRoles } from "@/server/permissions";

async function firstOrganizationFor(userId: string) {
  const [row] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.member.createdAt))
    .limit(1);
  return row?.organizationId ?? null;
}

async function rootRole(userId: string) {
  const rootId = await getSetting("rootOrganizationId");
  if (!rootId) return null;
  const [m] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, rootId), eq(schema.member.userId, userId)));
  return m?.role ?? null;
}

export async function isInstanceAdmin(userId: string) {
  const role = await rootRole(userId);
  return role === "owner" || role === "admin";
}

/** Owner of the Root organization, whichever organization is active. */
export async function isRootOwner(userId: string) {
  return (await rootRole(userId)) === "owner";
}

/** Password sign-in may be switched off in Settings → Sign-in; SERVE_ALLOW_PASSWORD_LOGIN=1 forces it back on. */
export async function passwordLoginAllowed() {
  if (process.env.SERVE_ALLOW_PASSWORD_LOGIN === "1") return true;
  return (await getSetting("signIn")).passwordEnabled !== false;
}

type SocialConfig = {
  clientId: string;
  clientSecret: string;
  redirectURI: string;
  disableImplicitSignUp: boolean;
  scope?: string[];
  mapProfileToUser?: (profile: { email?: string | null }) => Record<string, unknown>;
  getUserInfo?: ReturnType<typeof githubMembersOnly>;
};
type SsoRuntime = { social: Record<string, SocialConfig>; oidc: GenericOAuthConfig[] };

const noSso: SsoRuntime = { social: {}, oidc: [] };

/** Provider settings as better-auth expects them, with secrets decrypted. */
function ssoRuntime(settings: SignInSettings, base: string): SsoRuntime {
  const out: SsoRuntime = { social: {}, oidc: [] };
  for (const id of activeProviders(settings)) {
    const p = settings.providers[id];
    const clientSecret = p ? decryptOrNull(p.clientSecret) : null;
    if (!p || !clientSecret) continue;
    const common = {
      clientId: p.clientId,
      clientSecret,
      redirectURI: callbackUrl(base, id),
      disableImplicitSignUp: !p.allowSignUp,
      // Allowed domains apply to every sign-in and link through the provider, not only new accounts.
      mapProfileToUser: guardProfileEmail(p.allowedDomains),
    };
    if (id === "oidc") {
      out.oidc.push({
        ...common,
        providerId: "oidc",
        name: p.label || providerNames.oidc,
        discoveryUrl: discoveryUrl(p.issuer ?? ""),
        scopes: p.scopes?.length ? p.scopes : ["openid", "email", "profile"],
        pkce: true,
        requireIdTokenVerification: true,
      });
    } else if (id === "github" && p.allowedOrgs?.length) {
      // Organization members only: read:org lets Serve see private memberships too.
      out.social[id] = { ...common, disableImplicitSignUp: false, scope: ["read:org"], getUserInfo: githubMembersOnly(p.allowedOrgs, p.allowedDomains) };
    } else {
      // GitHub and Google already ask for the profile and email by default.
      out.social[id] = common;
    }
  }
  return out;
}

/** Adds the user to an organization with a role, unless already a member. */
async function joinOrganization(userId: string, organizationId: string, role: SsoProvider["defaultRole"], roleId: string | null, why: string) {
  const [org] = await db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, organizationId));
  if (!org) return;
  const [existing] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, userId)));
  if (existing) return;
  await db.insert(schema.member).values({ id: newId(), organizationId: org.id, userId, role, roleId: role === "member" ? roleId : null });
  const { logActivity } = await import("@/server/activity");
  await logActivity({ userId, organizationId: org.id, action: "member.joined", message: `Joined ${org.name} ${why}` }).catch(() => {});
}

/**
 * Organizations a provider sign-in adds the user to: per matched GitHub organization rule,
 * or the provider's default organization.
 */
async function joinProviderOrganizations(provider: SsoProvider, userId: string, githubOrgs = matchedGithubOrgs()) {
  const rules = githubRules(provider);
  if (rules.length) {
    const matched = new Set(githubOrgs);
    for (const r of rules)
      if (matched.has(r.org) && r.organizationId) await joinOrganization(userId, r.organizationId, r.role, r.roleId, `as a member of the ${r.org} GitHub organization`);
    return;
  }
  if (provider.defaultOrganizationId) await joinOrganization(userId, provider.defaultOrganizationId, provider.defaultRole, provider.defaultRoleId ?? null, "through sign-in");
}

/** The provider an OAuth callback came from, with its settings. */
async function callbackProvider(ctx: { path?: string; params?: unknown } | null | undefined) {
  const id = providerIdOf(ctx?.path, ctx?.params as Record<string, unknown> | undefined);
  return id ? ((await getSetting("signIn")).providers[id] ?? null) : undefined;
}

/**
 * The addresses the dashboard answers on: the install address, the dashboard domain and the
 * server's public IP. Only these count as the dashboard's own: links in emails are built for one
 * of them, and redirects after sign-in or a password reset may only go to them.
 */
export type DashboardAddresses = { hosts: string[]; origins: string[] };

export async function dashboardAddresses(): Promise<DashboardAddresses> {
  const app = new URL(env.appUrl);
  const hosts = new Set([app.host]);
  const origins = new Set([app.origin]);
  const settings = await getSettings().catch(() => null);
  if (settings?.dashboardDomain) {
    hosts.add(settings.dashboardDomain);
    for (const scheme of ["https", "http"]) origins.add(`${scheme}://${settings.dashboardDomain}`);
  }
  const [local] = await db
    .select({ publicIp: schema.server.publicIp })
    .from(schema.server)
    .where(eq(schema.server.isLocal, true))
    .catch(() => []);
  if (local?.publicIp) {
    const host = `${local.publicIp}${app.port ? `:${app.port}` : ""}`;
    hosts.add(host);
    origins.add(`${app.protocol}//${host}`);
  }
  return { hosts: [...hosts].sort(), origins: [...origins].sort() };
}

type ValidateUserInfo = NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]>;

/** Providers that verify email addresses themselves; an admin cannot make them assert someone else's. */
const LINK_BY_EMAIL = new Set(["github", "google"]);

/**
 * Links to existing users. A company login (OpenID Connect) is set up by an admin and could assert
 * any email, so it links to an existing user only from that user's Account page.
 */
const checkProviderSignIn: ValidateUserInfo = async ({ user, source }, ctx) => {
  if (source.method !== "oauth" || source.action !== "link-account" || !user.id) return;
  // Linking from the Account page: the signed-in user adds a provider to their own account.
  if ((await getSessionFromCtx(ctx))?.user.id === String(user.id)) return;
  if (!LINK_BY_EMAIL.has(source.oauth?.providerId ?? "")) return { error: "account_not_linked" };
  // An account nobody proved the email of (made from an invite link) is not joined by email: whoever
  // held the link chose its password. Its owner signs in with it and adds the provider from Account.
  const [row] = await db
    .select({ emailVerified: schema.user.emailVerified })
    .from(schema.user)
    .where(eq(schema.user.id, String(user.id)));
  if (!row?.emailVerified) return { error: "account_not_linked" };
};

type EndpointContext = Parameters<ValidateUserInfo>[1];

/** Paths where a provider sign-in creates a session (the OAuth callback, an ID token sign-in). */
function providerSessionPath(path: string | undefined) {
  return !!path && (path.startsWith("/callback/") || path === "/sign-in/social");
}

/**
 * Users with two-factor authentication still need their code after a provider sign-in, unless
 * this device is trusted. Runs when the session is about to be created, after better-auth linked
 * the provider, so a GitHub or Google link by email is kept. Throws to stop the session.
 */
async function requireSecondFactor(ctx: EndpointContext, userId: string, providerId: string | null) {
  const [row] = await db.select({ twoFactorEnabled: schema.user.twoFactorEnabled }).from(schema.user).where(eq(schema.user.id, userId));
  if (!row?.twoFactorEnabled || (await trustedDevice(ctx, userId))) return;
  await startTwoFactor(ctx, userId, providerId);
  throw new APIError("FORBIDDEN", { code: "two_factor_required", message: "Enter the code from your authenticator app." });
}

const TRUST_DEVICE_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * The two-factor plugin's trusted device check for password sign-ins, done the same way: a valid
 * signed trust_device cookie whose record matches the user is used once and replaced by a new one.
 */
async function trustedDevice(ctx: EndpointContext, userId: string) {
  const cookie = ctx.context.createAuthCookie("trust_device", { maxAge: TRUST_DEVICE_MAX_AGE });
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!value) return false;
  const sign = (id: string) => createHmac("sha256", ctx.context.secret).update(`${userId}!${id}`).digest("base64url");
  const [token, trustId] = value.split("!");
  if (!token || !trustId || !timingSafeEqual(token, sign(trustId))) return false;
  const record = await ctx.context.internalAdapter.findVerificationValue(trustId);
  if (!record || record.value !== userId || record.expiresAt <= new Date()) return false;
  await ctx.context.internalAdapter.deleteVerificationByIdentifier(trustId);
  const nextId = `trust-device-${randomBytes(24).toString("base64url")}`;
  await ctx.context.internalAdapter.createVerificationValue({ value: userId, identifier: nextId, expiresAt: new Date(Date.now() + TRUST_DEVICE_MAX_AGE * 1000) });
  await ctx.setSignedCookie(cookie.name, `${sign(nextId)}!${nextId}`, ctx.context.secret, cookie.attributes);
  return true;
}

/**
 * Starts the code step the way the two-factor plugin does after a password sign-in (a pending
 * verification and its signed cookie); the login page then asks for the code, and the plugin's
 * verify endpoints create the session.
 */
async function startTwoFactor(ctx: EndpointContext, userId: string, providerId: string | null) {
  const maxAge = 600;
  const identifier = `2fa-${randomBytes(15).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + maxAge * 1000);
  await ctx.context.internalAdapter.createVerificationValue({ value: userId, identifier, expiresAt });
  await ctx.context.internalAdapter.createVerificationValue({ value: "0", identifier: `2fa-attempts-${identifier}`, expiresAt });
  // What the sign-in found at the provider, for the organization join once the code is right.
  const pending: ProviderSignIn = { userId, providerId: providerId ?? "", githubOrgs: matchedGithubOrgs() };
  await ctx.context.internalAdapter.createVerificationValue({ value: JSON.stringify(pending), identifier: `2fa-provider-${identifier}`, expiresAt });
  const cookie = ctx.context.createAuthCookie("two_factor", { maxAge });
  await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);
}

type ProviderSignIn = { userId: string; providerId: string; githubOrgs: string[] };

/**
 * A provider sign-in that needed the two-factor code gets its session from the verify endpoint,
 * outside the callback: run the GitHub organization join it would have run there.
 */
async function joinAfterTwoFactor(ctx: EndpointContext, userId: string) {
  const cookie = ctx.context.createAuthCookie("two_factor");
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return;
  const row = await ctx.context.internalAdapter.consumeVerificationValue(`2fa-provider-${identifier}`).catch(() => null);
  if (!row) return;
  const pending = JSON.parse(row.value) as ProviderSignIn;
  const provider = (await getSetting("signIn")).providers[pending.providerId as SsoProviderId];
  if (pending.userId === userId && provider?.allowedOrgs?.length) await joinProviderOrganizations(provider, userId, pending.githubOrgs);
}

/**
 * The visitor address: the right-most X-Forwarded-For entry that is not one of the dashboard
 * proxy's trusted proxies (earlier entries are the client's own claim).
 */
async function clientIp(headers: Headers | undefined) {
  return (await dashboardVisitorIp(headers)) || "unknown";
}

const appOnly: DashboardAddresses = (() => {
  const app = new URL(env.appUrl);
  return { hosts: [app.host], origins: [app.origin] };
})();

/**
 * `secure`: Secure (__Secure-) session cookies, for HTTPS requests only. Browsers drop Secure
 * cookies set over plain HTTP, so without this switch nobody could sign in before the dashboard
 * has a domain with HTTPS.
 */
function createAuth(sso: SsoRuntime, addresses: DashboardAddresses = appOnly, secure = false) {
  return betterAuth({
    secret: env.authSecret,
    // Never "*": that would make every website a trusted redirect target (a password reset link
    // could then send its token anywhere).
    baseURL: { allowedHosts: addresses.hosts, fallback: env.appUrl },
    advanced: { trustedProxyHeaders: true, useSecureCookies: secure },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        organization: schema.organization,
        member: schema.member,
        invitation: schema.invitation,
        twoFactor: schema.twoFactor,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // Accounts are created through first-run setup or organization invites only.
      disableSignUp: true,
      resetPasswordTokenExpiresIn: 3600,
      // A reset signs out everywhere, in case the old password was known to someone else.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        const { sendPasswordResetEmail } = await import("@/server/email/messages");
        // Errors are logged, never shown: the response must not reveal whether an account exists.
        await sendPasswordResetEmail(user.email, user.name, url).catch((e) => console.error(`Password reset email failed: ${(e as Error).message}`));
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/request-password-reset": { window: 15 * 60, max: 5 },
        "/reset-password": { window: 15 * 60, max: 10 },
        "/sign-in/email": { window: 60, max: 10 },
      },
    },
    socialProviders: sso.social,
    // Only with providers: it also runs for accounts created outside a request (createAccount),
    // which uses the instance without providers.
    ...(Object.keys(sso.social).length || sso.oidc.length ? { user: { validateUserInfo: checkProviderSignIn } } : {}),
    account: {
      accountLinking: {
        enabled: true,
        // Signing in with GitHub or Google links it to an existing user with the same verified
        // email (checkProviderSignIn refuses that for the company login).
        // Linking from the Account page (already signed in) may use a different address.
        allowDifferentEmails: true,
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // The IP limits above trust X-Forwarded-For, which a client can set; these do not.
        // Per email and address, so others cannot lock someone out; the looser per-email cap still
        // stops guessing from many addresses.
        if (ctx.path === "/sign-in/email") {
          const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "").toLowerCase();
          const fromHere = tooManyAttempts(`email:${email}|${await clientIp(ctx.headers)}`, 10, 15 * 60_000);
          const overall = tooManyAttempts(`email:${email}`, 100, 60 * 60_000);
          if (fromHere || overall) {
            throw new APIError("TOO_MANY_REQUESTS", { message: "Too many sign-in attempts. Try again in 15 minutes." });
          }
        }
        if (ctx.path === "/request-password-reset") {
          const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "").toLowerCase();
          if (tooManyAttempts(`reset:${await clientIp(ctx.headers)}`, 5, 15 * 60_000) || tooManyAttempts(`reset:${email}`, 5, 15 * 60_000)) {
            throw new APIError("TOO_MANY_REQUESTS", { message: "Too many reset requests. Try again in 15 minutes." });
          }
        }
        if (ctx.path.startsWith("/two-factor/verify-")) {
          const pending = ctx.headers?.get("cookie")?.match(/two_factor=([^;]+)/)?.[1] ?? "none";
          if (tooManyAttempts(`2fa:${pending}`, 10, 15 * 60_000)) throw new APIError("TOO_MANY_REQUESTS", { message: "Too many codes tried. Sign in again in 15 minutes." });
        }
        if (ctx.path === "/sign-in/email" && !(await passwordLoginAllowed())) {
          throw new APIError("FORBIDDEN", { message: "Password sign-in is turned off. Use single sign-on instead." });
        }
        // Without password sign-in, keep at least one provider that is still on.
        if (ctx.path === "/unlink-account" && !(await passwordLoginAllowed())) {
          const session = await getSessionFromCtx(ctx);
          if (!session) return;
          const on = activeProviders(await getSetting("signIn")) as string[];
          const rows = await db.select({ id: schema.account.id, providerId: schema.account.providerId }).from(schema.account).where(eq(schema.account.userId, session.user.id));
          const accountId = (ctx.body as { accountId?: string } | undefined)?.accountId;
          if (!rows.some((r) => r.id !== accountId && on.includes(r.providerId))) {
            throw new APIError("BAD_REQUEST", { message: "Password sign-in is off, so this is your last way in. Link another provider first." });
          }
        }
      }),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 },
    },
    databaseHooks: {
      user: {
        create: {
          // Accounts made through a provider: only when it allows new accounts for this email.
          before: async (user, ctx) => {
            const provider = await callbackProvider(ctx);
            if (provider === undefined) return;
            if (!provider || !signUpAllowed(provider, user.email)) return false;
          },
          // New provider accounts can join a default organization.
          after: async (user, ctx) => {
            const provider = await callbackProvider(ctx);
            if (provider) await joinProviderOrganizations(provider, user.id);
          },
        },
      },
      account: {
        create: {
          // Linking from the Account page skips the email check, so refuse the new link here.
          before: async () => {
            if (signInRefused()) return false;
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            // With the GitHub organization rule, membership there is the source of truth:
            // members join the chosen organization on every sign-in, not only the first.
            if (ctx && providerSessionPath(ctx.path)) await requireSecondFactor(ctx, session.userId, providerIdOf(ctx.path, ctx.params as Record<string, unknown> | undefined));
            const provider = await callbackProvider(ctx);
            if (provider?.allowedOrgs?.length && !signInRefused()) await joinProviderOrganizations(provider, session.userId);
            else if (ctx?.path?.startsWith("/two-factor/verify-")) await joinAfterTwoFactor(ctx, session.userId);
            return {
              data: { ...session, activeOrganizationId: await firstOrganizationFor(session.userId) },
            };
          },
        },
      },
    },
    // Exactly the dashboard's own addresses; a request's Origin header is never taken on trust.
    trustedOrigins: addresses.origins,
    plugins: [
      organization({
        allowUserToCreateOrganization: async (user) => (await getSetting("allowOrganizationCreation")) || (await isInstanceAdmin(user.id)),
        creatorRole: "owner",
        // Deletion goes through Serve's own action, which checks projects and the Root organization.
        disableOrganizationDeletion: true,
        membershipLimit: 500,
        invitationExpiresIn: 60 * 60 * 24 * 7,
        cancelPendingInvitationsOnReInvite: true,
        // Invite links are shared manually from the dashboard.
        sendInvitationEmail: async () => {},
      }),
      twoFactor({ issuer: "Serve" }),
      genericOAuth({ config: sso.oidc }),
      nextCookies(),
    ],
  });
}

const attempts = new Map<string, number[]>();

/** Counts an attempt for `key`; true once more than `max` fall within the window. In memory: the dashboard is one process. */
function tooManyAttempts(key: string, max: number, windowMs: number) {
  const now = Date.now();
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.at(-1)! < now - windowMs) attempts.delete(k);
  const recent = (attempts.get(key) ?? []).filter((t) => t > now - windowMs);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > max;
}

/** The auth instance without sign-in providers, for plain HTTP requests: sessions, password sign-in and organizations. */
export const auth = createAuth(noSso);
const secureAuth = createAuth(noSso, appOnly, true);

/** The instance for a request: its cookies are Secure exactly when the request is HTTPS. */
export function authFor(h: Headers | null | undefined) {
  return requestIsHttps(h) ? secureAuth : auth;
}

const current = new Map<boolean, { key: string; instance: ReturnType<typeof createAuth> }>();

/**
 * Auth instance with the sign-in providers from settings. better-auth fixes providers when an
 * instance is created, so a new one is built whenever their settings (or the dashboard URL) change.
 */
export async function getAuth(request?: Request) {
  const secure = requestIsHttps(request?.headers);
  const settings = await getSetting("signIn");
  const addresses = await dashboardAddresses();
  const sso = activeProviders(settings).length > 0;
  const { publicBaseUrl } = await import("@/server/git/github-app");
  const base = sso ? await publicBaseUrl() : "";
  const key = `${base}|${sso ? configHash(settings) : "-"}|${addresses.hosts.join(",")}`;
  const cached = current.get(secure);
  if (cached?.key === key) return cached.instance;
  const instance = createAuth(sso ? ssoRuntime(settings, base) : noSso, addresses, secure);
  current.set(secure, { key, instance });
  return instance;
}

export type Session = typeof auth.$Infer.Session;
export type SessionUser = Session["user"];

export const getSession = cache(async () => {
  const h = await headers();
  return authFor(h).api.getSession({ headers: h });
});

/** Use in server components/actions: returns the user or redirects to login. */
export async function requireUser(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session.user;
}

export type OrgContext = {
  user: SessionUser;
  sessionId: string;
  org: typeof schema.organization.$inferSelect;
  role: MemberRole;
  /** "owner", "admin", "developer", "viewer" or a custom role id. */
  roleId: string;
  roleName: string;
  permissions: Set<Permission>;
  /** Projects the member can reach; null means every project. */
  projectIds: string[] | null;
  can: (permission: Permission) => boolean;
  canAccessProject: (projectId: string) => boolean;
  isAdmin: boolean;
  isInstanceAdmin: boolean;
  isRoot: boolean;
};

/** Current user + active organization + membership. Redirects when missing. */
export const requireOrg = cache(async (): Promise<OrgContext> => {
  const session = await getSession();
  if (!session) redirect("/login");
  const user = session.user;
  let orgId = session.session.activeOrganizationId as string | null | undefined;

  let membership = orgId
    ? (
        await db
          .select()
          .from(schema.member)
          .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, user.id)))
      )[0]
    : undefined;
  if (!membership) {
    orgId = await firstOrganizationFor(user.id);
    if (!orgId) redirect("/no-organization");
    membership = (
      await db
        .select()
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, user.id)))
    )[0];
    await db.update(schema.session).set({ activeOrganizationId: orgId }).where(eq(schema.session.id, session.session.id));
  }
  const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, orgId!));
  const rootId = await getSetting("rootOrganizationId");
  const access = accessFrom(membership!, await organizationRoles(org.id));
  return {
    user,
    sessionId: session.session.id,
    org,
    role: membership!.role,
    roleId: access.roleId,
    roleName: access.roleName,
    permissions: access.permissions,
    projectIds: access.projectIds,
    can: (permission) => access.permissions.has(permission),
    canAccessProject: (projectId) => !access.projectIds || access.projectIds.includes(projectId),
    isAdmin: membership!.role === "owner" || membership!.role === "admin",
    isInstanceAdmin: await isInstanceAdmin(user.id),
    isRoot: org.id === rootId,
  };
});

export class ForbiddenError extends Error {}

export async function requireOrgAdmin() {
  const ctx = await requireOrg();
  if (!ctx.isAdmin) throw new ForbiddenError("You need to be an admin of this organization to do this.");
  return ctx;
}

/** The current member, when their role has `permission`; otherwise a "Your role cannot ..." error. */
export async function requirePermission(permission: Permission) {
  const ctx = await requireOrg();
  if (!ctx.can(permission)) throw new ForbiddenError(cannotMessage(permission));
  return ctx;
}

/**
 * The signed-in member's context when this request has a session, else null (API tokens,
 * the worker). Used by lookups that also enforce project access.
 */
export async function sessionOrgContext(): Promise<OrgContext | null> {
  try {
    if (!(await getSession())) return null;
    return await requireOrg();
  } catch {
    return null;
  }
}

/** For pages under /settings: the layout's check alone does not run on every client navigation. */
export async function instanceAdminPage() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) redirect("/");
  return ctx;
}

export async function requireInstanceAdmin() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) throw new ForbiddenError("Only admins of the Root organization can change server settings.");
  return ctx;
}
