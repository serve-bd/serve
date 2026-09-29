import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn((_opts: Record<string, unknown>) => ({ sendMail }));
vi.mock("server-only", () => ({}));
vi.mock("nodemailer", () => ({ default: { createTransport: (opts: Record<string, unknown>) => createTransport(opts) } }));
vi.mock("@/server/settings", () => ({ getSetting: vi.fn() }));
vi.mock("@/server/crypto", () => ({ decryptOrNull: (v: string | null) => (v ? v.replace(/^enc:/, "") : null) }));

import { emailSettingsInput, fromHeader } from "@/server/email/config";
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

  it("calls the Resend API with the key", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendWith({ provider: "resend", fromName: "Serve", fromAddress: "s@e.co", apiKey: "enc:re_123" }, { to: "x@e.co", subject: "s", text: "t" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_123");
    vi.unstubAllGlobals();
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
