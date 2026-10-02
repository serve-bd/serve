/**
 * Whether a request that changes something came from the dashboard's own pages, for routes
 * that go by the session cookie (a cookie is sent with a cross-site form post or fetch too).
 * Browsers send Origin on such requests and Sec-Fetch-Site in current versions; a page on
 * another site gets "cross-site" or "same-site" and an Origin that is not the address the
 * request was made to. Requests with neither header (curl, scripts) carry no browser cookie
 * by surprise and pass. `appUrl` is the install address, also accepted as an origin.
 */
export function crossSiteRequest(request: Request, appUrl?: string) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return true;
  }
  if (appUrl && URL.canParse(appUrl) && new URL(appUrl).origin === origin) return false;
  // The address the browser sent the request to: Serve's proxy, a custom domain or a tunnel keep it in Host or X-Forwarded-Host.
  // Compared as the Origin's host is written: lower case, without a default port.
  const hosts = [request.headers.get("x-forwarded-host"), request.headers.get("host")].flatMap((h) =>
    h
      ? h.split(",").map((v) =>
          v
            .trim()
            .toLowerCase()
            .replace(/:(80|443)$/, ""),
        )
      : [],
  );
  return !hosts.includes(host);
}
