/*
 * Databases on a domain. The server runs one database router that listens on each engine's usual
 * port and picks the database by the name the client sends in the TLS handshake (SNI). So many
 * databases share port 5432 on one server, told apart by their domains. Plain connections carry
 * no name and are not routed: clients connect with TLS.
 */

export type DomainRoute = {
  /** Router entry point name. */
  entry: string;
  /** Port clients connect to on the server. */
  port: number;
  /** Port of the database inside its container. */
  target: number;
  /** TLS application protocols the engine's clients ask for (PostgreSQL 17+ asks for "postgresql"). */
  alpn?: string[];
  label: string;
};

export const DOMAIN_ROUTES: Partial<Record<string, DomainRoute[]>> = {
  postgres: [{ entry: "postgres", port: 5432, target: 5432, alpn: ["postgresql"], label: "PostgreSQL" }],
  mongodb: [{ entry: "mongodb", port: 27017, target: 27017, label: "MongoDB" }],
  redis: [{ entry: "redis", port: 6379, target: 6379, label: "Redis" }],
  valkey: [{ entry: "redis", port: 6379, target: 6379, label: "Valkey" }],
  clickhouse: [
    { entry: "clickhouse", port: 9440, target: 9000, label: "ClickHouse native" },
    { entry: "clickhouse-https", port: 8443, target: 8123, label: "ClickHouse HTTPS" },
  ],
};

export const domainEngines = new Set(Object.keys(DOMAIN_ROUTES));

export const hostnamePattern = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The connection URL on the domain, for the engine's clients. */
export function domainUrl(engine: string, creds: { username: string; password: string; database: string }, hostname: string) {
  const user = encodeURIComponent(creds.username);
  const pass = encodeURIComponent(creds.password);
  switch (engine) {
    case "postgres":
      return `postgresql://${user}:${pass}@${hostname}/${encodeURIComponent(creds.database)}?sslmode=require`;
    case "mongodb":
      return `mongodb://${user}:${pass}@${hostname}/${encodeURIComponent(creds.database)}?authSource=admin&tls=true`;
    case "redis":
    case "valkey":
      return `rediss://default:${pass}@${hostname}:6379`;
    case "clickhouse":
      return `clickhouse://${user}:${pass}@${hostname}:9440/${encodeURIComponent(creds.database)}?secure=true`;
    default:
      return null;
  }
}
