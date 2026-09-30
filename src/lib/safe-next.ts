/**
 * A path on this dashboard to go to after signing in (`?next=`), or "/" for anything that could
 * lead elsewhere. Browsers read `\` as `/` and drop tabs and newlines, so `/\evil.com` would be
 * another site.
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(next)) return "/";
  try {
    const url = new URL(next, "http://dashboard.invalid");
    return url.origin === "http://dashboard.invalid" ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}
