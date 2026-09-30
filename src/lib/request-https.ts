/**
 * Whether a request reached the dashboard over HTTPS. Behind Serve's proxy that is its
 * X-Forwarded-Proto; a direct request (http://<ip>:8000 after install) has none and is plain HTTP.
 * A client that sends the header over plain HTTP only gets Secure cookies its browser then refuses.
 */
export function requestIsHttps(h: Headers | null | undefined) {
  return h?.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}
