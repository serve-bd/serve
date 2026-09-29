#!/usr/bin/env bash
# Serve installer.
#   curl -fsSL https://raw.githubusercontent.com/shahriyardx/serve/main/install.sh | sudo bash
#
# Environment overrides:
#   SERVE_IMAGE           image to run (default ghcr.io/shahriyardx/serve:latest)
#   SERVE_DASHBOARD_PORT  host port for the dashboard (default 8000)
#   SERVE_DATA_DIR        must stay /data/serve (bind-mount paths are shared with Docker)
set -euo pipefail

DATA_DIR=/data/serve
IMAGE="${SERVE_IMAGE:-ghcr.io/shahriyardx/serve:latest}"
PORT="${SERVE_DASHBOARD_PORT:-8000}"
REPO_RAW="${SERVE_REPO_RAW:-https://raw.githubusercontent.com/shahriyardx/serve/main}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[34m→\033[0m %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run this installer as root (for example with sudo)."
command -v curl >/dev/null || fail "curl is required."

bold "Installing Serve"

# 1. Docker ------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required. Update Docker and try again."
ok "Docker $(docker version --format '{{.Server.Version}}')"

# 2. Larger address pools, so many stacks can have their own network ---------
DAEMON=/etc/docker/daemon.json
if [ ! -f "$DAEMON" ] || ! grep -q "default-address-pools" "$DAEMON"; then
  info "Configuring Docker address pools and log rotation"
  if [ -f "$DAEMON" ] && command -v python3 >/dev/null; then
    python3 - "$DAEMON" <<'PY'
import json, sys
path = sys.argv[1]
try:
    data = json.load(open(path))
except Exception:
    data = {}
data.setdefault("default-address-pools", [{"base": "10.200.0.0/12", "size": 24}])
data.setdefault("log-driver", "json-file")
data.setdefault("log-opts", {"max-size": "20m", "max-file": "5"})
json.dump(data, open(path, "w"), indent=2)
PY
  else
    mkdir -p /etc/docker
    cat > "$DAEMON" <<'JSON'
{
  "default-address-pools": [{ "base": "10.200.0.0/12", "size": 24 }],
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
JSON
  fi
  systemctl restart docker >/dev/null 2>&1 || service docker restart >/dev/null 2>&1 || true
  ok "Docker configured"
fi

# 3. Data directory and secrets ------------------------------------------------
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
IP="$(curl -fsS -4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"

if [ ! -f "$DATA_DIR/.env" ]; then
  info "Generating secrets"
  rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
  DB_PASSWORD="$(rand 32)"
  cat > "$DATA_DIR/.env" <<ENV
# Serve configuration. Keep this file secret.
SERVE_IMAGE=$IMAGE
SERVE_DASHBOARD_PORT=$PORT
SERVE_DB_PASSWORD=$DB_PASSWORD
DATABASE_URL=postgres://serve:$DB_PASSWORD@serve-db:5432/serve
BETTER_AUTH_SECRET=$(rand 64)
SERVE_ENCRYPTION_KEY=$(rand 64)
BETTER_AUTH_URL=http://$IP:$PORT
SERVE_DATA_DIR=$DATA_DIR
SERVE_NETWORK=serve
SERVE_PROXY_HTTP_PORT=80
SERVE_PROXY_HTTPS_PORT=443
SERVE_DASHBOARD_UPSTREAM=serve:3000
ENV
  chmod 600 "$DATA_DIR/.env"
  ok "Secrets written to $DATA_DIR/.env"
else
  ok "Keeping existing $DATA_DIR/.env"
fi

# 4. Compose file ------------------------------------------------------------------
info "Downloading the stack definition"
curl -fsSL "$REPO_RAW/docker/compose.yml" -o "$DATA_DIR/docker-compose.yml"
curl -fsSL "$REPO_RAW/scripts/restore-instance.sh" -o "$DATA_DIR/restore-instance.sh" && chmod 700 "$DATA_DIR/restore-instance.sh"

# 5. Ports ---------------------------------------------------------------------------
for p in 80 443 "$PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    if ! docker ps --format '{{.Names}}' | grep -qE '^(serve|serve-proxy)$'; then
      printf '  \033[33m!\033[0m Port %s is already in use. Serve may not start its proxy until it is free.\n' "$p"
    fi
  fi
done

# 6. Start ------------------------------------------------------------------------------
info "Starting Serve"
cd "$DATA_DIR"
docker compose pull --quiet
docker compose up -d --remove-orphans

info "Waiting for the dashboard"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    ok "Serve is running"
    echo
    bold "Open http://$IP:$PORT to create your owner account."
    echo "  Data lives in $DATA_DIR. Upgrade later with: cd $DATA_DIR && docker compose pull && docker compose up -d"
    exit 0
  fi
  sleep 3
done
fail "Serve did not become healthy. Check logs with: cd $DATA_DIR && docker compose logs"
