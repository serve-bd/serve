import { z } from "zod";
import { redirectUrlError, safeRedirectUrl } from "@/lib/unknown-redirect";
import { PROXY_IMAGE } from "./templates";

/**
 * Which reverse proxy a server runs, and its global settings. Settings for
 * every kind are kept, so switching back restores the previous setup.
 */
export type ProxyKind = "nginx" | "caddy" | "traefik" | "none";
export const PROXY_KINDS: ProxyKind[] = ["nginx", "caddy", "traefik", "none"];
/** Kinds that run a proxy container. */
export type RunningKind = Exclude<ProxyKind, "none">;

/** A configuration file an admin added (stored in the database, written to disk on every sync). */
export type ProxyFile = { name: string; content: string };

/** Built-ins that can be switched off so custom files take over. All default to on. */
export type ProxyDefaults = {
  /** Serve's 404 page for unknown hosts. */
  catchAll?: boolean;
  /** With the catch-all on: a 302 redirect to this URL for unknown hosts instead of the 404 page. */
  unknownRedirect?: string | null;
  /** Serve's 503 page for stopped or unreachable services. */
  unavailablePage?: boolean;
  /** Caddy's automatic HTTP→HTTPS redirects / a Traefik entry point redirect for every request. */
  httpsRedirect?: boolean;
};

/** Changes to the proxy container itself. Environment values are stored encrypted. */
export type ProxyContainerOverrides = {
  image?: string | null;
  args?: string[];
  env?: { name: string; value: string }[];
  volumes?: string[];
  ports?: string[];
};

type Common = { files?: ProxyFile[]; defaults?: ProxyDefaults; container?: ProxyContainerOverrides };

/** Request body limit nginx uses when the server sets none. */
export const DEFAULT_MAX_BODY_SIZE = "100m";

export type NginxSettings = {
  workerConnections?: number | null;
  /** This server's request body limit, like "100m" (DEFAULT_MAX_BODY_SIZE when unset). */
  maxBodySize?: string | null;
  keepaliveTimeout?: number | null;
  proxyConnectTimeout?: number | null;
  proxyReadTimeout?: number | null;
  gzipLevel?: number | null;
  serverTokens?: boolean;
} & Common;

export type CaddySettings = {
  /** ACME account email; falls back to the Let's Encrypt email in Settings. */
  email?: string | null;
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  http3?: boolean;
  readTimeout?: number | null;
  writeTimeout?: number | null;
  idleTimeout?: number | null;
  /** Extra lines inside the global options block. */
  rawGlobal?: string | null;
} & Common;

export type TraefikSettings = {
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  accessLog?: boolean;
  metrics?: boolean;
  dashboard?: { enabled: boolean; hostname: string; username: string; passwordHash: string } | null;
  acmeChallenge?: "http" | "tls" | "dns-cloudflare";
  cloudflareAccountId?: string | null;
} & Common;

export type ServerProxyConfig = { nginx?: NginxSettings; caddy?: CaddySettings; traefik?: TraefikSettings };

export type ProxySwitchState = {
  state: "running" | "success" | "failed";
  from: ProxyKind;
  to: ProxyKind;
  startedAt: string;
  finishedAt?: string | null;
  error?: string | null;
  log: string;
};

export const proxyImages: Record<RunningKind, string> = {
  nginx: PROXY_IMAGE,
  caddy: process.env.SERVE_CADDY_IMAGE ?? "caddy:2.11.4-alpine",
  traefik: process.env.SERVE_TRAEFIK_IMAGE ?? "traefik:v3.7.13",
};

export const proxyLabels: Record<ProxyKind, string> = { nginx: "nginx", caddy: "Caddy", traefik: "Traefik", none: "No proxy" };

/** File name rules for custom files of each kind (on disk they get a "user-" prefix). */
export const customFilePattern: Record<RunningKind, RegExp> = {
  nginx: /^[a-z0-9][a-z0-9._-]{0,60}\.conf$/,
  caddy: /^[a-z0-9][a-z0-9._-]{0,60}\.caddy$/,
  traefik: /^[a-z0-9][a-z0-9._-]{0,60}\.ya?ml$/,
};

export const defaultsOf = (d?: ProxyDefaults): Required<ProxyDefaults> => ({
  catchAll: d?.catchAll !== false,
  unknownRedirect: safeRedirectUrl(d?.unknownRedirect),
  unavailablePage: d?.unavailablePage !== false,
  httpsRedirect: d?.httpsRedirect !== false,
});

/* -------------------------------------------------------------------------- */
/*                                 Validation                                 */
/* -------------------------------------------------------------------------- */

const seconds = (max: number) => z.number().int().min(1).max(max).nullable().optional();
/** One-line raw text must not break out of the generated file's structure. */
const noNul = (v: string) => !v.includes("\u0000");

export const proxyDefaultsSchema = z.object({
  catchAll: z.boolean().optional(),
  unknownRedirect: z
    .string()
    .trim()
    .superRefine((v, c) => {
      const error = v ? redirectUrlError(v) : null;
      if (error) c.addIssue({ code: "custom", message: error });
    })
    .transform((v) => v || null)
    .nullable()
    .optional(),
  unavailablePage: z.boolean().optional(),
  httpsRedirect: z.boolean().optional(),
});

function balanced(text: string) {
  let depth = 0;
  for (const ch of text) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

export const nginxSettingsSchema = z.object({
  workerConnections: z.number().int().min(256).max(262_144).nullable().optional(),
  maxBodySize: z
    .string()
    .trim()
    .regex(/^\d{1,6}[kmg]?$/i, "Use a size like 100m")
    .nullable()
    .optional(),
  keepaliveTimeout: seconds(3600),
  proxyConnectTimeout: seconds(3600),
  proxyReadTimeout: seconds(86_400),
  gzipLevel: z.number().int().min(1).max(9).nullable().optional(),
  serverTokens: z.boolean().optional(),
  defaults: proxyDefaultsSchema.optional(),
});

export const caddySettingsSchema = z.object({
  email: z
    .union([z.email("Enter a valid email"), z.literal("")])
    .nullable()
    .optional(),
  logLevel: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).optional(),
  http3: z.boolean().optional(),
  readTimeout: seconds(86_400),
  writeTimeout: seconds(86_400),
  idleTimeout: seconds(86_400),
  rawGlobal: z.string().max(20_000).refine(noNul).refine(balanced, "Braces { } must be balanced").nullable().optional(),
  defaults: proxyDefaultsSchema.optional(),
});

export const traefikSettingsSchema = z.object({
  logLevel: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).optional(),
  accessLog: z.boolean().optional(),
  metrics: z.boolean().optional(),
  dashboard: z
    .object({
      enabled: z.boolean(),
      hostname: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a hostname like traefik.example.com")
        .optional(),
      username: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._@-]{1,64}$/, "Use letters, digits, . _ @ or -")
        .optional(),
      password: z.string().min(8, "Use at least 8 characters").max(128).optional(),
    })
    .optional(),
  acmeChallenge: z.enum(["http", "tls", "dns-cloudflare"]).optional(),
  cloudflareAccountId: z.string().nullable().optional(),
  defaults: proxyDefaultsSchema.optional(),
});

export const proxyFileSchema = z.object({
  name: z.string().trim().toLowerCase(),
  content: z.string().max(100_000).refine(noNul, "The file contains invalid characters"),
});

const envName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const containerOverridesSchema = z.object({
  image: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._/:@-]{0,200}$/i, "Use an image like caddy:2.10-alpine")
    .nullable()
    .optional(),
  args: z
    .array(
      z
        .string()
        .max(500)
        .refine((a) => !/[\n\r\0]/.test(a), "One argument per line"),
    )
    .max(50)
    .optional(),
  /** `value` empty keeps the stored (encrypted) value of a variable with the same name. */
  env: z
    .array(z.object({ name: z.string().trim().regex(envName, "Variable names use letters, digits and _"), value: z.string().max(10_000) }))
    .max(50)
    .optional(),
  volumes: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[^:\s]+:\/[^:\s]*(:(ro|rw))?$/, "Use host-or-volume:/container/path[:ro]"),
    )
    .max(20)
    .optional(),
  ports: z
    .array(
      z
        .string()
        .trim()
        .regex(/^(\d{1,3}(\.\d{1,3}){3}:)?\d{1,5}:\d{1,5}(\/(tcp|udp))?$/, "Use host:container[/udp], like 8404:8404"),
    )
    .max(20)
    .optional(),
});

/** Nginx size ("10m", "1g", "512k", "1024") as Caddy/Traefik understand it. */
export function sizeToBytes(size: string) {
  const m = /^(\d+)([kmg]?)$/i.exec(size.trim());
  if (!m) return null;
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as "" | "k" | "m" | "g"];
  return Number(m[1]) * mult;
}
