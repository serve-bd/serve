"use server";

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { act, UserError } from "@/server/action";
import { isInstanceAdmin, isRootOwner, requireInstanceAdmin } from "@/server/auth";
import { encrypt } from "@/server/crypto";
import { db, schema } from "@/server/db";
import { logActivity } from "@/server/activity";
import { newId } from "@/server/id";
import { getSetting, updateSettings } from "@/server/settings";
import { defaultSmtpPort, type EmailSettings, type EmailSettingsInput, emailSettingsInput, mailroomBase } from "@/server/email/config";
import { sendTestEmailTo } from "@/server/email/messages";
import { publicBaseUrl } from "@/server/git/github-app";

/** Save outgoing email settings. Empty password / API key fields keep the stored secret. */
export async function saveEmailSettings(input: EmailSettingsInput) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const parsed = emailSettingsInput.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues[0].message);
    const v = parsed.data;
    const before = await getSetting("email");
    const next: EmailSettings = { provider: v.provider, fromName: v.fromName, fromAddress: v.fromAddress, smtp: null, apiKey: null };
    if (v.provider === "smtp") {
      const security = v.smtpSecurity ?? "starttls";
      next.smtp = {
        host: v.smtpHost ?? "",
        port: v.smtpPort ?? defaultSmtpPort[security],
        security,
        username: v.smtpUsername || null,
        // The stored password is kept only for the same server: it would otherwise be sent to the new one.
        password: v.smtpPassword ? encrypt(v.smtpPassword) : v.smtpUsername && before?.smtp?.host === v.smtpHost ? (before?.smtp?.password ?? null) : null,
      };
      if (v.smtpUsername && !next.smtp.password && before?.smtp?.password) throw new UserError("Enter the password again: the server changed.");
    } else {
      const sameTarget = before?.provider === v.provider && (v.provider !== "mailroom" || before.baseUrl === mailroomBase(v.baseUrl ?? ""));
      const key = v.apiKey ? encrypt(v.apiKey) : sameTarget ? (before.apiKey ?? null) : null;
      if (!key) throw new UserError("Enter the API key.");
      next.apiKey = key;
      if (v.provider === "mailroom") next.baseUrl = mailroomBase(v.baseUrl ?? "");
    }
    await updateSettings({ email: next });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "email.update", message: "Updated email settings" });
    return null;
  });
}

export async function removeEmailSettings() {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    await updateSettings({ email: null });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "email.update", message: "Turned off email" });
    return null;
  });
}

/** Send a test message to the signed-in admin with the saved settings. */
export async function sendTestEmail() {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    try {
      await sendTestEmailTo(ctx.user.email);
    } catch (e) {
      throw new UserError(`Sending failed: ${(e as Error).message}`);
    }
    return { to: ctx.user.email };
  });
}

/**
 * One-time password reset link for a user, for instances without email. Root admins only:
 * a user can belong to several organizations, so an org admin must not reset them.
 */
export async function createPasswordResetLink(userId: string) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const [user] = await db.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).where(eq(schema.user.id, userId));
    if (!user) throw new UserError("User not found.");
    // A reset link signs in as that person: only a Root owner may create one for another Root admin or owner.
    if (user.id !== ctx.user.id && (await isInstanceAdmin(user.id)) && !(await isRootOwner(ctx.user.id))) {
      throw new UserError("Only owners of the Root organization can create a reset link for a Root admin.");
    }
    // Same record better-auth's own reset flow creates, so /reset-password accepts it.
    const token = crypto.randomBytes(24).toString("base64url");
    await db.insert(schema.verification).values({
      id: newId(),
      identifier: `reset-password:${token}`,
      value: user.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "member.reset_link", message: `Created a password reset link for ${user.email}` });
    return { url: `${await publicBaseUrl()}/reset-password?token=${token}` };
  });
}
