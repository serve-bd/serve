/*
 * Databases on a domain. Directly: the database publishes its own port and speaks TLS itself,
 * with the domain's certificate. Through a Cloudflare Tunnel: Cloudflare carries the connection
 * to the database's port on the private network, and no port is opened on the server.
 */

export const hostnamePattern = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Port a tunnel leads to inside the database's container: ClickHouse's native protocol, the engine's own port otherwise. */
export function tunnelTargetPort(engine: string, enginePort: number) {
  return engine === "clickhouse" ? 9000 : enginePort;
}
