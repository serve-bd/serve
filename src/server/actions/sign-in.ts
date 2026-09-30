"use server";

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { logActivity } from "@/server/activity";
import { requireInstanceAdmin, requireUser } from "@/server/auth";
import { encrypt } from "@/server/crypto";
import { db, schema } from "@/server/db";
import { publicGet } from "@/server/net/public-fetch";
import { getSetting, updateSettings } from "@/server/settings";
import {
  activeProviders,
  discoveryUrl,
  type ProviderInput,
  providerInput,
  providerNames,
  type SignInSettings,
  type SsoProvider,
  type SsoProviderId,
  SSO_PROVIDERS,
} from "@/server/sso/config";

function assertProvider(id: string): asserts id is SsoProviderId {
  if (!(SSO_PROVIDERS as string[]).includes(id)) throw new UserError("Unknown sign-in provider.");
}

/** Root admins who could still sign in with one of these providers (they have linked it). */
async function adminsWith(providers: SsoProviderId[]) {
  if (!providers.length) return 0;
  const rootId = await getSetting("rootOrganizationId");
  if (!rootId) return 0;
  const rows = await db
    .selectDistinct({ userId: schema.account.userId })
    .from(schema.account)
    .innerJoin(schema.member, and(eq(schema.member.userId, schema.account.userId), eq(schema.member.organizationId, rootId)))
    .where(and(inArray(schema.account.providerId, providers), inArray(schema.member.role, ["owner", "admin"])));
  return rows.length;
}

/** With password sign-in off, a change must leave a provider that a Root admin can use. */
async function assertAdminCanSignIn(next: SignInSettings) {
  if (next.passwordEnabled) return;
  if (!(await adminsWith(activeProviders(next)))) {
    throw new UserError("Password sign-in is off, and no Root admin has linked a provider that stays on. Link one on your Account page first, or turn password sign-in back on.");
  }
}

/** Reads the OpenID discovery document so a wrong issuer fails on save, not at sign-in. */
async function checkIssuer(issuer: string) {
  let doc: { issuer?: string; authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string };
  try {
    const res = await publicGet(discoveryUrl(issuer), { timeoutMs: 10_000, maxRedirects: 2 });
    const chunks: Buffer[] = [];
    for await (const c of res.body) {
      chunks.push(c as Buffer);
      if (chunks.reduce((n, b) => n + b.length, 0) > 256_000) break;
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    doc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    throw new UserError(`Could not read ${discoveryUrl(issuer)}: ${(e as Error).message}`);
  }
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new UserError("The discovery document is missing endpoints (authorization, token or keys). Check the issuer URL.");
  }
  return { issuer: doc.issuer ?? issuer, authorization: doc.authorization_endpoint };
}

/** Test an issuer from the settings form. */
export async function testOidcIssuer(issuer: string) {
  return act(async () => {
    await requireInstanceAdmin();
    return checkIssuer(issuer.trim());
  });
}

export async function saveSsoProvider(id: string, input: ProviderInput) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    assertProvider(id);
    const parsed = providerInput.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues[0].message);
    const v = parsed.data;
    const settings = await getSetting("signIn");
    const before = settings.providers[id];
    const clientSecret = v.clientSecret ? encrypt(v.clientSecret) : before?.clientSecret;
    if (!clientSecret) throw new UserError("Enter the client secret.");
    if (id === "oidc") {
      if (!v.issuer) throw new UserError("Enter the issuer URL.");
      await checkIssuer(v.issuer);
    }
    const { organizationRoles } = await import("@/server/permissions");
    /** Checks an organization and role pick; returns the role id to store (null for Admin or none). */
    const checkRole = async (organizationId: string | null, role: "member" | "admin", roleId: string | null) => {
      if (!organizationId) return null;
      const [org] = await db.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.id, organizationId));
      if (!org) throw new UserError("That organization no longer exists.");
      if (role === "admin" || !roleId) return null;
      const roles = await organizationRoles(org.id);
      if (!roles.some((r) => r.id === roleId && r.id !== "owner" && r.id !== "admin")) throw new UserError("That role does not exist in the organization.");
      return roleId;
    };
    const defaultRoleId = await checkRole(v.defaultOrganizationId, v.defaultRole, v.defaultRoleId);
    // GitHub: one rule per GitHub organization; the allow-list is their names.
    const rules =
      id === "github"
        ? await Promise.all(
            [...new Map((v.githubOrgs ?? v.allowedOrgs.map((org) => ({ org, organizationId: null, role: "member" as const, roleId: null }))).map((r) => [r.org, r])).values()].map(
              async (r) => ({ org: r.org, organizationId: r.organizationId, role: r.role, roleId: await checkRole(r.organizationId, r.role, r.roleId) }),
            ),
          )
        : [];
    const provider: SsoProvider = {
      enabled: v.enabled,
      clientId: v.clientId,
      clientSecret,
      allowSignUp: v.allowSignUp,
      allowedDomains: [...new Set(v.allowedDomains)],
      ...(rules.length ? { allowedOrgs: rules.map((r) => r.org), githubOrgs: rules } : {}),
      defaultOrganizationId: v.defaultOrganizationId,
      defaultRole: v.defaultRole,
      defaultRoleId,
      ...(id === "oidc" ? { issuer: v.issuer, scopes: v.scopes?.length ? v.scopes : undefined, label: v.label || undefined } : {}),
    };
    const next: SignInSettings = { ...settings, providers: { ...settings.providers, [id]: provider } };
    await assertAdminCanSignIn(next);
    await updateSettings({ signIn: next });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "sign-in.provider", message: `Updated ${providerNames[id]} sign-in` });
    return null;
  });
}

export async function removeSsoProvider(id: string) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    assertProvider(id);
    const settings = await getSetting("signIn");
    const { [id]: _, ...rest } = settings.providers;
    const next: SignInSettings = { ...settings, providers: rest };
    await assertAdminCanSignIn(next);
    await updateSettings({ signIn: next });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "sign-in.provider", message: `Removed ${providerNames[id]} sign-in` });
    return null;
  });
}

/**
 * Ends the sessions of everyone with an account of this sign-in method ("credential" for a password),
 * except the admin's own session. Sessions do not record how they began, so a person who also has
 * another method is signed out too; they sign in again with that one.
 */
async function signOutMethodUsers(providerId: string, keepSessionId: string) {
  const ended = await db
    .delete(schema.session)
    .where(
      and(
        ne(schema.session.id, keepSessionId),
        sql`${schema.session.userId} in (select ${schema.account.userId} from ${schema.account} where ${schema.account.providerId} = ${providerId})`,
      ),
    )
    .returning({ userId: schema.session.userId });
  return new Set(ended.map((e) => e.userId)).size;
}

/** Turn a configured provider on or off without removing its settings; optionally sign out its users. */
export async function setSsoProviderEnabled(id: string, enabled: boolean, signOut = false) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    assertProvider(id);
    const settings = await getSetting("signIn");
    const before = settings.providers[id];
    if (!before) throw new UserError(`Set up ${providerNames[id]} sign-in first.`);
    const next: SignInSettings = { ...settings, providers: { ...settings.providers, [id]: { ...before, enabled } } };
    if (!enabled && next.passwordEnabled === false && !activeProviders(next).length) throw new UserError("Turn on password sign-in or another provider first.");
    await assertAdminCanSignIn(next);
    await updateSettings({ signIn: next });
    const people = !enabled && signOut ? await signOutMethodUsers(id, ctx.sessionId) : 0;
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "sign-in.provider",
      message: `${enabled ? "Turned on" : "Turned off"} ${providerNames[id]} sign-in${people ? ` and signed out ${people} ${people === 1 ? "person" : "people"}` : ""}`,
    });
    return { signedOut: people };
  });
}

export async function setPasswordLogin(enabled: boolean, signOut = false) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const settings = await getSetting("signIn");
    const next: SignInSettings = { ...settings, passwordEnabled: enabled };
    if (!enabled && !activeProviders(next).length) throw new UserError("Turn on a sign-in provider first.");
    await assertAdminCanSignIn(next);
    await updateSettings({ signIn: next });
    // Password sign-in stays possible while SERVE_ALLOW_PASSWORD_LOGIN=1 forces it, so nobody is signed out then.
    const people = !enabled && signOut && process.env.SERVE_ALLOW_PASSWORD_LOGIN !== "1" ? await signOutMethodUsers("credential", ctx.sessionId) : 0;
    await logActivity({
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      action: "sign-in.password",
      message: enabled ? "Turned on password sign-in" : `Turned off password sign-in${people ? ` and signed out ${people} ${people === 1 ? "person" : "people"}` : ""}`,
    });
    return { signedOut: people };
  });
}

/** Sign-in methods of the current user, for the Account page. */
export async function mySignInMethods() {
  return act(async () => {
    const user = await requireUser();
    const rows = await db
      .select({ id: schema.account.id, providerId: schema.account.providerId, accountId: schema.account.accountId, createdAt: schema.account.createdAt })
      .from(schema.account)
      .where(eq(schema.account.userId, user.id));
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  });
}
