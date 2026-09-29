import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn((_opts: Record<string, unknown>) => ({ sendMail }));
vi.mock("server-only", () => ({}));
vi.mock("nodemailer", () => ({ default: { createTransport: (opts: Record<string, unknown>) => createTransport(opts) } }));
const resendSend = vi.fn(async (_mail: Record<string, unknown>) => ({ data: { id: "e1" } as { id: string } | null, error: null as { message: string } | null }));
const resendCtor = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
    constructor(key: string) {
      resendCtor(key);
    }
  },
}));
const publicRequest = vi.fn(async (_url: string, _opts: Record<string, unknown>) => ({ status: 202, headers: {}, text: "{}" }));
vi.mock("@/server/net/public-fetch", () => ({ publicRequest: (url: string, opts: Record<string, unknown>) => publicRequest(url, opts) }));
vi.mock("@/server/settings", () => ({ getSetting: vi.fn() }));
vi.mock("@/server/crypto", () => ({ decryptOrNull: (v: string | null) => (v ? v.replace(/^enc:/, "") : null) }));

import { emailSettingsInput, fromHeader, mailroomBase } from "@/server/email/config";
import { renderEmail } from "@/server/email/templates";
import { sendWith } from "@/server/email/send";

describe("renderEmail", () => {
  it("escapes content and includes a plain text version", () => {
    const { html, text } = renderEmail({
      brand: "Serve",
      heading: "Reset <b>now</b>",
      paragraphs: ['Hi "you"', "Second & last"],
      action: { label: "Open", url: "https://serve.example.com/reset?token=a&b=1" },
      note: "Expires in 1 hour.",
    });
    expect(html).toContain("Reset &lt;b&gt;now&lt;/b&gt;");
    expect(html).not.toContain("<b>now</b>");
    expect(html).toContain("Hi &quot;you&quot;");
    expect(html).toContain('href="https://serve.example.com/reset?token=a&amp;b=1"');
    expect(text).toContain("Reset <b>now</b>");
    expect(text).toContain("Open: https://serve.example.com/reset?token=a&b=1");
    expect(text).toContain("Expires in 1 hour.");
    expect(text.trim().endsWith("— Serve")).toBe(true);
  });
});

describe("email settings", () => {
  it("requires host and port for SMTP", () => {
    const r = emailSettingsInput.safeParse({ provider: "smtp", fromAddress: "serve@example.com" });
    expect(r.success).toBe(false);
    const ok = emailSettingsInput.safeParse({ provider: "smtp", fromAddress: "serve@example.com", smtpHost: "smtp.example.com", smtpPort: 587 });
    expect(ok.success).toBe(true);
  });
  it("rejects a bad from address and hostnames with spaces", () => {
    expect(emailSettingsInput.safeParse({ provider: "resend", fromAddress: "nope" }).success).toBe(false);
    expect(emailSettingsInput.safeParse({ provider: "smtp", fromAddress: "a@b.co", smtpHost: "smtp example", smtpPort: 25 }).success).toBe(false);
  });
  it("builds a safe From header", () => {
    expect(fromHeader({ fromName: "", fromAddress: "a@b.co" })).toBe("a@b.co");
    expect(fromHeader({ fromName: 'Serve "Ops"\r\nBcc: x', fromAddress: "a@b.co" })).toBe('"Serve OpsBcc: x" <a@b.co>');
  });
});

describe("sendWith", () => {
  beforeEach(() => {
    sendMail.mockReset();
    createTransport.mockClear();
  });

  it("uses STARTTLS on 587 with the decrypted password", async () => {
    await sendWith(
      {
        provider: "smtp",
        fromName: "Serve",
        fromAddress: "serve@example.com",
        smtp: { host: "smtp.example.com", port: 587, security: "starttls", username: "u", password: "enc:pw" },
      },
      { to: "x@example.com", subject: "Hi", text: "Hello" },
    );
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.example.com", port: 587, secure: false, requireTLS: true, auth: { user: "u", pass: "pw" } }),
    );
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: '"Serve" <serve@example.com>', to: "x@example.com", subject: "Hi" }));
  });

  it("uses implicit TLS and no auth without a username", async () => {
    await sendWith({ provider: "smtp", fromName: "", fromAddress: "s@e.co", smtp: { host: "h.e.co", port: 465, security: "tls" } }, { to: "x@e.co", subject: "s", text: "t" });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true, auth: undefined }));
  });

  it("sends through the Resend SDK with the key", async () => {
    await sendWith({ provider: "resend", fromName: "Serve", fromAddress: "s@e.co", apiKey: "enc:re_123" }, { to: "x@e.co", subject: "s", text: "t" });
    expect(resendCtor).toHaveBeenCalledWith("re_123");
    expect(resendSend).toHaveBeenCalledWith(expect.objectContaining({ from: '"Serve" <s@e.co>', to: ["x@e.co"], subject: "s" }));
  });

  it("reports Resend errors", async () => {
    resendSend.mockResolvedValueOnce({ data: null, error: { message: "invalid key" } });
    await expect(sendWith({ provider: "resend", fromName: "", fromAddress: "s@e.co", apiKey: "enc:k" }, { to: "x@e.co", subject: "s", text: "t" })).rejects.toThrow(/invalid key/);
  });

  it("sends through the Mailroom API", async () => {
    await sendWith(
      { provider: "mailroom", fromName: "Serve", fromAddress: "s@e.co", apiKey: "enc:mk_live_1", baseUrl: "https://mail.e.co" },
      { to: "x@e.co", subject: "s", text: "t" },
    );
    const [url, opts] = publicRequest.mock.calls[0];
    expect(url).toBe("https://mail.e.co/api/v1/emails");
    expect((opts.headers as Record<string, string>).authorization).toBe("Bearer mk_live_1");
    expect(JSON.parse(opts.body as string)).toMatchObject({ from: '"Serve" <s@e.co>', to: ["x@e.co"], subject: "s" });
  });

  it("reports Mailroom errors", async () => {
    publicRequest.mockResolvedValueOnce({ status: 422, headers: {}, text: JSON.stringify({ error: "The from domain is not verified", code: "invalid_request" }) });
    await expect(
      sendWith({ provider: "mailroom", fromName: "", fromAddress: "s@e.co", apiKey: "enc:k", baseUrl: "https://mail.e.co" }, { to: "x@e.co", subject: "s", text: "t" }),
    ).rejects.toThrow(/not verified/);
  });

  it("normalizes the Mailroom address", () => {
    expect(mailroomBase("https://mail.e.co/api/v1/")).toBe("https://mail.e.co");
    expect(mailroomBase("ftp://x")).toBeNull();
  });

  it("reports provider errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad token", { status: 401 })),
    );
    await expect(sendWith({ provider: "postmark", fromName: "", fromAddress: "s@e.co", apiKey: "enc:k" }, { to: "x@e.co", subject: "s", text: "t" })).rejects.toThrow(/HTTP 401/);
    vi.unstubAllGlobals();
  });
});
