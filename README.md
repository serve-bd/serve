# Serve

Serve is a self-hosted platform for running apps, databases and services on your own servers. Push to deploy, get a domain with HTTPS, attach a database with backups, and manage it all from one dashboard.

## What it does

- **Apps** from Git (GitHub, GitLab, Gitea/Forgejo, Bitbucket or any Git URL), a Docker image, a Dockerfile or a Docker Compose file. Builds with a Dockerfile, Nixpacks or built-in detection.
- **Databases:** PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey and ClickHouse, with scheduled backups to disk or S3 and one-click restore.
- **One-click services** from a catalog (n8n, Uptime Kuma, Plausible, Ghost, Nextcloud, Vaultwarden, Grafana, MinIO and more), plus your own templates.
- **Deployments** with zero downtime, health checks, rollbacks, pull request previews, deploy hooks and an API.
- **Domains and HTTPS** through nginx, Caddy or Traefik, with Let's Encrypt certificates renewed automatically.
- **Cloudflare:** DNS records and Tunnels, for servers without a public IP.
- **Many servers** over SSH, including machines behind NAT, joined by an encrypted private network.
- **Teams:** organizations, roles, project access, two-factor authentication and an activity log.

## Requirements

- A Linux server (Ubuntu, Debian, Fedora, Rocky…) with 2 GB of RAM or more (builds need it).
- Root access. The installer installs Docker if it is missing.

Use a server dedicated to Serve: it controls Docker, which is equal to root on the host.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/serve-bd/serve/main/install.sh | bash
```

The installer asks for your sudo password if you are not root. On a new server it asks for three ports; press Enter to keep the defaults:

- Dashboard: `8000`
- HTTP for your apps: `80`
- HTTPS for your apps: `443`

Then open `http://<server-ip>:<dashboard port>`, create the owner account and follow the setup guide.

The installer writes its secrets to `/data/serve/.env` and starts three containers: the dashboard (`serve`), the worker (`serve-worker`) and Serve's database (`serve-db`). Everything Serve keeps lives in `/data/serve`. Do not move that directory. If other containers already run on the server, it asks before it restarts Docker.

## After install

1. **Settings → Dashboard & TLS:** give the dashboard a domain with HTTPS. Git webhooks need it.
2. **Git providers:** connect GitHub (one click) or another provider.
3. **Projects → New project → New service:** add an app, database or service, check its settings, then deploy.
4. **Servers → Add server** (optional): add more machines over SSH, or with **No public IP** for machines behind NAT. Those machines connect out to this server on TCP port 7822, so open that port.

## Updating

**Settings → Updates** shows new releases. **Update now** backs up Serve first, then installs the new version, and rolls back if it does not start. Your apps keep running during the update.

To update by hand, run the install command again. It sees that Serve is installed, asks nothing and keeps your `.env` and ports.

## Backup and restore

**Settings → Backups** backs up Serve itself: its database, certificates, proxy configuration and service files. The backups go to `/data/serve/backups/instance` and, if you want, to S3. The data of your apps and databases is not in these backups. Back up each database from its **Backups** tab.

> **Save your encryption key.** Secrets are encrypted with `SERVE_ENCRYPTION_KEY` from `/data/serve/.env`. It is never in a backup, and without it a restored Serve cannot read them. Keep it in a password manager. **Settings → Backups → Show encryption key** shows it.

To restore, put the original `SERVE_ENCRYPTION_KEY` in `/data/serve/.env`, then run:

```bash
sudo bash /data/serve/restore-instance.sh serve-<date>-v<version>.tar.gz
```

## Ports

You pick the dashboard and app ports during install. The defaults:

| Port | Used for |
| --- | --- |
| 80, 443 (TCP) | Your apps, through the proxy |
| 8000 (TCP) | The dashboard, until it has a domain |
| 7822 (TCP) | Only when a server without a public IP is added |
| 51820 (UDP) | Only between servers in a private network |

## License

[MIT](LICENSE)
