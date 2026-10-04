import path from "node:path";
import { env } from "@/server/env";

/** Paths inside a server's data directory. */
export function pathsFor(dataDir: string) {
  return {
    root: dataDir,
    builds: path.posix.join(dataDir, "builds"),
    /** Project folders uploaded by the CLI (serve deploy), per service. */
    uploads: path.posix.join(dataDir, "uploads"),
    service: (serviceId: string) => path.posix.join(dataDir, "services", serviceId),
    proxy: path.posix.join(dataDir, "proxy"),
    proxySites: path.posix.join(dataDir, "proxy", "sites"),
    /** Custom http-level directives, inside the mounted sites dir but not globbed by it. */
    proxyCustom: path.posix.join(dataDir, "proxy", "sites", "custom"),
    proxyLogs: path.posix.join(dataDir, "proxy", "logs"),
    acme: path.posix.join(dataDir, "acme"),
    letsencrypt: path.posix.join(dataDir, "letsencrypt"),
    certs: path.posix.join(dataDir, "certs"),
    backups: path.posix.join(dataDir, "backups"),
    ssh: path.posix.join(dataDir, "ssh"),
    /** Build tools Serve downloads when first needed (Railpack). */
    tools: path.posix.join(dataDir, "tools"),
  };
}

export type ServerPaths = ReturnType<typeof pathsFor>;

/** Paths in the data directory of the machine Serve runs on. */
export const paths: ServerPaths = new Proxy({} as ServerPaths, {
  get: (_t, prop) => pathsFor(env.dataDir)[prop as keyof ServerPaths],
});

/** Paths as seen from inside the nginx proxy container. */
export const proxyPaths = {
  sites: "/etc/nginx/serve/sites",
  pages: "/etc/nginx/serve/pages",
  acme: "/var/www/acme",
  letsencrypt: "/etc/letsencrypt",
  certs: "/etc/serve/certs",
  logs: "/var/log/serve",
};
