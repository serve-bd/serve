import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { and, asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import type { MemberRole } from "@/server/db/schema";
import { getSetting } from "@/server/settings";

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

export const auth = betterAuth({
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
    },
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Accounts are created through first-run setup or organization invites only.
    disableSignUp: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 },
  },
  databaseHooks: {
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
      allowUserToCreateOrganization: async (user) =>
        (await getSetting("allowOrganizationCreation")) || (await isInstanceAdmin(user.id)),
      creatorRole: "owner",
      membershipLimit: 500,
      invitationExpiresIn: 60 * 60 * 24 * 7,
      cancelPendingInvitationsOnReInvite: true,
      // Invite links are shared manually from the dashboard.
      sendInvitationEmail: async () => {},
    }),
    nextCookies(),
  ],
});

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
    await db
      .update(schema.session)
      .set({ activeOrganizationId: orgId })
      .where(eq(schema.session.id, session.session.id));
  }
  const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, orgId!));
  const rootId = await getSetting("rootOrganizationId");
  return {
    user,
    sessionId: session.session.id,
    org,
    role: membership!.role,
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

export async function requireInstanceAdmin() {
  const ctx = await requireOrg();
  if (!ctx.isInstanceAdmin) throw new ForbiddenError("Only admins of the Root organization can change server settings.");
  return ctx;
}
