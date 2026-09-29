import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { type GenericOAuthConfig, genericOAuth, organization, twoFactor } from "better-auth/plugins";
import { and, asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { decryptOrNull } from "@/server/crypto";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import type { MemberRole } from "@/server/db/schema";
import { newId } from "@/server/id";
import { getSetting } from "@/server/settings";
import { guardProfileEmail, signInRefused } from "@/server/sso/domain-guard";
import { githubMembersOnly } from "@/server/sso/github-orgs";
import { activeProviders, callbackUrl, configHash, discoveryUrl, providerIdOf, providerNames, type SignInSettings, signUpAllowed } from "@/server/sso/config";
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

export async function isInstanceAdmin(userId: string) {
  const rootId = await getSetting("rootOrganizationId");
  if (!rootId) return false;
  const [m] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, rootId), eq(schema.member.userId, userId)));
  return m?.role === "owner" || m?.role === "admin";
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

/** The provider an OAuth callback came from, with its settings. */
async function callbackProvider(ctx: { path?: string; params?: unknown } | null | undefined) {
  const id = providerIdOf(ctx?.path, ctx?.params as Record<string, unknown> | undefined);
  return id ? ((await getSetting("signIn")).providers[id] ?? null) : undefined;
}

function createAuth(sso: SsoRuntime) {
  return betterAuth({
    secret: env.authSecret,
    // The dashboard can be reached through several hostnames (server IP, custom domain).
    baseURL: { allowedHosts: ["*"], fallback: env.appUrl },
    advanced: { trustedProxyHeaders: true },
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
    account: {
      accountLinking: {
        enabled: true,
        // Signing in with a provider links it to an existing user with the same verified email.
        // Linking from the Account page (already signed in) may use a different address.
        allowDifferentEmails: true,
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
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
            if (!provider?.defaultOrganizationId) return;
            const [org] = await db.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, provider.defaultOrganizationId));
            if (!org) return;
            await db.insert(schema.member).values({ id: newId(), organizationId: org.id, userId: user.id, role: provider.defaultRole }).onConflictDoNothing();
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
          before: async (session) => ({
            data: { ...session, activeOrganizationId: await firstOrganizationFor(session.userId) },
          }),
        },
      },
    },
    trustedOrigins: (request) => {
      const origin = request?.headers.get("origin");
      return origin ? [env.appUrl, origin] : [env.appUrl];
    },
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

/** The auth instance without sign-in providers: sessions, password sign-in and organizations. */
export const auth = createAuth(noSso);

let current: { key: string; instance: ReturnType<typeof createAuth> } | null = null;

/**
 * Auth instance with the sign-in providers from settings. better-auth fixes providers when an
 * instance is created, so a new one is built whenever their settings (or the dashboard URL) change.
 */
export async function getAuth() {
  const settings = await getSetting("signIn");
  if (!activeProviders(settings).length) return auth;
  const { publicBaseUrl } = await import("@/server/git/github-app");
  const base = await publicBaseUrl();
  const key = `${base}|${configHash(settings)}`;
  if (current?.key !== key) current = { key, instance: createAuth(ssoRuntime(settings, base)) };
  return current.instance;
}

export type Session = typeof auth.$Infer.Session;
export type SessionUser = Session["user"];

export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
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

export async function requireInstanceAdmin() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) throw new ForbiddenError("Only admins of the Root organization can change server settings.");
  return ctx;
}
