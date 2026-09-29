# Serve

Serve is a self-hosted platform for deploying apps, databases and services on your own servers — the push-to-deploy experience of Vercel, Railway and Render, on hardware you control.

It runs everything in Docker, routes traffic through nginx, issues TLS certificates automatically, and manages Cloudflare DNS for you, all from one dashboard.

## Install

On a fresh Linux server (Ubuntu, Debian, Fedora, Rocky…) with ports 80, 443 and 8000 open:

```bash
curl -fsSL https://raw.githubusercontent.com/shahriyardx/serve/main/install.sh | sudo bash
```

Then open `http://<server-ip>:8000`, create the owner account, and follow the setup guide.

The installer installs Docker if needed, gives Docker larger network address pools, writes secrets to `/data/serve/.env`, and starts three containers: the dashboard, the worker and Serve's own PostgreSQL database. The worker starts the nginx proxy.

Upgrade:

```bash
cd /data/serve && docker compose pull && docker compose up -d
```

## Features

**Deploy anything**
- Git repositories (GitHub, GitLab, Gitea, Bitbucket, any Git URL, SSH deploy keys)
- Automatic builds: Dockerfile, Nixpacks, or built-in detection for Node.js, Bun, Next.js, Vite and other static sites, Python, Go, Rust and PHP
- Docker images from any registry, including private ones
- Docker Compose stacks, inline or from a repository
- One-click services: n8n, Uptime Kuma, Umami, Plausible, Ghost, WordPress, MinIO, Gitea, Vaultwarden, Metabase, Grafana, pgAdmin, Adminer, code-server

**Databases**
- PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey and ClickHouse
- Generated credentials, private networking, optional public port
- Scheduled backups with retention, stored locally or in S3-compatible storage (S3, R2, B2, MinIO), one-click restore and download

**Deployments**
- Zero-downtime deploys with health checks and graceful traffic switching
- Instant rollbacks to any previous image
- Push-to-deploy webhooks, deploy hooks for CI, and a REST API with tokens
- Pull request preview deployments with their own URL, removed when the PR closes
- Live build logs, streaming runtime logs, and cancellable builds
- Replicas with load balancing, resource limits, volumes and published ports

**Domains and TLS**
- nginx reverse proxy with WebSockets, HTTP/2 and graceful reloads
- Automatic domains through a wildcard domain or sslip.io
- Let's Encrypt certificates over HTTP or Cloudflare DNS (wildcards), Cloudflare Origin CA certificates, or uploaded certificates, all renewed automatically
- Redirect domains, force HTTPS and DNS checks

**Cloudflare**
- Connect accounts with an API token
- Create DNS records automatically when adding domains, with proxy toggle
- Manage DNS records, SSL/TLS mode, Always Use HTTPS and cache purges in the dashboard

**Operate**
- Project environments (production, staging…) with shared variables
- Variable references between services, such as `${{postgres.DATABASE_URL}}`
- Console for one-off commands and scheduled tasks (cron jobs) with run history
- CPU, memory, network and request metrics (requests, status codes, latency)
- Notifications to Discord, Slack, Telegram or any webhook
- Organizations with owners, admins and members, invite links, audit log, two-factor authentication and API tokens

## How it works

```
Browser ──> nginx proxy (serve-proxy) ──> app containers on per-environment networks
                 │
Dashboard (Next.js) ── server actions ──> PostgreSQL (state + job queue)
                                              │
                               Worker ── Docker socket ──> builds, containers,
                                         certbot, compose, backups, metrics
```

- **Dashboard** — Next.js App Router, Tailwind CSS, Base UI, better-auth. Server actions write to PostgreSQL through Drizzle.
- **Worker** — a long-running Node process that claims jobs from a PostgreSQL queue (`FOR UPDATE SKIP LOCKED`, woken by `LISTEN/NOTIFY`), runs builds with the Docker CLI, manages containers with the Docker API, writes nginx configs, runs certbot, collects metrics and executes schedules.
- **Proxy** — an nginx container on the shared network. Each service gets a site file; upstreams use Docker DNS with `resolve`, and every change is validated with `nginx -t` before a graceful reload, rolling back on failure.
- **Isolation** — every project environment gets its own Docker network. Services reach each other by name inside an environment; other organizations, other environments and Serve's own database are unreachable. Only the proxy joins every environment network.
- **Data** — everything lives in `/data/serve` (repositories, proxy config, certificates, backups). The same path is mounted into the worker so bind mounts line up with the host.

## Development

Requirements: Node.js 22+, pnpm, Docker.

```bash
pnpm install
docker compose -f dev/docker-compose.yml up -d   # PostgreSQL on :5436
cp .env.example .env                             # fill in secrets (openssl rand -hex 32)
pnpm db:migrate
pnpm dev          # dashboard on http://localhost:3000
pnpm dev:worker   # worker, starts the proxy on SERVE_PROXY_HTTP_PORT
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | TypeScript checks |
| `pnpm lint` | ESLint |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm db:generate` | Create a migration after editing `src/server/db/schema.ts` |
| `pnpm build` | Production build of the dashboard and the bundled worker |
| `scripts/e2e/run.sh` | Isolated end-to-end instance on :3001 (see `.env.e2e`) |

### Project layout

```
src/app/            Pages, layouts and API routes
src/components/     UI kit (Base UI) and app shell
src/server/         Server-only code
  actions/          Server actions used by the UI
  db/               Drizzle schema, client and migrations runner
  deploy/           Build and deploy pipeline (git, builders, containers, compose)
  proxy/            nginx config generation and reloads
  ssl/              Certificates (certbot, Cloudflare Origin, uploads)
  cloudflare/       Cloudflare API client
  backups/          Database backups and S3 uploads
  services/         Variables, templates, previews, tasks and access checks
src/worker/         Worker entry point
drizzle/            SQL migrations
docker/             Production compose file and entrypoint
```

## Configuration

Settings that belong to the server (IP, domains, Let's Encrypt, build limits) are edited in **Server settings** by admins of the Root organization. Environment variables:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string for Serve's own data |
| `BETTER_AUTH_SECRET` | Session signing secret |
| `SERVE_ENCRYPTION_KEY` | Key for encrypting secrets at rest (variables, tokens, keys) |
| `BETTER_AUTH_URL` | Default public URL of the dashboard |
| `SERVE_DATA_DIR` | Data directory, `/data/serve` in production |
| `SERVE_PROXY_HTTP_PORT` / `SERVE_PROXY_HTTPS_PORT` | Host ports for the proxy |
| `SERVE_DASHBOARD_UPSTREAM` | How the proxy reaches the dashboard (`serve:3000`) |
| `SERVE_NETWORK` | Shared Docker network name (`serve`) |
| `SERVE_NETWORK_SUBNET` | Subnet of the shared network in the production stack |

## Security

- Secrets (environment variables, tokens, SSH keys, registry and S3 credentials) are encrypted with AES-256-GCM before they are stored.
- Every page, action and API route checks organization membership; server settings require Root admin access.
- Webhooks are verified with HMAC signatures or tokens. API tokens are stored as SHA-256 hashes.
- The worker needs the Docker socket, which is equivalent to root on the host. Run Serve on a server dedicated to it.

## License

MIT
