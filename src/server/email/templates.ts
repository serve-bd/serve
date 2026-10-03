/** Plain, readable emails: one heading, a few paragraphs, an optional button. */
export type EmailContent = {
  brand: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  /** Small print under the button, e.g. "This link expires in 1 hour." */
  note?: string;
  /** Label and value rows under the paragraphs (a notification's details). */
  details?: { label: string; value: string }[];
  /** Preformatted text, like the end of an error. */
  code?: string | null;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const paragraphs = c.paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#3a3a3c">${esc(p)}</p>`).join("");
  const button = c.action
    ? `<p style="margin:22px 0"><a href="${esc(c.action.url)}" style="display:inline-block;background:#0a84ff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:10px">${esc(c.action.label)}</a></p>` +
      `<p style="margin:0 0 14px;font-size:12px;line-height:1.5;color:#8e8e93">Or open this link: <a href="${esc(c.action.url)}" style="color:#0a84ff;word-break:break-all">${esc(c.action.url)}</a></p>`
    : "";
  const details = c.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 14px;border-top:1px solid #e5e5ea">${c.details
        .map(
          (d) =>
            `<tr><td style="padding:7px 12px 7px 0;border-bottom:1px solid #e5e5ea;font-size:13px;color:#8e8e93;white-space:nowrap;vertical-align:top">${esc(d.label)}</td><td style="padding:7px 0;border-bottom:1px solid #e5e5ea;font-size:13px;color:#1c1c1e;word-break:break-word">${esc(d.value)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const code = c.code
    ? `<pre style="margin:0 0 14px;padding:12px;background:#f5f5f7;border-radius:10px;font-size:12px;line-height:1.5;color:#1c1c1e;white-space:pre-wrap;word-break:break-word">${esc(c.code)}</pre>`
    : "";
  const note = c.note ? `<p style="margin:0 0 14px;font-size:12px;line-height:1.5;color:#8e8e93">${esc(c.note)}</p>` : "";
  const html = [
    `<!doctype html><html><body style="margin:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:32px 12px"><tr><td align="center">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e5e5ea">`,
    `<tr><td style="padding:28px 28px 8px"><p style="margin:0 0 18px;font-size:13px;font-weight:600;color:#8e8e93">${esc(c.brand)}</p>`,
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#1c1c1e">${esc(c.heading)}</h1>${paragraphs}${details}${code}${button}${note}</td></tr>`,
    `</table><p style="margin:16px 0 0;font-size:11px;color:#aeaeb2">Sent by ${esc(c.brand)}</p>`,
    `</td></tr></table></body></html>`,
  ].join("\n");
  const text = [
    c.heading,
    "",
    ...c.paragraphs.flatMap((p) => [p, ""]),
    ...(c.details?.length ? [...c.details.map((d) => `${d.label}: ${d.value}`), ""] : []),
    ...(c.code ? [c.code, ""] : []),
    ...(c.action ? [`${c.action.label}: ${c.action.url}`, ""] : []),
    ...(c.note ? [c.note, ""] : []),
    `— ${c.brand}`,
  ].join("\n");
  return { html, text };
}
