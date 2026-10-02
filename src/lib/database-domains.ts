/*
 * Databases on a domain. Directly: the database publishes its own port and speaks TLS itself,
 * with the domain's certificate. Through a Cloudflare Tunnel: Cloudflare carries the connection
 * to the database's port on the private network, and no port is opened on the server.
 */

export const hostnamePattern = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Port a tunnel leads to inside the database's container: the engine's own port (for ClickHouse its HTTP one, like every other URL Serve shows). */
export function tunnelTargetPort(_engine: string, enginePort: number) {
  return enginePort;
}

/** Marks the DNS records Serve creates for database domains, so it only ever removes its own. */
export const DATABASE_DNS_COMMENT = "Serve database domain";
