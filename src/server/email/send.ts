import nodemailer from "nodemailer";
import { Resend } from "resend";
import { publicRequest } from "@/server/net/public-fetch";
import { decryptOrNull } from "@/server/crypto";
import { getSetting } from "@/server/settings";
import { type EmailSettings, fromHeader } from "./config";

/** `headers`: extra mail headers, like List-Unsubscribe (sent where the provider takes them). */
export type OutgoingEmail = { to: string; subject: string; text: string; html?: string; headers?: Record<string, string> };

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email is not set up. Configure it in Settings → Email.");
  }
}

/** Send with explicit settings (the "Send test email" button uses the unsaved form too). */
export async function sendWith(settings: EmailSettings, mail: OutgoingEmail) {
  const from = fromHeader(settings);
  if (settings.provider === "smtp") {
    const smtp = settings.smtp;
    if (!smtp) throw new EmailNotConfiguredError();
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.security === "tls",
      requireTLS: smtp.security === "starttls",
      ignoreTLS: smtp.security === "none",
      auth: smtp.username ? { user: smtp.username, pass: decryptOrNull(smtp.password ?? null) ?? "" } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, headers: mail.headers });
    return;
  }
  const key = decryptOrNull(settings.apiKey ?? null);
  if (!key) throw new EmailNotConfiguredError();
  if (settings.provider === "mailroom") {
    if (!settings.baseUrl) throw new EmailNotConfiguredError();
    const res = await publicRequest(`${settings.baseUrl}/api/v1/emails`, {
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      timeoutMs: 20_000,
    });
    if (res.status < 200 || res.status >= 300) {
      let message = res.text.slice(0, 200);
      try {
        message = (JSON.parse(res.text) as { error?: string }).error ?? message;
      } catch {}
      throw new Error(`Mailroom refused the message (HTTP ${res.status})${message ? `: ${message}` : ""}`);
    }
    return;
  }
  if (settings.provider === "resend") {
    const { error } = await new Resend(key).emails.send({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html, headers: mail.headers });
    if (error) throw new Error(`Resend refused the message: ${error.message}`);
    return;
  }
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { "x-postmark-server-token": key, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      From: from,
      To: mail.to,
      Subject: mail.subject,
      TextBody: mail.text,
      HtmlBody: mail.html,
      MessageStream: "outbound",
      ...(mail.headers ? { Headers: Object.entries(mail.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`The email provider refused the message (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

export async function emailSettings(): Promise<EmailSettings | null> {
  return getSetting("email");
}

export async function isEmailConfigured() {
  return !!(await emailSettings());
}

/** Send with the saved instance settings. */
export async function sendEmail(mail: OutgoingEmail) {
  const settings = await emailSettings();
  if (!settings) throw new EmailNotConfiguredError();
  await sendWith(settings, mail);
}
