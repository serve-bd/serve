/**
 * Private network between servers (WireGuard).
 * - 10.240.0.0/16: one address per exposed service, handed out once and kept for good, so it
 *   stays the same when the service moves to another server (only the route changes).
 * - 10.241.N.0/24: server slot N. 10.241.N.1 is the server itself, the rest are the source
 *   addresses of the environments whose containers reach other servers.
 * Serve's other ranges (10.192-10.219 for Docker networks) never overlap them.
 */
export const MESH_ROUTES = ["10.240.0.0/15"];
export const MESH_DEFAULT_PORT = 51820;
export const MESH_MAX_SERVERS = 254;
export const MESH_MTU = 1420;
/** WireGuard inside Tailscale (MTU 1280, minus 60 bytes of WireGuard over IPv4, with room to spare). */
export const MESH_TAILNET_MTU = 1200;

export const meshServerAddress = (index: number) => `10.241.${index}.1`;
export const meshServerRange = (index: number) => `10.241.${index}.0/24`;

/** "host:port" for WireGuard, with brackets around IPv6 addresses. */
export function meshEndpoint(host: string, port: number) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/** Why an address cannot be the one other servers connect to, or null when it can. */
export function meshEndpointProblem(host: string): string | null {
  const h = host.trim();
  if (!h) return "Enter the address the other servers reach this one at.";
  if (!(IPV4.test(h) || (h.includes(":") && IPV6.test(h)) || HOSTNAME.test(h))) return "Enter an IP address or a host name, without a port.";
  if (/^(localhost|127\.|0\.0\.0\.0$|::1?$)/i.test(h)) return "This address only works on the server itself. Enter an address the other servers can reach.";
  return null;
}

/** Relative "12s ago" for a handshake time in seconds since the epoch (0 = never). */
export function handshakeAge(latest: number, now = Date.now() / 1000) {
  if (!latest) return null;
  const s = Math.max(0, Math.round(now - latest));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** WireGuard renegotiates every 2 minutes while a link is alive; 3 minutes of silence means down. */
export const MESH_LINK_TIMEOUT = 180;
