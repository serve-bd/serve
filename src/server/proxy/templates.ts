import { proxyPaths } from "@/server/paths";

export const PROXY_IMAGE = process.env.SERVE_PROXY_IMAGE ?? "nginx:stable-alpine";

export function mainConfig(opts: { maxBodySize: string }) {
  return `# Managed by Serve. Changes will be overwritten.
worker_processes auto;
worker_rlimit_nofile 65535;
error_log /dev/stderr warn;
pid /var/run/nginx.pid;

events {
    worker_connections 8192;
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Docker's embedded DNS. Lets upstreams follow containers across restarts.
    resolver 127.0.0.11 valid=5s ipv6=off;
    resolver_timeout 3s;

    server_tokens off;
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 4096;
    server_names_hash_bucket_size 128;
    server_names_hash_max_size 4096;
    client_max_body_size ${opts.maxBodySize};

    log_format serve escape=json '{"t":"$time_iso8601","h":"$host","m":"$request_method","u":"$request_uri",'
        '"s":$status,"b":$body_bytes_sent,"rt":$request_time,"ip":"$remote_addr","ua":"$http_user_agent","ref":"$http_referer"}';
    access_log ${proxyPaths.logs}/access.log serve buffer=32k flush=5s;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
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
    proxy_connect_timeout 10s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
    proxy_next_upstream error timeout http_502 http_503;
    proxy_next_upstream_tries 3;

    # Fallback for unknown hosts.
    server {
        listen 80 default_server;
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
            return 404;
        }

        error_page 404 /__serve_not_found.html;
        location = /__serve_not_found.html {
            internal;
            root ${proxyPaths.pages};
            try_files /not-found.html =404;
        }
    }

    server {
        listen 443 ssl default_server;
        server_name _;
        ssl_reject_handshake on;
    }

    # Custom directives from Server → Proxy (not globbed by the sites include).
    include ${proxyPaths.sites}/custom/*.conf;

    include ${proxyPaths.sites}/*.conf;
}
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

function page(title: string, message: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
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
<body><main>${message}<footer>Served by Serve</footer></main></body>
</html>
`;
}

export const pages = {
  "not-found.html": page(
    "No app here",
    `<div class="code">404</div><h1>Nothing is deployed here</h1><p>This domain points to a Serve server, but no app is connected to it yet.</p>`,
  ),
  "unavailable.html": page(
    "App unavailable",
    `<div class="code">502</div><h1>This app is not running</h1><p>The app behind this domain is stopped, starting, or crashed. Try again in a moment.</p>`,
  ),
};

export type SiteUpstream = { name: string; servers: string[] };

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
};

export function upstreamBlock(u: SiteUpstream) {
  const servers = u.servers.length
    ? u.servers.map((s) => `    server ${s} resolve max_fails=0;`).join("\n")
    : // No running container: keep a placeholder so nginx loads, requests get the 502 page.
      `    server 127.0.0.1:1 down;`;
  return `upstream ${u.name} {
    zone ${u.name} 64k;
${servers}
    keepalive 32;
}
`;
}

function proxyLocation(target: string) {
  return `    location / {
        proxy_pass http://${target};
        include /etc/nginx/serve/proxy_params.conf;
    }

    error_page 502 503 504 /__serve_unavailable.html;
    location = /__serve_unavailable.html {
        internal;
        root ${proxyPaths.pages};
        try_files /unavailable.html =502;
    }`;
}

function body(s: SiteServer) {
  if (s.redirectTo) {
    return `    location / {
        return 308 ${s.redirectTo.replace(/\/$/, "")}$request_uri;
    }`;
  }
  const target = s.upstream ?? s.directTarget;
  if (!target) {
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
  return proxyLocation(target);
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

function accessRules(allow: string[] | undefined) {
  const list = (allow ?? []).filter(safeCidr);
  if (!list.length) return "";
  return `${list.map((a) => `    allow ${a};`).join("\n")}\n    deny all;\n\n`;
}

export function serverBlocks(s: SiteServer) {
  const blocks: string[] = [];
  const redirectHttp = s.tls && s.forceHttps;
  const rules = accessRules(s.allow);
  const acme = acmeLocation(!!rules);
  blocks.push(`server {
    listen 80;
    server_name ${s.hostname};

${rules}${acme}

${redirectHttp ? `    location / {\n        return 301 https://$host$request_uri;\n    }` : body(s)}
}
`);
  if (s.tls) {
    blocks.push(`server {
    listen 443 ssl;
    http2 on;
    server_name ${s.hostname};

    ssl_certificate ${s.tls.cert};
    ssl_certificate_key ${s.tls.key};
    add_header Strict-Transport-Security "max-age=31536000" always;

${rules}${acme}

${body(s)}
}
`);
  }
  return blocks.join("\n");
}
