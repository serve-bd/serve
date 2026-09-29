import path from "node:path";
import { env } from "@/server/env";

/** Host paths inside the Serve data directory. */
export const paths = {
  get root() {
    return env.dataDir;
  },
  get builds() {
    return path.join(env.dataDir, "builds");
  },
  service(serviceId: string) {
    return path.join(env.dataDir, "services", serviceId);
  },
  get proxy() {
    return path.join(env.dataDir, "proxy");
  },
  get proxySites() {
    return path.join(env.dataDir, "proxy", "sites");
  },
  /** Custom http-level directives, inside the mounted sites dir but not globbed by it. */
  get proxyCustom() {
    return path.join(env.dataDir, "proxy", "sites", "custom");
  },
  get proxyLogs() {
    return path.join(env.dataDir, "proxy", "logs");
  },
  get acme() {
    return path.join(env.dataDir, "acme");
  },
  get letsencrypt() {
    return path.join(env.dataDir, "letsencrypt");
  },
  get certs() {
    return path.join(env.dataDir, "certs");
  },
  get backups() {
    return path.join(env.dataDir, "backups");
  },
  get ssh() {
    return path.join(env.dataDir, "ssh");
  },
};

/** Paths as seen from inside the nginx proxy container. */
export const proxyPaths = {
  sites: "/etc/nginx/serve/sites",
  pages: "/etc/nginx/serve/pages",
  acme: "/var/www/acme",
  letsencrypt: "/etc/letsencrypt",
  certs: "/etc/serve/certs",
  logs: "/var/log/serve",
};
