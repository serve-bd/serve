const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Point a copied variable value at the copied services: service slugs (in `${{slug.KEY}}`
 * references and in literal hostnames) and database passwords that changed.
 */
export function rewriteValue(value: string, slugs: Map<string, string>, passwords: Map<string, string>) {
  let out = value;
  for (const [from, to] of slugs) {
    // Whole slugs only: `app-x1` must not match inside `app-x12`.
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9-])${escapeRe(from)}(?![A-Za-z0-9-])`, "g"), `$1${to}`);
  }
  for (const [from, to] of passwords) if (from.length >= 12) out = out.split(from).join(to);
  return out;
}
