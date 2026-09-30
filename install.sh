#!/usr/bin/env bash
# Serve installer.
#   curl -fsSL https://raw.githubusercontent.com/shahriyardx/serve/main/install.sh | sudo bash
#
# Running it again on an installed server updates Serve to the newest release (keeping .env).
#
# Environment overrides:
#   SERVE_VERSION         release to install, like 0.2.0 (default: the newest release)
#   SERVE_IMAGE           exact image to run (overrides SERVE_VERSION)
#   SERVE_DASHBOARD_PORT  host port for the dashboard (default 8000)
#   SERVE_DATA_DIR        must stay /data/serve (bind-mount paths are shared with Docker)
set -euo pipefail

DATA_DIR=/data/serve
REPO="${SERVE_REPO:-shahriyardx/serve}"
IMAGE_REPO="${SERVE_IMAGE_REPO:-ghcr.io/$REPO}"
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

# 3. Which release ----------------------------------------------------------------
# An exact version, never a moving tag: updates and rollbacks then know what runs.
if [ -z "${SERVE_IMAGE:-}" ]; then
  VERSION="${SERVE_VERSION:-}"
  if [ -z "$VERSION" ]; then
    VERSION="$(curl -fsSL --max-time 10 "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1 || true)"
  fi
  VERSION="${VERSION#v}"
  CURRENT="$(sed -n 's/^SERVE_IMAGE=//p' "$DATA_DIR/.env" 2>/dev/null | head -n1)"
  if [ -n "$VERSION" ]; then
    IMAGE="$IMAGE_REPO:$VERSION"
  elif [ -n "$CURRENT" ]; then
    # GitHub did not answer (rate limit, offline): keep what runs instead of switching channels.
    IMAGE="$CURRENT"
    printf '  \033[33m!\033[0m Could not look up the newest release; keeping %s.\n' "$IMAGE"
  else
    IMAGE="$IMAGE_REPO:edge"
  fi
else
  IMAGE="$SERVE_IMAGE"
fi
ok "Serve image $IMAGE"

# 4. Data directory and secrets ------------------------------------------------
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
IP="$(curl -fsS -4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"

FIRST_INSTALL=0
if [ ! -f "$DATA_DIR/.env" ]; then
  FIRST_INSTALL=1
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
  # Running the installer again moves the install to the chosen release.
  if grep -q '^SERVE_IMAGE=' "$DATA_DIR/.env"; then
    awk -v img="$IMAGE" '/^SERVE_IMAGE=/ { print "SERVE_IMAGE=" img; next } { print }' "$DATA_DIR/.env" > "$DATA_DIR/.env.next"
    cat "$DATA_DIR/.env.next" > "$DATA_DIR/.env" && rm -f "$DATA_DIR/.env.next"
  else
    echo "SERVE_IMAGE=$IMAGE" >> "$DATA_DIR/.env"
  fi
fi

# 5. Image and compose file -----------------------------------------------------------
# The stack definition comes from the image itself, so it always matches the code it runs.
info "Pulling $IMAGE"
docker pull --quiet "$IMAGE" >/dev/null || fail "Could not pull $IMAGE."
from_image() { docker run --rm --entrypoint cat "$IMAGE" "/app/deploy/$1" > "$2.next" 2>/dev/null && [ -s "$2.next" ] && mv "$2.next" "$2"; }
if ! from_image compose.yml "$DATA_DIR/docker-compose.yml"; then
  rm -f "$DATA_DIR/docker-compose.yml.next"
  curl -fsSL "$REPO_RAW/docker/compose.yml" -o "$DATA_DIR/docker-compose.yml"
fi
if ! from_image restore-instance.sh "$DATA_DIR/restore-instance.sh"; then
  rm -f "$DATA_DIR/restore-instance.sh.next"
  curl -fsSL "$REPO_RAW/scripts/restore-instance.sh" -o "$DATA_DIR/restore-instance.sh"
fi
chmod 700 "$DATA_DIR/restore-instance.sh"

# 6. Ports ---------------------------------------------------------------------------
for p in 80 443 "$PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    if ! docker ps --format '{{.Names}}' | grep -qE '^(serve|serve-proxy)$'; then
      printf '  \033[33m!\033[0m Port %s is already in use. Serve may not start its proxy until it is free.\n' "$p"
    fi
  fi
done

# 7. Start ------------------------------------------------------------------------------
info "Starting Serve"
cd "$DATA_DIR"
docker compose pull --quiet
docker compose up -d --remove-orphans

info "Waiting for the dashboard"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    ok "Serve is running"
    echo
    if [ "$FIRST_INSTALL" = 1 ]; then bold "Open http://$IP:$PORT to create your owner account."; else bold "Serve runs $IMAGE."; fi
    echo "  Data lives in $DATA_DIR. Update from Settings → Updates in the dashboard,"
    echo "  or run this installer again to move to the newest release."
    exit 0
  fi
  sleep 3
done
fail "Serve did not become healthy. Check logs with: cd $DATA_DIR && docker compose logs"
