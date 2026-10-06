import { proxyPaths } from "@/server/paths";
import type { Balancing } from "@/lib/balancing";
import type { ServiceProxyConfig } from "@/server/services/proxy-config";
import type { ProxyMaintenance } from "@/server/services/maintenance";
import { allTrusted, clientIpHeaderNames, type VisitorIp } from "@/lib/trusted-proxies";
import { safeRedirectUrl } from "@/lib/unknown-redirect";

/**
 * Proxy images are pinned to exact versions. A Serve release moves them, and the proxy on every
 * server is recreated when its image changes; a server can still set its own image.
 */
export const PROXY_IMAGE = process.env.SERVE_PROXY_IMAGE ?? "nginx:1.30.5-alpine";

/**
 * Where nginx takes the visitor IP from. Off: Cloudflare Tunnel traffic only, from the network the
 * proxy shares with cloudflared alone. On: also the server's trusted proxies, with their header;
 * X-Forwarded-For is read right to left, so the visitor is the last address no trusted proxy added.
 */
export function realIpConfig(v: VisitorIp) {
  if (!v.header) {
    if (!v.tunnel.length) return null;
    return `# Managed by Serve — visitor IPs for Cloudflare Tunnel traffic (only cloudflared shares this network with the proxy).
${v.tunnel.map((s) => `set_real_ip_from ${s};`).join("\n")}
real_ip_header CF-Connecting-IP;
`;
  }
  // A visitor can send X-Real-IP or True-Client-IP through Cloudflare: for those the tunnel is trusted
  // only by the tunnel hosts' own server blocks (tunnelRealIp), for CF-Connecting-IP there.
  const safe = v.header === "x-forwarded-for" || v.header === "cf-connecting-ip";
  const trusted = safe ? allTrusted(v) : v.ranges;
  if (!trusted.length) return null;
  return `# Managed by Serve — visitor IPs from the trusted proxies of this server${safe ? " and Cloudflare Tunnel traffic" : ""}.
${trusted.map((s) => `set_real_ip_from ${s};`).join("\n")}
real_ip_header ${v.header === "proxy-protocol" ? "proxy_protocol" : clientIpHeaderNames[v.header]};
${v.header === "x-forwarded-for" ? "real_ip_recursive on;\n" : ""}`;
}

/**
 * Server-level override for hosts served through a Cloudflare Tunnel while trusted proxies are on:
 * they keep believing cloudflared alone, and only its CF-Connecting-IP (a visitor can send any
 * other header through Cloudflare).
 */
export function tunnelRealIp(v: VisitorIp) {
  if (!v.header || !v.tunnel.length) return null;
  return [...v.tunnel.map((s) => `    set_real_ip_from ${s};`), "    real_ip_header CF-Connecting-IP;", "    real_ip_recursive off;"].join("\n");
}

/** nginx config of the error-page server used by Traefik (it cannot serve files itself). */
export const pagesServerConfig = `# Managed by Serve — error pages for Traefik.
server {
    listen 80 default_server;
    server_name _;
    root /usr/share/serve-pages;

    location = /__serve/health {
        access_log off;
        return 200 "ok";
    }
    location = /__unavailable {
        return 503;
    }
    # Maintenance pages of services, by service id (Traefik rewrites the path to this).
    location ~ "^/__maintenance/([A-Za-z0-9_-]+)$" {
        set $serve_mt_page /maintenance-$1.html;
        error_page 503 $serve_mt_page;
        return 503;
    }
    location ~ "^/maintenance-[A-Za-z0-9_-]+\\.html$" { internal; }
    location = /not-found.html { internal; }
    location = /unavailable.html { internal; }
    location / {
        return 404;
    }
    error_page 404 /not-found.html;
    error_page 502 503 504 /unavailable.html;
}
`;

export type NginxMainOptions = {
  maxBodySize: string;
  workerConnections?: number | null;
  keepaliveTimeout?: number | null;
  proxyConnectTimeout?: number | null;
  proxyReadTimeout?: number | null;
  gzipLevel?: number | null;
  serverTokens?: boolean;
  /** Serve's default server with the 404 page for unknown hosts (default on). */
  catchAll?: boolean;
  /** With the catch-all on: unknown hosts get a 302 redirect to this URL instead (checked by safeRedirectUrl). */
  unknownRedirect?: string | null;
  /** Also listen for PROXY protocol connections (PROXY_PROTOCOL_PORTS). */
  proxyProtocol?: boolean;
};

/**
 * Ports inside the proxy container that expect PROXY protocol. With PROXY protocol on, the server's
 * HTTP and HTTPS ports lead here; 80 and 443 stay plain for Cloudflare Tunnels and the proxy's own checks.
 */
export const PROXY_PROTOCOL_PORTS = { http: 81, https: 444 } as const;

/** listen directives of a server block: plain, and with PROXY protocol on its own ports. */
function listen(kind: "http" | "https", proxyProtocol: boolean | undefined, flags = "", indent = "    ") {
  const ssl = kind === "https" ? " ssl" : "";
  const lines = [`listen ${kind === "https" ? 443 : 80}${ssl}${flags};`];
  if (proxyProtocol) lines.push(`listen ${PROXY_PROTOCOL_PORTS[kind]}${ssl} proxy_protocol${flags};`);
  return lines.join(`\n${indent}`);
}

/** What the default server answers outside its own paths: the 404 page, or a redirect to a safe URL. */
function unknownHosts(redirect?: string | null) {
  const url = safeRedirectUrl(redirect);
  // The URL has no quotes, backslashes or `$`; escape anyway so it can never leave the string.
  return url ? `return 302 "${url.replace(/[\\"]/g, "\\$&")}";` : "return 404;";
}

export function mainConfig(opts: NginxMainOptions) {
  return `# Managed by Serve. Changes will be overwritten.
worker_processes auto;
worker_rlimit_nofile 65535;
error_log /dev/stderr warn;
pid /var/run/nginx.pid;

events {
    worker_connections ${opts.workerConnections ?? 8192};
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Docker's embedded DNS. Lets upstreams follow containers across restarts.
    resolver 127.0.0.11 valid=5s ipv6=off;
    resolver_timeout 3s;

    server_tokens ${opts.serverTokens ? "on" : "off"};
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout ${opts.keepaliveTimeout ?? 65};
    types_hash_max_size 4096;
    server_names_hash_bucket_size 512;
    server_names_hash_max_size 4096;
    client_max_body_size ${opts.maxBodySize};

    log_format serve escape=json '{"t":"$time_iso8601","h":"$host","m":"$request_method","u":"$request_uri",'
        '"s":$status,"b":$body_bytes_sent,"rt":$request_time,"ip":"$remote_addr","ua":"$http_user_agent","ref":"$http_referer","up":"$upstream_addr"}';
    access_log ${proxyPaths.logs}/access.log serve buffer=32k flush=1s;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level ${opts.gzipLevel ?? 5};
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml application/json application/javascript application/xml
               application/rss+xml application/atom+xml image/svg+xml font/ttf font/otf;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:20m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      '';
    }

    map $http_x_forwarded_proto $serve_forwarded_proto {
        default $scheme;
        https   https;
    }

    proxy_http_version 1.1;
    proxy_buffering on;
    proxy_buffers 16 16k;
    proxy_buffer_size 16k;
    proxy_connect_timeout ${opts.proxyConnectTimeout ?? 10}s;
    proxy_send_timeout ${opts.proxyReadTimeout ?? 300}s;
    proxy_read_timeout ${opts.proxyReadTimeout ?? 300}s;
    proxy_next_upstream error timeout http_502 http_503;
    proxy_next_upstream_tries 3;

${
  opts.catchAll === false
    ? "    # Unknown hosts: handled by custom files (Serve's 404 page is off).\n\n"
    : `    # Fallback for unknown hosts.
    server {
        ${listen("http", opts.proxyProtocol, " default_server", "        ")}
        server_name _;

        location ^~ /.well-known/acme-challenge/ {
            root ${proxyPaths.acme};
            default_type text/plain;
        }

        location = /__serve/health {
            access_log off;
            return 200 "ok";
        }

        location / {
            ${unknownHosts(opts.unknownRedirect)}
        }

        error_page 404 /__serve_not_found.html;
        location = /__serve_not_found.html {
            internal;
            root ${proxyPaths.pages};
            try_files /not-found.html =404;
        }
    }

    server {
        ${listen("https", opts.proxyProtocol, " default_server", "        ")}
        server_name _;
        ssl_reject_handshake on;
    }

`
}    # Custom directives from Server → Proxy (not globbed by the sites include).
    include ${proxyPaths.sites}/custom/*.conf;

    include ${proxyPaths.sites}/*.conf;
${
  opts.catchAll === false
    ? `
    # Health check and ACME challenges for Serve (not the default server).
    server {
        ${listen("http", opts.proxyProtocol, "", "        ")}
        server_name localhost 127.0.0.1;

        location ^~ /.well-known/acme-challenge/ {
            root ${proxyPaths.acme};
            default_type text/plain;
        }

        location = /__serve/health {
            access_log off;
            return 200 "ok";
        }
    }
`
    : ""
}}
`;
}

export const proxyParams = `# Managed by Serve.
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $serve_forwarded_proto;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Port $server_port;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
`;

/** The branding icon for the error pages, as a data URL: the pages are static files, they load nothing else. */
export type ErrorPageImages = { icon?: string | null };

function page(title: string, message: string, brand: string, images: ErrorPageImages) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${images.icon ? `<link rel="icon" href="${images.icon}">\n` : ""}<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #0a0a0a; --muted: #737373; --line: #e5e5e5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; --fg: #fafafa; --muted: #a3a3a3; --line: #262626; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px; }
  main { max-width: 420px; text-align: center; }
  .code { font: 600 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); letter-spacing: .08em; }
  h1 { font-size: 22px; margin: 10px 0 6px; letter-spacing: -.01em; }
  p { color: var(--muted); margin: 0; }
  footer { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
</style>
</head>
<body><main>${message}<footer>Served by ${brand}</footer></main></body>
</html>
`;
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** Error pages the proxy serves, with the instance's product name (white-label). */
export function errorPages(productName = "Serve", images: ErrorPageImages = {}) {
  const brand = escapeHtml(productName);
  return {
    "not-found.html": page(
      "No app here",
      `<div class="code">404</div><h1>Nothing is deployed here</h1><p>This domain points to a ${brand} server, but no app is connected to it yet.</p>`,
      brand,
      images,
    ),
    "unavailable.html": page(
      "App unavailable",
      `<div class="code">502</div><h1>This app is not running</h1><p>The app behind this domain is stopped, starting, or crashed. Try again in a moment.</p>`,
      brand,
      images,
    ),
  };
}

/**
 * `balancing`: how visitors are spread (lib/balancing). Sticky hashes the client IP (the real one,
 * after the tunnel); least-busy is nginx's least_conn.
 * `remote`: the app's copies on other servers (load balancing over the private network), each
 * weighted by its replicas; one that fails is left alone for a few seconds while the others answer.
 */
export type SiteUpstream = { name: string; servers: string[]; balancing?: Balancing; remote?: { server: string; weight: number }[] };

export type SiteServer = {
  hostname: string;
  upstream: string | null;
  /** Redirect target instead of proxying. */
  redirectTo?: string | null;
  tls?: { cert: string; key: string } | null;
  forceHttps: boolean;
  /** Raw target, e.g. host.docker.internal:3000 (used for the dashboard). */
  directTarget?: string | null;
  /** Only these IPs or CIDR ranges may connect. Empty or missing allows everyone. */
  allow?: string[];
  /** Per-service HTTP options. */
  options?: SiteOptions | null;
  /** Serve's 503 page for stopped or unreachable apps (default on). */
  errorPages?: boolean;
  /** Maintenance page instead of the app. `geoVar` is set when an allow list lets some visitors through. */
  maintenance?: (ProxyMaintenance & { geoVar?: string | null }) | null;
  /** Visitor IP directives of a Cloudflare Tunnel host (tunnelRealIp), in its plain-HTTP server. */
  realIp?: string | null;
  /** Also listen for PROXY protocol connections (PROXY_PROTOCOL_PORTS). */
  proxyProtocol?: boolean;
  /** Served through a Cloudflare Tunnel: only connections from these subnets (the tunnel network) are answered. */
  tunnelOnly?: { variable: string } | null;
};

/** nginx variable name for a service's "came through the tunnel" flag. */
export const tunnelVar = (serviceId: string) => `serve_tn_${serviceId.replace(/[^a-zA-Z0-9_]/g, "_")}`;

/**
 * http-level `geo` block: 1 for connections from the tunnel network. Checked on the address the
 * connection really came from, before the visitor IP from CF-Connecting-IP replaces it.
 */
export function tunnelGeo(variable: string, subnets: string[]) {
  const lines = subnets.filter(safeCidr).map((s) => `    ${s} 1;`);
  return `geo $realip_remote_addr $${variable} {\n    default 0;\n${lines.join("\n")}\n}\n`;
}

/** nginx variable name for a service's maintenance allow list. */
export const maintenanceVar = (serviceId: string) => `serve_mt_${serviceId.replace(/[^a-zA-Z0-9_]/g, "_")}`;

/** http-level `geo` block: 1 for addresses that skip the maintenance page. */
export function maintenanceGeo(variable: string, allow: string[]) {
  const lines = allow.filter(safeCidr).map((a) => `    ${a} 1;`);
  return `geo $${variable} {\n    default 0;\n${lines.join("\n")}\n}\n`;
}

/** Service HTTP options as the templates need them (auth as a file path, not a hash). */
export type SiteOptions = Omit<ServiceProxyConfig, "basicAuth"> & {
  /** htpasswd file path inside the proxy container when basic auth is on. */
  authFile?: string | null;
  /** Login wall: the upstream block that reaches Serve (gateUpstreamBlock), and the service it asks about. */
  gate?: { upstream: string; host: string; tls: boolean; serviceId: string } | null;
};

/** Params without WebSocket upgrade headers, for services that turn WebSockets off. */
export const proxyParamsPlain = proxyParams
  .split("\n")
  .filter((l) => !/Upgrade|Connection/.test(l))
  .join("\n");

export const PLAIN_PARAMS_PATH = `${proxyPaths.sites}/params/plain.conf`;

const STATIC_FILES = "css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wasm";

/**
 * Whether nginx should re-resolve a server through Docker DNS. Container names
 * need it (they change IP across restarts); IP literals and names that only
 * exist in /etc/hosts (host.docker.internal via ExtraHosts) must not use it,
 * or nginx logs "could not be resolved" forever.
 */
export function usesDockerDns(server: string) {
  const host = server.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
  return !["localhost", "host.docker.internal", "gateway.docker.internal"].includes(host);
}

export function upstreamBlock(u: SiteUpstream) {
  const remote = u.remote ?? [];
  const lines = [
    ...u.servers.map((s) => `    server ${s}${usesDockerDns(s) ? " resolve" : ""} max_fails=0;`),
    ...remote.map((r) => `    server ${r.server}${usesDockerDns(r.server) ? " resolve" : ""}${r.weight > 1 ? ` weight=${r.weight}` : ""} max_fails=1 fail_timeout=10s;`),
  ];
  const servers = lines.length
    ? lines.join("\n")
    : // No running container: keep a placeholder so nginx loads, requests get the 502 page.
      `    server 127.0.0.1:1 down;`;
  return `upstream ${u.name} {
    zone ${u.name} 64k;
${lines.length > 1 ? (u.balancing === "sticky" ? "    hash $remote_addr consistent;\n" : u.balancing === "least-busy" ? "    least_conn;\n" : "") : ""}${servers}
    keepalive 32;
}
`;
}

/** Escape a literal for a regex inside an nginx `if`. */
const regexLiteral = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Response headers set inside a location (add_header there replaces inherited ones, so HSTS is repeated). */
function responseHeaders(o: SiteOptions | null | undefined, tls: boolean, extra: string[] = []) {
  const lines: string[] = [];
  // Without options the server block sets HSTS and nothing here overrides it.
  if (tls && o) lines.push(`add_header Strict-Transport-Security "max-age=31536000${o?.securityHeaders ? "; includeSubDomains" : ""}" always;`);
  if (o?.securityHeaders) {
    lines.push(`add_header X-Content-Type-Options "nosniff" always;`);
    lines.push(`add_header Referrer-Policy "strict-origin-when-cross-origin" always;`);
    lines.push(`add_header X-Frame-Options "SAMEORIGIN" always;`);
  }
  if (o?.corsOrigins?.length) {
    lines.push(`add_header Access-Control-Allow-Origin $serve_cors always;`);
    lines.push(`add_header Vary "Origin" always;`);
    lines.push(`add_header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS" always;`);
    lines.push(`add_header Access-Control-Allow-Headers "Authorization, Content-Type, Accept, Origin, X-Requested-With" always;`);
    lines.push(`add_header Access-Control-Max-Age "86400" always;`);
  }
  for (const h of o?.headers ?? []) lines.push(`add_header ${h.name} "${h.value}" always;`);
  lines.push(...extra);
  return lines;
}

/** The proxied request itself: params, timeouts, buffering. */
function proxyDirectives(target: string, o: SiteOptions | null | undefined) {
  const lines = [`proxy_pass http://${target};`, `include ${o?.websockets === false ? PLAIN_PARAMS_PATH : "/etc/nginx/serve/proxy_params.conf"};`];
  if (o?.connectTimeout) lines.push(`proxy_connect_timeout ${o.connectTimeout}s;`);
  if (o?.readTimeout) lines.push(`proxy_read_timeout ${o.readTimeout}s;`, `proxy_send_timeout ${o.readTimeout}s;`);
  if (o?.buffering === false) lines.push("proxy_buffering off;", "proxy_request_buffering off;", "proxy_cache off;");
  return lines;
}

function indent(lines: string[], depth: number) {
  const pad = " ".repeat(depth * 4);
  return lines
    .join("\n")
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}

function proxyLocation(target: string, o: SiteOptions | null | undefined, tls: boolean, errorPages = true, guard: string[] = []) {
  // nginx does not pass `if`, `set`, `return` or `limit_except` on to a nested location: the
  // static files location repeats these checks.
  const access: string[] = [...guard];
  // Basic auth lives in the location so the ACME challenge and error pages stay open.
  if (o?.authFile) {
    const auth = [`auth_basic "Restricted";`, `auth_basic_user_file ${o.authFile};`];
    // CORS preflights carry no credentials; let OPTIONS through.
    if (o.corsOrigins?.length) access.push("limit_except OPTIONS {", ...auth.map((l) => `    ${l}`), "}");
    else access.push(...auth);
  }
  // Login wall: Serve answers each request; a 401 carries the sign-in address (gateLocations).
  if (o?.gate) access.push("auth_request /__serve_gate_check;", "auth_request_set $serve_gate_to $upstream_http_location;");
  if (o?.corsOrigins?.length) {
    if (o.corsOrigins.includes("*")) access.push(`set $serve_cors "*";`);
    else {
      access.push(`set $serve_cors "";`);
      access.push(`if ($http_origin ~* "^(${o.corsOrigins.map(regexLiteral).join("|")})$") {`, "    set $serve_cors $http_origin;", "}");
    }
    access.push("if ($request_method = OPTIONS) {", "    return 204;", "}");
  }
  const inner = [...access];
  const headers = responseHeaders(o, tls);
  inner.push(...proxyDirectives(target, o), ...headers);
  if (o?.cacheStatic) {
    inner.push(
      `location ~* \\.(${STATIC_FILES})$ {`,
      indent(
        [...access, ...proxyDirectives(target, o), "proxy_hide_header Cache-Control;", ...responseHeaders(o, tls, [`add_header Cache-Control "public, max-age=604800" always;`])],
        1,
      ),
      "}",
    );
  }
  if (o?.customDirectives) inner.push("# Custom directives", o.customDirectives);
  const main = `    location / {
${indent(inner, 2)}
    }${o?.gate ? `\n\n${gateLocations(o.gate)}` : ""}`;
  if (!errorPages) return main;
  return `${main}

    error_page 502 503 504 /__serve_unavailable.html;
    location = /__serve_unavailable.html {
        internal;
        root ${proxyPaths.pages};
        try_files /unavailable.html =502;
    }`;
}

/**
 * The upstream block a site's login wall reaches Serve through (gateUpstream's URL). A block, not
 * a variable: names from /etc/hosts (host.docker.internal) only resolve this way, and with
 * `resolve` a dashboard name that does not resolve yet cannot stop nginx from loading.
 */
export function gateUpstreamBlock(name: string, url: string) {
  const u = new URL(url);
  const tls = u.protocol === "https:";
  return { block: upstreamBlock({ name, servers: [`${u.hostname}:${u.port || (tls ? 443 : 80)}`] }), host: u.host, tls };
}

/**
 * The login wall's server-level parts: the check and the ticket swap go to Serve. Only the wall's
 * own cookie goes along, not the app's. The error_page sits here, not in the location, which would
 * drop the server's 502 page.
 */
function gateLocations(g: NonNullable<SiteOptions["gate"]>) {
  const host = g.host.replace(/[^A-Za-z0-9.:[\]-]/g, "");
  const to = (path: string, extra: string[]) => [
    `proxy_pass ${g.tls ? "https" : "http"}://${g.upstream}${path};`,
    "proxy_http_version 1.1;",
    `proxy_set_header Host "${host}";`,
    'proxy_set_header Connection "";',
    ...extra,
    ...(g.tls
      ? [`proxy_ssl_name ${host.replace(/:\d+$/, "")};`, "proxy_ssl_server_name on;", "proxy_ssl_verify on;", "proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;"]
      : []),
  ];
  return `    error_page 401 = @serve_gate;
    location @serve_gate {
        add_header Cache-Control "no-store" always;
        return 302 $serve_gate_to;
    }
    location = /__serve_gate_check {
        internal;
${indent(
  to(`/api/gate/check?s=${encodeURIComponent(g.serviceId)}&r=401`, [
    "proxy_pass_request_body off;",
    'proxy_set_header Content-Length "";',
    "proxy_set_header X-Serve-Host $host;",
    "proxy_set_header X-Serve-Uri $request_uri;",
    'proxy_set_header Cookie "__serve_gate=$cookie___serve_gate";',
  ]),
  2,
)}
    }
    location = /__serve/gate {
${indent(to("/api/gate/callback$is_args$args", []), 2)}
    }`;
}

function body(s: SiteServer) {
  if (s.redirectTo) {
    return `    location / {
        return 308 ${s.redirectTo.replace(/\/$/, "")}$request_uri;
    }`;
  }
  if (s.maintenance) return maintenanceBody(s, s.maintenance);
  const target = s.upstream ?? s.directTarget;
  if (!target) {
    if (s.errorPages === false) return `    location / {\n        return 503;\n    }`;
    return `    location / {
        return 503;
    }

    error_page 503 /__serve_unavailable.html;
    location = /__serve_unavailable.html {
        internal;
        root ${proxyPaths.pages};
        try_files /unavailable.html =503;
    }`;
  }
  return proxyLocation(target, s.options, !!s.tls, s.errorPages !== false);
}

/** 503 with the service's maintenance page; visitors on the allow list still reach the app. */
function maintenanceBody(s: SiteServer, m: NonNullable<SiteServer["maintenance"]>) {
  const page = `    error_page 503 /__serve_maintenance.html;
    location = /__serve_maintenance.html {
        internal;
        root ${proxyPaths.pages};
        add_header Retry-After ${m.retryAfter} always;
        add_header Cache-Control "no-store" always;
        try_files /${m.page} =503;
    }`;
  const target = s.upstream ?? s.directTarget;
  if (!m.geoVar || !target) return `    location / {\n        return 503;\n    }\n\n${page}`;
  const app = proxyLocation(target, s.options, !!s.tls, false, [`if ($${m.geoVar} = 0) {`, "    return 503;", "}"]);
  return `${app}\n\n${page}`;
}

function acmeLocation(restricted: boolean) {
  // Let's Encrypt must reach the challenge even when an allowlist is active.
  return `    location ^~ /.well-known/acme-challenge/ {
${restricted ? "        allow all;\n" : ""}        root ${proxyPaths.acme};
        default_type text/plain;
    }`;
}

/** Only allow valid IPs / CIDR ranges into the config. */
const safeCidr = (v: string) => /^[0-9a-f:.]+(\/\d{1,3})?$/i.test(v);

function accessRules(allow: string[] | undefined, deny: string[] | undefined = []) {
  const denied = deny.filter(safeCidr);
  const allowed = (allow ?? []).filter(safeCidr);
  if (!denied.length && !allowed.length) return "";
  const lines = [...denied.map((d) => `    deny ${d};`), ...allowed.map((a) => `    allow ${a};`)];
  if (allowed.length) lines.push("    deny all;");
  return `${lines.join("\n")}\n\n`;
}

/** Server-level settings from the service options. */
function serverSettings(o: SiteOptions | null | undefined) {
  const lines: string[] = [];
  if (o?.maxBodySize) lines.push(`    client_max_body_size ${o.maxBodySize};`);
  if (o?.gzip === false) lines.push("    gzip off;");
  return lines.length ? `${lines.join("\n")}\n\n` : "";
}

export function serverBlocks(s: SiteServer) {
  const blocks: string[] = [];
  const redirectHttp = s.tls && s.forceHttps;
  const rules = accessRules([...(s.allow ?? []), ...(s.options?.allow ?? [])], s.options?.deny);
  const acme = acmeLocation(!!rules);
  // A tunnel host reached on the server's own ports would skip Cloudflare (its Access rules, its WAF).
  const tunnelGuard = s.tunnelOnly ? `    if ($${s.tunnelOnly.variable} = 0) {\n        return 403;\n    }\n\n` : "";
  const settings = tunnelGuard + serverSettings(s.options);
  blocks.push(`server {
    ${listen("http", s.proxyProtocol)}
    server_name ${s.hostname};

${s.realIp ? `${s.realIp}\n\n` : ""}${settings}${rules}${acme}

${redirectHttp ? `    location / {\n        return 301 https://$host$request_uri;\n    }` : body(s)}
}
`);
  if (s.tls) {
    // With per-location headers, HSTS is emitted inside the location; keep it here otherwise.
    const hsts = s.options && !s.redirectTo && (s.upstream ?? s.directTarget) ? "" : `    add_header Strict-Transport-Security "max-age=31536000" always;\n`;
    blocks.push(`server {
    ${listen("https", s.proxyProtocol)}
    http2 on;
    server_name ${s.hostname};

    ssl_certificate ${s.tls.cert};
    ssl_certificate_key ${s.tls.key};
${hsts}
${settings}${rules}${acme}

${body(s)}
}
`);
  }
  return blocks.join("\n");
}
