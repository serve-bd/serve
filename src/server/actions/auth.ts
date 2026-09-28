"use server";

import { headers } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { auth } from "@/server/auth";
import { db, schema } from "@/server/db";
import { createAccount, createOrganization, userCount } from "@/server/accounts";
import { updateSettings } from "@/server/settings";
import { logActivity } from "@/server/activity";
import { newId } from "@/server/id";

const setupSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  email: z.email("Enter a valid email"),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

export async function setupInstance(input: z.infer<typeof setupSchema>) {
  return act(async () => {
    const data = setupSchema.parse(input);
    if ((await userCount()) > 0) throw new UserError("Serve is already set up. Sign in instead.");
    const user = await createAccount(data);
    const org = await createOrganization("Root", user.id);
    await updateSettings({ rootOrganizationId: org.id });
    await logActivity({ userId: user.id, organizationId: org.id, action: "instance.setup", message: "Set up Serve" });
    await auth.api.signInEmail({ body: { email: data.email, password: data.password }, headers: await headers() });
    return null;
  });
}

async function findInvitation(id: string) {
  const [inv] = await db
    .select({ invitation: schema.invitation, org: schema.organization })
    .from(schema.invitation)
    .innerJoin(schema.organization, eq(schema.invitation.organizationId, schema.organization.id))
    .where(and(eq(schema.invitation.id, id), eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date())));
  return inv ?? null;
}

async function joinOrganization(invitationId: string, userId: string, email: string) {
  const inv = await findInvitation(invitationId);
  if (!inv) throw new UserError("This invite link is invalid or has expired. Ask for a new one.");
  if (inv.invitation.email.toLowerCase() !== email.toLowerCase()) {
    throw new UserError(`This invite was sent to ${inv.invitation.email}.`);
  }
  await db
    .insert(schema.member)
    .values({ id: newId(), organizationId: inv.org.id, userId, role: inv.invitation.role ?? "member" })
    .onConflictDoNothing();
  await db.update(schema.invitation).set({ status: "accepted" }).where(eq(schema.invitation.id, invitationId));
  await logActivity({ userId, organizationId: inv.org.id, action: "member.joined", message: `Joined ${inv.org.name}` });
  return inv.org;
}

const inviteSignupSchema = z.object({
  invitationId: z.string(),
  name: z.string().trim().min(1, "Enter your name").max(80),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

/** New user accepting an invite: create the account, join, and sign in. */
export async function acceptInviteWithSignup(input: z.infer<typeof inviteSignupSchema>) {
  return act(async () => {
    const data = inviteSignupSchema.parse(input);
    const inv = await findInvitation(data.invitationId);
    if (!inv) throw new UserError("This invite link is invalid or has expired. Ask for a new one.");
    const user = await createAccount({ name: data.name, email: inv.invitation.email, password: data.password });
    const org = await joinOrganization(data.invitationId, user.id, user.email);
    const h = await headers();
    await auth.api.signInEmail({ body: { email: user.email, password: data.password }, headers: h });
    return { organizationId: org.id };
  });
}

/** Signed-in user accepting an invite. */
export async function acceptInvite(invitationId: string) {
  return act(async () => {
    const h = await headers();
    const session = await auth.api.getSession({ headers: h });
    if (!session) throw new UserError("Sign in first.");
    const org = await joinOrganization(invitationId, session.user.id, session.user.email);
    await auth.api.setActiveOrganization({ headers: h, body: { organizationId: org.id } });
    return { organizationId: org.id };
  });
}
