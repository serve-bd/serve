/**
 * Where a server's proxy sends visitors of hostnames it does not know. The URL is written into
 * nginx, Caddy and Traefik config, so only URL characters that cannot break out of a quoted
 * string or start a variable are allowed: no whitespace, quotes, backslashes, braces, `$` or `;`.
 */
export const MAX_REDIRECT_URL = 2048;

const SAFE = /^https?:\/\/[A-Za-z0-9[][A-Za-z0-9\-._~:/?#[\]@!&()*+,=%]*$/i;

/** Why the URL cannot be used, or null when it can. */
export function redirectUrlError(value: string): string | null {
  if (!value) return "Enter a URL";
  if (value.length > MAX_REDIRECT_URL) return `Use at most ${MAX_REDIRECT_URL} characters`;
  if (!/^https?:\/\//i.test(value)) return "Use an http:// or https:// URL";
  if (!SAFE.test(value)) return "Remove spaces, quotes and the characters \\ { } $ ; < > ` ^ |";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a valid URL, like https://example.com";
  }
  if (!url.hostname) return "Enter a valid URL, like https://example.com";
  if (url.username || url.password) return "Remove the user name and password from the URL";
  return null;
}

/** The URL when it is safe to write into proxy config, else null. */
export const safeRedirectUrl = (value?: string | null) => (value && !redirectUrlError(value) ? value : null);
