# Serve

Serve is a self-hosted platform for deploying apps, databases and services on your own servers. Push to deploy, get a domain with HTTPS, attach a database with backups, and run it all on hardware you control from one dashboard.

Everything runs in Docker. A reverse proxy of your choice (nginx, Caddy or Traefik) routes traffic, certificates are issued and renewed automatically, and Cloudflare DNS and Tunnels are managed for you.

## Contents

- [Features](#features)
- [Install](#install)
- [Updating](#updating)
- [Backup and restore](#backup-and-restore)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Guides](#guides)
- [REST API](#rest-api)
- [Development](#development)
- [Security](#security)
- [License](#license)

## Features

**Deploy anything**
- **Git repositories.** Connect GitHub in one click through a GitHub App Serve creates for you. GitLab, Gitea/Forgejo and Bitbucket connect through OAuth or an access token, and Serve registers the push and pull request webhooks on the repository itself. Any Git URL works with an SSH deploy key.
- **Builds.** Dockerfile, Nixpacks, or built-in detection for Node.js, Bun, Next.js, Vite and other static sites, Python, Go, Rust and PHP.
- **Docker images** from any registry, including private ones.
- **Docker Compose stacks**, inline (with a code editor) or from a repository. A stack can reach the rest of its environment or keep to itself.
- **Service catalog.** 62 ready-made services (n8n, Uptime Kuma, Umami, Plausible, Ghost, WordPress, Nextcloud, Gitea, Vaultwarden, Grafana, MinIO, Immich, Open WebUI and more), plus your organization's own templates built from any compose file.
- Creating a service never deploys it: review variables, domains and storage, then deploy.

**Databases**
- PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey and ClickHouse, or a custom image of the same engine (for example pgvector).
- Generated credentials with a live password change inside the running database, TLS with a per-database CA, custom configuration files, initialization scripts, health check tuning, resource limits and an optional public port.
- Scheduled backups with separate local and S3 retention (AWS S3, Cloudflare R2, Backblaze B2, MinIO…), one-click restore, and import from an upload, a URL or S3, with a safety backup first.

**Deployments**
- Zero-downtime deploys with health checks, instant rollbacks to any previous image, and cancellable builds with live logs.
- Pull request preview deployments with their own URL, removed when the pull request closes.
- Deploy hooks for CI and a REST API with scoped, expiring tokens.
- Replicas, resource limits, persistent storage (volumes, files Serve writes, host paths) and published ports.

**Domains and HTTPS**
- Switch each server's proxy between nginx, Caddy, Traefik or none at any time, with per-proxy settings, dynamic configuration files and per-service overrides.
- Generated domains through a wildcard domain or sslip.io, a primary domain per service, redirect domains and forced HTTPS.
- Certificates from Let's Encrypt (HTTP or Cloudflare DNS validation, wildcards), Cloudflare Origin CA or uploads, renewed automatically.

**Cloudflare**
- DNS records created when you add a domain, plus DNS, SSL/TLS mode and cache management in the dashboard.
- Cloudflare Tunnels for servers without a public IP or open ports. Switch a domain between the server IP and a tunnel at any time.

**Servers**
- Deploy to any number of Linux servers over SSH, next to the machine Serve runs on. Serve installs Docker and the proxy when needed.
- Per-server proxy, certificates, domains, metrics, Docker cleanup and a root terminal. Move services between servers.
- Private networks between servers (WireGuard): services on different servers reach each other by their private names, encrypted, with no public ports. Group servers into several networks to keep them apart. A service keeps its private address when it moves.

**Operate**
- Projects with environments (production, staging…), and shared variables at organization, project and environment level.
- References between services, such as `${{postgres.DATABASE_URL}}` or `${{SERVE_PUBLIC_URL}}`, resolved at deploy time.
- Browser terminal into containers, scheduled tasks (cron) with run history, and CPU, memory, network and request metrics.
- Notifications to Discord, Slack, Telegram or any webhook.
- Organizations with roles (Owner, Admin, Developer, Viewer and custom roles), per-member project access, invite links, an activity log, two-factor authentication and API tokens.
- Backups of Serve itself on a schedule (locally and to S3), and one-click updates that back up first.

## Install

On a fresh Linux server (Ubuntu, Debian, Fedora, Rocky…) with ports 80, 443 and 8000 open:

```bash
curl -fsSL https://raw.githubusercontent.com/shahriyardx/serve/main/install.sh | sudo bash
```

Then open `http://<server-ip>:8000`, create the owner account and follow the setup guide.

The installer:

1. Installs Docker if it is missing (Docker Compose v2 is required).
2. Gives Docker larger network address pools and log rotation in `/etc/docker/daemon.json`.
3. Writes generated secrets to `/data/serve/.env` (kept on later runs).
4. Downloads the stack definition to `/data/serve/docker-compose.yml` and starts three containers: the dashboard (`serve`), the worker (`serve-worker`) and Serve's own PostgreSQL (`serve-db`). The worker then starts the proxy.

Installer options, set as environment variables before running it:

| Variable | Default | Description |
| --- | --- | --- |
| `SERVE_IMAGE` | `ghcr.io/shahriyardx/serve:latest` | Image to run |
| `SERVE_DASHBOARD_PORT` | `8000` | Host port of the dashboard |

The data directory must stay `/data/serve`: the worker creates bind mounts with host paths, so the path is the same inside and outside its container.

## Updating

**Settings → Updates** shows the running version and commit and checks GitHub releases every few hours (turn it off on the same page; nothing about the instance is sent). When a newer release exists, **Update now**:

1. takes a backup of the instance (see below),
2. moves `SERVE_IMAGE` in `/data/serve/.env` to the new version if it is pinned to one (`:latest` is kept and pulled again),
3. starts a short-lived `serve-updater` container that runs `docker compose pull` and `docker compose up -d` for `serve` and `serve-worker`.

The dashboard is unavailable for about a minute; deployed services keep running. Progress and the updater's output stay on the page, and database migrations run when the new version starts.

To update by hand instead:

```bash
cd /data/serve && docker compose pull && docker compose up -d
```

| Variable | Default | Description |
| --- | --- | --- |
| `SERVE_UPDATE_REPO` | `shahriyardx/serve` | GitHub repository whose releases announce updates |
| `SERVE_UPDATE_TOKEN` | | GitHub token that can read the releases, only while the repository is private |

## Backup and restore

**Settings → Backups** backs up Serve itself, on a schedule or on demand. Each backup is one `.tar.gz` file stored in `/data/serve/backups/instance` and, optionally, uploaded to an S3 destination of the Root organization. Older backups are removed by the retention setting, in both places.

A backup contains:

| Part | From |
| --- | --- |
| `database.dump` | Serve's PostgreSQL (`pg_dump` custom format) |
| `certs`, `letsencrypt` | Uploaded and issued certificates |
| `proxy` | Proxy configuration and dynamic configuration files (not its logs) |
| `ssh` | SSH keys Serve generated |
| `services` | Per-service files: compose files, file mounts, database TLS authorities (not git clones or build workspaces) |
| `docker-compose.yml` | The stack definition |
| `manifest.json` | Version, commit, schema version and contents of the backup |

Service volumes (your apps' and databases' data) are not part of it: back databases up from their **Backups** tab.

> **The encryption key is never in a backup.** Passwords, tokens and keys in the database are encrypted with `SERVE_ENCRYPTION_KEY` (or `BETTER_AUTH_SECRET` when it is unset). Without the same key, a restored instance cannot read them. Save it in a password manager; **Settings → Backups → Show encryption key** shows it to Root admins (the reveal is logged).

To restore on a server with the Docker Compose install:

```bash
# /data/serve/.env must contain the original SERVE_ENCRYPTION_KEY
sudo bash /data/serve/restore-instance.sh serve-2026-01-01T03-00-00-v0.2.0.tar.gz
```

The script (`scripts/restore-instance.sh`, installed next to the compose file) checks the manifest, stops the dashboard and worker, restores the database with `pg_restore --clean`, puts the instance files back and starts Serve again. A running Serve never restores its own database from the dashboard.

## Configuration

Most settings (server IP, domains, Let's Encrypt, proxy, build limits) live in the dashboard under **Settings** and **Servers**, editable by admins of the Root organization. The rest comes from environment variables in `/data/serve/.env`:

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL connection string for Serve's own data |
| `BETTER_AUTH_SECRET` | required | Session signing secret |
| `SERVE_ENCRYPTION_KEY` | `BETTER_AUTH_SECRET` | Key that encrypts secrets at rest |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Default public URL of the dashboard |
| `SERVE_DATA_DIR` | `/data/serve` | Data directory |
| `SERVE_NETWORK` | `serve` | Docker network shared by the dashboard, worker and proxy |
| `SERVE_NETWORK_SUBNET` | `10.209.0.0/16` | Subnet of that network in the production stack |
| `SERVE_PROXY_HTTP_PORT` / `SERVE_PROXY_HTTPS_PORT` | `80` / `443` | Proxy host ports of the local server (editable per server later) |
| `SERVE_PROXY_CONTAINER` | `serve-proxy` | Name of the proxy container |
| `SERVE_DASHBOARD_UPSTREAM` | `serve:3000` | How the proxy reaches the dashboard |
| `SERVE_WEBHOOK_BASE_URL` | dashboard URL | Address Git providers send webhooks to, if different |
| `SERVE_PROXY_IMAGE` / `SERVE_CADDY_IMAGE` / `SERVE_TRAEFIK_IMAGE` | `nginx:stable-alpine` / `caddy:2-alpine` / `traefik:v3.7` | Proxy images |
| `SERVE_TUNNEL_IMAGE` | `cloudflare/cloudflared:latest` | Cloudflare Tunnel connector image |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket of the local server |
| `DATABASE_POOL_SIZE` | `10` | PostgreSQL connections per process |

## How it works

```
Browser ──> proxy (serve-proxy: nginx, Caddy or Traefik) ──> app containers on per-environment networks
                 │
Dashboard (Next.js) ── server actions ──> PostgreSQL (state + job queue)
                                              │
                               Worker ── Docker (local socket or SSH) ──> builds, containers,
                                         compose, certificates, backups, metrics
```

- **Dashboard.** Next.js App Router with Tailwind CSS, Base UI and better-auth. Server actions write to PostgreSQL through Drizzle.
- **Worker.** A long-running Node process that claims jobs from a PostgreSQL queue (`FOR UPDATE SKIP LOCKED`, woken by `LISTEN/NOTIFY`). It builds images, manages containers and compose stacks, writes proxy configuration, issues certificates, runs backups, collects metrics and executes schedules. Remote servers are reached over SSH.
- **Proxy.** One container per server on the shared network. Each change is validated before a graceful reload and rolled back on failure. Switching proxy kinds is a job with health checks and rollback to the previous proxy.
- **Isolation.** Every project environment gets its own Docker network. Services reach each other by name inside an environment. Other organizations, other environments and Serve's own database are unreachable. The proxy joins each environment network, and the network of each isolated compose stack.
- **Data.** Everything lives in `/data/serve`: repositories, proxy configuration, certificates, backups and service files.

## Guides

### Adding a server

Servers → **Add server**:

1. Enter the server's address, SSH port and user (root, or a user with passwordless sudo).
2. Generate an SSH key in Serve (or import one) and run the shown command on the server to authorize it.
3. Connect. Serve pins the server's host key, checks Docker (and installs it if you ask), prepares `/data/serve` and starts the proxy.

Only SSH needs to be reachable from the Serve machine. Open ports 80 and 443 on the server for its apps, or use a Cloudflare Tunnel.

### Private network between servers

Services on different servers reach each other by their private names once both servers are in the private network (a server → **Private network** → **Join**). `${{postgres.DATABASE_URL}}` then works when the database runs on another server.

Servers are grouped into networks: two servers reach each other only when they share one. A server can be in several networks, so one database server can serve two groups of servers that never reach each other. Pick the networks when joining, and change them later on the server's **Private network** page (**Networks**).

- Each server runs a small agent container (`serve-mesh`) that sets up WireGuard, the firewall rules and one `serve-link-*` container per service used from another server. The link answers to the service's names on the environment network and forwards to it.
- Only services of the same environment reach each other; other environments and the servers themselves are blocked.
- Servers connect to each other on UDP port 51820 (changeable). The server's own firewall is opened by the agent; open the port in a cloud firewall if your provider has one.
- Addresses: `10.240.0.0/16` for services (kept when a service moves) and `10.241.N.0/24` per server.

### Cloudflare Tunnels

For servers without a public IP, or with ports 80 and 443 closed:

1. Connect Cloudflare with a token that also has **Account · Cloudflare Tunnel · Edit**.
2. Integrations → Cloudflare → your account → **Tunnels** → **Create tunnel** next to the server. Serve creates the tunnel and runs a `cloudflared` container beside the proxy.
3. Add a domain from that account's zones and choose **Cloudflare Tunnel** in the connection step. Serve creates the DNS record and the tunnel route; Cloudflare serves it over HTTPS.

Disconnecting the account shows which sites go offline, then stops and deletes its tunnels.

### Git providers

- **GitHub** (Git providers → Add provider → GitHub) uses GitHub's app manifest flow. Serve creates a private app, you choose which repositories it may access, and push and pull request events arrive automatically.
- **GitLab, Gitea/Forgejo and Bitbucket** connect with OAuth (create an OAuth application once, following the redirect address and scopes Serve shows) or with an access token. Serve adds the repository webhook when a service is created and removes it when the service is deleted.

Webhooks need the providers to reach the dashboard, so set a public dashboard domain in **Settings → Dashboard & TLS**.

### Roles and permissions

**Organization → Roles** lists what each role can do; **Organization → Members** assigns roles and, under a member's **⋯ → Project access**, limits them to chosen projects.

| Role | Can |
| --- | --- |
| Owner | Everything, including managing owners and deleting the organization |
| Admin | Everything except managing owners and deleting the organization |
| Developer | Deploy, change services, domains and variables, backups, logs and the console. Seeing secret values is off by default and can be turned on under **Roles → Developer** |
| Viewer | Read-only: projects, services, deployments and logs |

Custom roles combine any of the permissions (view and manage projects, deploy, manage services and domains, edit variables, see secret values, backups, logs, console, manage members, manage integrations). Without "see secret values", variable values, database passwords, connection URLs and webhook secrets stay on the server: the dashboard shows them as locked, and saving variables keeps the stored values unless you type new ones. A member who manages members can only hand out roles within their own permissions, and only to projects they can reach.

Organizations that existed before roles keep their behaviour: their members became Developers, and their Developer role includes "see secret values". New organizations start with the stricter default.

## REST API

Create tokens in **Keys & tokens → API tokens** and send them as `Authorization: Bearer srv_…`. Each token has scopes, an optional expiry and an optional list of projects.

| Scope | Allows |
| --- | --- |
| `read` | List services and deployments, read status and logs |
| `read:sensitive` | Read variable values (`GET /api/v1/services/:id/env`) |
| `deploy` | `POST /api/v1/services/:id/deploy`, `/start`, `/stop`, `/restart` |
| `write` | `PATCH /api/v1/services/:id/env` (includes `read` and `deploy`) |
| `admin` | Everything |

Missing scopes return `403`, expired tokens `401`, and services outside the token's projects `404`. Any member can create tokens for themselves; a token never does more than its owner's role allows right now (a role change or removal applies to existing tokens at once), and it only reaches the projects both the token and its owner can reach.

## Development

Requirements: Node.js 22+, pnpm and Docker.

```bash
pnpm install
docker compose -f dev/docker-compose.yml up -d   # PostgreSQL on :5436
cp .env.example .env                             # fill in secrets (openssl rand -hex 32)
pnpm db:migrate
pnpm dev          # dashboard on http://localhost:3000
pnpm dev:worker   # worker; starts the proxy on SERVE_PROXY_HTTP_PORT
```

When the dashboard is opened through another domain during development (for example the dashboard domain through a tunnel), list it in `SERVE_DEV_ORIGINS` so the dev server serves its scripts there.

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | TypeScript checks |
| `pnpm lint` | Lint and format check with Biome |
| `pnpm check` | Apply Biome's safe fixes and formatting |
| `pnpm format` | Format with Biome |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm db:generate` | Create a migration after editing `src/server/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm build` | Production build of the dashboard and the bundled worker |
| `scripts/e2e/run.sh` | Isolated end-to-end instance on :3001 with its own database, data directory and proxy (see `.env.e2e`) |

The scripts in `scripts/e2e/` drive that instance with Playwright (`shot.mjs` takes screenshots, the others exercise deploys, proxies, databases and more).

### Project layout

```
src/app/            Pages, layouts and API routes
src/components/     UI kit (Base UI) and app shell
src/server/         Server-only code
  actions/          Server actions used by the UI
  db/               Drizzle schema, client and migrations runner
  deploy/           Build and deploy pipeline (git, builders, containers, compose)
  proxy/            nginx, Caddy and Traefik configuration, switching and reloads
  servers/          SSH connections, remote Docker and server setup
  mesh/             Private network between servers (WireGuard agent, addresses, links)
  ssl/              Certificates (Let's Encrypt, Cloudflare Origin, uploads)
  cloudflare/       Cloudflare API client and tunnels
  git/              Git providers, OAuth and repository webhooks
  databases/        Database engines and their options
  backups/          Backups, restores, imports and S3
  services/         Variables, templates, previews, tasks and access checks
src/worker/         Worker entry point
drizzle/            SQL migrations
docker/             Production compose file and entrypoint
tests/              Unit tests
```

## Security

- Secrets (variables, tokens, SSH keys, registry and S3 credentials, OAuth tokens) are encrypted with AES-256-GCM before they are stored. API tokens are stored as SHA-256 hashes.
- Every page, action and API route checks organization membership and the member's role permissions and project access. Server-level settings, servers and host access (privileged containers, host mounts, the Docker socket) require admins of the Root organization.
- Webhooks are verified with HMAC signatures or tokens.
- The worker uses the Docker socket, which is equivalent to root on the host. Run Serve on a server dedicated to it.
- `SERVE_DEV_ORIGINS` is for development only; production builds do not serve development assets.

## License

[MIT](LICENSE)
