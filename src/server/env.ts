import path from "node:path";

const building = process.env.NEXT_PHASE === "phase-production-build";

function required(name: string): string {
  const value = process.env[name];
  if (value) return value;
  // `next build` evaluates route modules; real values are only needed at runtime.
  if (building) return `build-placeholder-${name.toLowerCase()}`;
  throw new Error(`Missing required environment variable ${name}`);
}

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get authSecret() {
    return required("BETTER_AUTH_SECRET");
  },
  get appUrl() {
    return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  },
  get encryptionKey() {
    return process.env.SERVE_ENCRYPTION_KEY ?? required("BETTER_AUTH_SECRET");
  },
  /** Absolute host path where Serve stores all of its state. */
  get dataDir() {
    return path.resolve(process.env.SERVE_DATA_DIR ?? "/data/serve");
  },
  get network() {
    return process.env.SERVE_NETWORK ?? "serve";
  },
  get proxyContainer() {
    return process.env.SERVE_PROXY_CONTAINER ?? "serve-proxy";
  },
  get proxyHttpPort() {
    return Number(process.env.SERVE_PROXY_HTTP_PORT ?? 80);
  },
  get proxyHttpsPort() {
    return Number(process.env.SERVE_PROXY_HTTPS_PORT ?? 443);
  },
  /** Upstream the proxy uses for the dashboard domain. */
  get dashboardUpstream() {
    return process.env.SERVE_DASHBOARD_UPSTREAM ?? "serve:3000";
  },
  get dockerSocket() {
    return process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
  },
};
