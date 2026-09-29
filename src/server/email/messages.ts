import { getSetting } from "@/server/settings";
import { sendEmail } from "./send";
import { renderEmail } from "./templates";

async function brand() {
  return (await getSetting("instanceName")) || "Serve";
}

export async function sendPasswordResetEmail(to: string, name: string | null, url: string) {
  const b = await brand();
  const { html, text } = renderEmail({
    brand: b,
    heading: "Reset your password",
    paragraphs: [`Hi${name ? ` ${name}` : ""}, someone asked to reset the password of your ${b} account.`, "If it was you, choose a new password with the button below."],
    action: { label: "Choose a new password", url },
    note: "The link expires in 1 hour. If you did not ask for this, ignore this email; your password stays the same.",
  });
  await sendEmail({ to, subject: `Reset your ${b} password`, text, html });
}

export async function sendInviteEmail(opts: { to: string; organization: string; inviter: string; role: string; url: string }) {
  const b = await brand();
  const { html, text } = renderEmail({
    brand: b,
    heading: `Join ${opts.organization}`,
    paragraphs: [`${opts.inviter} invited you to the ${opts.organization} organization on ${b} as ${opts.role === "admin" ? "an admin" : `a ${opts.role}`}.`],
    action: { label: "Accept the invitation", url: opts.url },
    note: "The invitation expires in 7 days.",
  });
  await sendEmail({ to: opts.to, subject: `${opts.inviter} invited you to ${opts.organization}`, text, html });
}

export async function sendNotificationEmail(to: string, msg: { title: string; body: string; url?: string; ok: boolean }) {
  const b = await brand();
  const { html, text } = renderEmail({
    brand: b,
    heading: `${msg.ok ? "✅" : "❌"} ${msg.title}`,
    paragraphs: msg.body.split("\n").filter(Boolean),
    action: msg.url ? { label: "Open in Serve", url: msg.url } : undefined,
  });
  await sendEmail({ to, subject: msg.title, text, html });
}

export async function sendTestEmailTo(to: string) {
  const b = await brand();
  const { html, text } = renderEmail({
    brand: b,
    heading: "Email works",
    paragraphs: [`This is a test email from ${b}. Password resets, invitations and notifications will be sent the same way.`],
  });
  await sendEmail({ to, subject: `Test email from ${b}`, text, html });
}
