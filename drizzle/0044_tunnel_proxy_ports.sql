-- Servers without a public IP (they connect out through a tunnel) are unreachable from the internet:
-- their proxy takes no host ports and serves Cloudflare Tunnels only. Custom ports are kept.
UPDATE "server" SET "proxy_http_port" = 0, "proxy_https_port" = 0 WHERE "tunnel" IS NOT NULL AND "proxy_http_port" = 80 AND "proxy_https_port" = 443;
