import { z } from "zod";

/** How Serve sends email. Secrets (SMTP password, API key) are stored encrypted. */
export type EmailSettings = {
  provider: "smtp" | "resend" | "postmark" | "mailroom";
  fromName: string;
  fromAddress: string;
  smtp?: {
    host: string;
    port: number;
    /** none: plain; starttls: upgrade on 587; tls: implicit TLS on 465. */
    security: "none" | "starttls" | "tls";
    username?: string | null;
    /** Encrypted. */
    password?: string | null;
  } | null;
  /** Encrypted API key for HTTP providers. */
  apiKey?: string | null;
  /** Mailroom instance, like https://mail.example.com. */
  baseUrl?: string | null;
};

const smtpHost = z
  .string()
  .trim()
  .min(1, "Enter the SMTP host")
  .regex(/^[a-z0-9.-]+$/i, "Enter a hostname like smtp.example.com");

/** Input from the settings form. Empty secret fields keep the stored value. */
export const emailSettingsInput = z
  .object({
    provider: z.enum(["smtp", "resend", "postmark", "mailroom"]),
    fromName: z.string().trim().max(80).default(""),
    fromAddress: z.email("Enter the address emails come from"),
    smtpHost: z.string().trim().optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpSecurity: z.enum(["none", "starttls", "tls"]).optional(),
    smtpUsername: z.string().trim().max(200).optional(),
    smtpPassword: z.string().max(500).optional(),
    apiKey: z.string().trim().max(500).optional(),
    baseUrl: z.string().trim().max(300).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.provider === "smtp") {
      const parsed = smtpHost.safeParse(v.smtpHost ?? "");
      if (!parsed.success) ctx.addIssue({ code: "custom", path: ["smtpHost"], message: parsed.error.issues[0].message });
      if (!v.smtpPort) ctx.addIssue({ code: "custom", path: ["smtpPort"], message: "Enter the SMTP port" });
    }
    if (v.provider === "mailroom" && !mailroomBase(v.baseUrl ?? "")) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Enter the Mailroom address, like https://mail.example.com" });
    }
  });

export type EmailSettingsInput = z.input<typeof emailSettingsInput>;

/** Default port for each security mode. */
export const defaultSmtpPort = { none: 25, starttls: 587, tls: 465 } as const;

/** The "From" header: `"Name" <address>` or just the address. */
export function fromHeader(s: Pick<EmailSettings, "fromName" | "fromAddress">) {
  const name = s.fromName.replace(/["\r\n<>]/g, "").trim();
  return name ? `"${name}" <${s.fromAddress}>` : s.fromAddress;
}

/** Normalized Mailroom base URL (origin plus any path, no trailing slash, no /api/v1), or null when invalid. */
export function mailroomBase(raw: string) {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "")}`;
  } catch {
    return null;
  }
}
