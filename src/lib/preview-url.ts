/**
 * Preview URL templates: a host name with {pr} in its first label, like pr-{pr}.example.com or
 * {pr}.app.example.com. {pr} becomes the pull request number. One wildcard record (*.example.com)
 * covers every preview, which is why {pr} must sit in the first label.
 */
export function normalizePreviewTemplate(raw: string | null | undefined) {
  const t = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "")
    // Other spellings people know from elsewhere.
    .replace(/\{\{\s*(pr|pr_id|pr_number|pull_request)\s*\}\}|\{(pr_id|pr_number)\}/g, "{pr}")
    // A plain wildcard domain: pr-<number> in front.
    .replace(/^\*\./, "pr-{pr}.");
  return t;
}

/** Why a template cannot be used, or null. */
export function previewTemplateProblem(template: string) {
  if (!template) return null;
  const first = template.split(".")[0];
  if (template.split("{pr}").length !== 2 || !first.includes("{pr}")) return "Put {pr} once, in the first part, like pr-{pr}.example.com.";
  const sample = template.replace("{pr}", "123");
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(sample)) return "Enter a host name like pr-{pr}.example.com.";
  return null;
}

export function previewHostname(template: string, pr: number) {
  return template.replace("{pr}", String(pr));
}
