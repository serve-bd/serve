import crypto from "node:crypto";
import net from "node:net";
import bcrypt from "bcryptjs";
import YAML from "yaml";
import { z } from "zod";

/**
 * Per-service HTTP options applied in the service's nginx site. Every field is
 * optional; leaving it out keeps the server-wide default behaviour.
 */
export type ServiceProxyConfig = {
  /** Largest request body, like "100m". Overrides the server default. */
  maxBodySize?: string | null;
  /** Seconds to wait for the app to accept a connection. */
  connectTimeout?: number | null;
  /** Seconds a read or write to the app may take (long polling, SSE, uploads). */
  readTimeout?: number | null;
  /** Upgrade connections to WebSockets (default on). */
  websockets?: boolean;
  /** Buffer responses (default on). Turn off for streaming and server-sent events. */
  buffering?: boolean;
  /** Send each visitor to the same replica every time (Socket.IO, in-memory sessions). */
  sticky?: boolean;
  /**
   * HTTP Basic Auth. nginx and Traefik verify the apr1 hash; Caddy needs bcrypt,
   * which is stored too whenever a password is set (older configs lack it).
   */
  basicAuth?: { username: string; passwordHash: string; bcryptHash?: string | null } | null;
  /** Only these IPs / CIDR ranges may connect. */
  allow?: string[];
  /** These IPs / CIDR ranges are refused. */
  deny?: string[];
  /** Extra response headers. */
  headers?: { name: string; value: string }[];
  /** Adds X-Content-Type-Options, Referrer-Policy, X-Frame-Options (and HSTS over HTTPS). */
  securityHeaders?: boolean;
  /** CORS: "*" or exact origins like https://app.example.com. */
  corsOrigins?: string[];
  /** Redirect between www and the bare domain when both are added to this service. */
  wwwRedirect?: "none" | "to-apex" | "to-www";
  /** Compress responses (default on). */
  gzip?: boolean;
  /** Long browser caching for static files (css, js, images, fonts). */
  cacheStatic?: boolean;
  /** Raw nginx directives inside the service's location block. Root admins only. */
  customDirectives?: string | null;
  /** Raw Caddyfile directives inside the service's route block. Root admins only. */
  caddyDirectives?: string | null;
  /** Extra Traefik middlewares (YAML map of name → middleware) attached to the service's routers. Root admins only. */
  traefikMiddlewares?: string | null;
};

/* -------------------------------------------------------------------------- */
/*                                 Validation                                 */
/* -------------------------------------------------------------------------- */

/** IPv4/IPv6 address with an optional prefix length in range. */
export function isCidr(value: string) {
  const [addr, prefix, extra] = value.split("/");
  if (extra !== undefined) return false;
  const version = net.isIP(addr);
  if (!version) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

/** Header names nginx or the proxy manage themselves. */
const RESERVED_HEADERS = new Set(["content-length", "transfer-encoding", "connection", "upgrade", "host", "keep-alive"]);

const cidr = z.string().trim().refine(isCidr, "Use an IP address or CIDR range like 203.0.113.0/24");

const headerName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "Header names may use letters, digits and dashes")
  .refine((n) => !RESERVED_HEADERS.has(n.toLowerCase()), "This header is managed by the proxy");

// Printable ASCII without quotes, backslashes or "$" (nginx variables): the value goes inside "…".
const headerValue = z
  .string()
  .max(512)
  .regex(/^[\x20-\x7e]*$/, "Header values must be plain text on one line")
  // Braces and backticks: Caddy placeholders ({env.X}, {file.…}) and Traefik templates would run.
  .refine((v) => !/["\\${}`]/.test(v), 'Header values cannot contain ", \\, $, braces or backticks');

const origin = z
  .string()
  .trim()
  .refine((v) => v === "*" || /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(v), "Use * or an origin like https://app.example.com");

/** Balanced braces keep custom directives inside the location block. */
function balanced(text: string) {
  let depth = 0;
  for (const ch of text) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

/** What the dashboard sends. `basicAuth.password` is optional to keep the saved one. */
export const proxyInputSchema = z.object({
  maxBodySize: z
    .string()
    .trim()
    .regex(/^\d{1,6}[kmg]?$/i, "Use a size like 10m or 1g")
    .nullable()
    .optional(),
  connectTimeout: z.number().int().min(1).max(3600).nullable().optional(),
  readTimeout: z.number().int().min(1).max(86_400).nullable().optional(),
  websockets: z.boolean().optional(),
  buffering: z.boolean().optional(),
  sticky: z.boolean().optional(),
  basicAuth: z
    .object({
      enabled: z.boolean(),
      username: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._@-]{1,64}$/, "Use letters, digits, . _ @ or - in the user name")
        .optional(),
      password: z.string().min(6, "Use at least 6 characters").max(128).optional(),
    })
    .optional(),
  allow: z.array(cidr).max(100).optional(),
  deny: z.array(cidr).max(100).optional(),
  headers: z
    .array(z.object({ name: headerName, value: headerValue }))
    .max(30)
    .optional(),
  securityHeaders: z.boolean().optional(),
  corsOrigins: z.array(origin).max(30).optional(),
  wwwRedirect: z.enum(["none", "to-apex", "to-www"]).optional(),
  gzip: z.boolean().optional(),
  cacheStatic: z.boolean().optional(),
  customDirectives: z.string().max(10_000).refine(balanced, "Braces { } must be balanced").nullable().optional(),
  caddyDirectives: z.string().max(10_000).refine(balanced, "Braces { } must be balanced").nullable().optional(),
  traefikMiddlewares: z.string().max(20_000).refine(isMiddlewareYaml, "Use a YAML map of middleware names to Traefik middleware definitions").nullable().optional(),
});

/** A YAML mapping of middleware names (letters, digits, dashes) to objects. */
export function isMiddlewareYaml(text: string) {
  if (!text.trim()) return true;
  try {
    const doc = YAML.parse(text);
    return (
      !!doc &&
      typeof doc === "object" &&
      !Array.isArray(doc) &&
      Object.entries(doc).every(([k, v]) => /^[A-Za-z0-9-]{1,40}$/.test(k) && !!v && typeof v === "object" && !Array.isArray(v))
    );
  } catch {
    return false;
  }
}

export type ProxyInput = z.input<typeof proxyInputSchema>;

/** Turn validated input into the stored config, keeping the saved password when none is given. */
export function buildProxyConfig(input: z.output<typeof proxyInputSchema>, previous: ServiceProxyConfig | null): ServiceProxyConfig {
  let basicAuth: ServiceProxyConfig["basicAuth"] = null;
  if (input.basicAuth?.enabled) {
    const username = input.basicAuth.username;
    if (!username) throw new Error("Enter a user name for basic auth.");
    const keep = previous?.basicAuth && previous.basicAuth.username === username && !input.basicAuth.password;
    if (!input.basicAuth.password && !keep) throw new Error("Enter a password for basic auth.");
    basicAuth = keep ? { ...previous!.basicAuth! } : { username, passwordHash: apr1(input.basicAuth.password!), bcryptHash: bcrypt.hashSync(input.basicAuth.password!, 10) };
  }
  const headers = (input.headers ?? []).filter((h) => h.name);
  const names = new Set<string>();
  for (const h of headers) {
    const key = h.name.toLowerCase();
    if (names.has(key)) throw new Error(`The header ${h.name} is listed twice.`);
    names.add(key);
  }
  return {
    maxBodySize: input.maxBodySize || null,
    connectTimeout: input.connectTimeout ?? null,
    readTimeout: input.readTimeout ?? null,
    websockets: input.websockets ?? true,
    buffering: input.buffering ?? true,
    sticky: input.sticky ?? false,
    basicAuth,
    allow: input.allow ?? [],
    deny: input.deny ?? [],
    headers,
    securityHeaders: input.securityHeaders ?? false,
    corsOrigins: input.corsOrigins ?? [],
    wwwRedirect: input.wwwRedirect ?? "none",
    gzip: input.gzip ?? true,
    cacheStatic: input.cacheStatic ?? false,
    // Left out (a form for another proxy, an API call without it): the saved value stays.
    customDirectives: input.customDirectives === undefined ? (previous?.customDirectives ?? null) : input.customDirectives?.trim() || null,
    caddyDirectives: input.caddyDirectives === undefined ? (previous?.caddyDirectives ?? null) : input.caddyDirectives?.trim() || null,
    traefikMiddlewares: input.traefikMiddlewares === undefined ? (previous?.traefikMiddlewares ?? null) : input.traefikMiddlewares?.trim() || null,
  };
}

/* -------------------------------------------------------------------------- */
/*                         apr1 (Apache MD5) password hash                    */
/* -------------------------------------------------------------------------- */

const ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function to64(value: number, length: number) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ITOA64[value & 0x3f];
    value >>>= 6;
  }
  return out;
}

/** htpasswd -m compatible hash; nginx verifies "$apr1$" itself on every platform. */
export function apr1(
  password: string,
  salt = crypto
    .randomBytes(6)
    .toString("base64")
    .replace(/[^A-Za-z0-9./]/g, ".")
    .slice(0, 8),
) {
  const magic = "$apr1$";
  const pw = Buffer.from(password, "utf8");
  const s = Buffer.from(salt, "utf8");
  const md5 = (...parts: Buffer[]) => crypto.createHash("md5").update(Buffer.concat(parts)).digest();

  let final = md5(pw, s, pw);
  const ctx: Buffer[] = [pw, Buffer.from(magic), s];
  for (let len = pw.length; len > 0; len -= 16) ctx.push(final.subarray(0, Math.min(16, len)));
  for (let i = pw.length; i; i >>= 1) ctx.push(i & 1 ? Buffer.from([0]) : pw.subarray(0, 1));
  final = md5(...ctx);

  for (let i = 0; i < 1000; i++) {
    const parts: Buffer[] = [];
    parts.push(i & 1 ? pw : final);
    if (i % 3) parts.push(s);
    if (i % 7) parts.push(pw);
    parts.push(i & 1 ? final : pw);
    final = md5(...parts);
  }

  const f = final;
  const encoded =
    to64((f[0] << 16) | (f[6] << 8) | f[12], 4) +
    to64((f[1] << 16) | (f[7] << 8) | f[13], 4) +
    to64((f[2] << 16) | (f[8] << 8) | f[14], 4) +
    to64((f[3] << 16) | (f[9] << 8) | f[15], 4) +
    to64((f[4] << 16) | (f[10] << 8) | f[5], 4) +
    to64(f[11], 2);
  return `${magic}${salt}$${encoded}`;
}
