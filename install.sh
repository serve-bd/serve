#!/usr/bin/env bash
# Serve installer.
#   curl -fsSL https://raw.githubusercontent.com/serve-bd/serve/main/install.sh | bash
#
# Without root it restarts itself through sudo, which asks for your password.
# A new install asks for the dashboard and proxy ports; running it again on an installed server
# skips the questions and updates Serve to the newest release (keeping .env).
#
# Environment overrides (a set value is not asked for):
#   SERVE_VERSION           release to install, like 0.2.0 (default: the newest release)
#   SERVE_IMAGE             exact image to run (overrides SERVE_VERSION)
#   SERVE_DASHBOARD_PORT    host port for the dashboard (default 8000)
#   SERVE_PROXY_HTTP_PORT   host port for HTTP traffic to apps (default 80)
#   SERVE_PROXY_HTTPS_PORT  host port for HTTPS traffic to apps (default 443)
#   SERVE_YES=1             ask nothing: use the defaults and overrides
set -euo pipefail

DATA_DIR=/data/serve
REPO="${SERVE_REPO:-serve-bd/serve}"
IMAGE_REPO="${SERVE_IMAGE_REPO:-ghcr.io/$REPO}"
REPO_RAW="${SERVE_REPO_RAW:-https://raw.githubusercontent.com/serve-bd/serve/main}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[34m→\033[0m %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl is required."

# 0. Root ------------------------------------------------------------------------
# Re-run through sudo with the same options. Piped from curl there is no file to re-run, so the
# installer is downloaded again.
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || fail "Run this installer as root: sudo is not installed."
  self="$0"
  if [ ! -f "$self" ] || [ "$(basename "$self")" = bash ]; then
    self="$(mktemp)"
    curl -fsSL "$REPO_RAW/install.sh" -o "$self" || fail "Could not download the installer again to run it with sudo."
    export SERVE_INSTALLER_COPY="$self"
  fi
  printf '  \033[34m→\033[0m %s\n' "Serve installs as root. sudo may ask for your password."
  pass=()
  for v in SERVE_VERSION SERVE_IMAGE SERVE_DASHBOARD_PORT SERVE_PROXY_HTTP_PORT SERVE_PROXY_HTTPS_PORT SERVE_YES SERVE_REPO SERVE_IMAGE_REPO SERVE_REPO_RAW SERVE_INSTALLER_COPY; do
    if [ -n "${!v:-}" ]; then pass+=("$v=${!v}"); fi
  done
  exec sudo env ${pass[@]+"${pass[@]}"} bash "$self" "$@"
fi
# The downloaded copy is open while it runs; removing its name is safe.
if [ -n "${SERVE_INSTALLER_COPY:-}" ]; then rm -f "$SERVE_INSTALLER_COPY"; fi

# Questions are read from the terminal: stdin is the script itself when piped from curl.
INTERACTIVE=0
if [ -z "${SERVE_YES:-}" ] && { : </dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

port_busy() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }

# ask_port VAR "question" default: keeps an override, else asks (Enter keeps the default).
ask_port() {
  local var="$1" question="$2" default="$3" answer
  if [ -n "${!var:-}" ]; then return; fi
  if [ "$INTERACTIVE" = 0 ]; then printf -v "$var" '%s' "$default"; return; fi
  while true; do
    local hint=""
    if port_busy "$default"; then hint=" (in use now)"; fi
    printf '  \033[34m?\033[0m %s [%s%s]: ' "$question" "$default" "$hint" >/dev/tty
    read -r answer </dev/tty || answer=""
    answer="${answer:-$default}"
    if ! [[ "$answer" =~ ^[0-9]+$ ]] || [ "$answer" -lt 1 ] || [ "$answer" -gt 65535 ]; then
      warn "Use a port number from 1 to 65535."
      continue
    fi
    if port_busy "$answer"; then
      printf '    Port %s is in use by another program. Use it anyway? [y/N]: ' "$answer" >/dev/tty
      local yes
      read -r yes </dev/tty || yes=""
      [[ "$yes" =~ ^[Yy] ]] || continue
    fi
    printf -v "$var" '%s' "$answer"
    return
  done
}

# 1. New install or update -----------------------------------------------------------
if [ -f "$DATA_DIR/.env" ]; then
  FIRST_INSTALL=0
  current="$(sed -n 's/^SERVE_IMAGE=//p' "$DATA_DIR/.env" | head -n1)"
  bold "Updating Serve${current:+ (now ${current##*:})}"
  info "Serve is already installed in $DATA_DIR: its settings and ports are kept."
  PORT="$(sed -n 's/^SERVE_DASHBOARD_PORT=//p' "$DATA_DIR/.env" | head -n1)"
  PORT="${PORT:-8000}"
  HTTP_PORT="$(sed -n 's/^SERVE_PROXY_HTTP_PORT=//p' "$DATA_DIR/.env" | head -n1)"
  HTTPS_PORT="$(sed -n 's/^SERVE_PROXY_HTTPS_PORT=//p' "$DATA_DIR/.env" | head -n1)"
  HTTP_PORT="${HTTP_PORT:-80}"
  HTTPS_PORT="${HTTPS_PORT:-443}"
else
  FIRST_INSTALL=1
  bold "Installing Serve"
  if [ "$INTERACTIVE" = 1 ]; then echo "  Press Enter to keep a default."; fi
  PORT="${SERVE_DASHBOARD_PORT:-}"
  HTTP_PORT="${SERVE_PROXY_HTTP_PORT:-}"
  HTTPS_PORT="${SERVE_PROXY_HTTPS_PORT:-}"
  ask_port PORT "Dashboard port" 8000
  ask_port HTTP_PORT "HTTP port for your apps" 80
  ask_port HTTPS_PORT "HTTPS port for your apps" 443
  if [ "$PORT" = "$HTTP_PORT" ] || [ "$PORT" = "$HTTPS_PORT" ] || [ "$HTTP_PORT" = "$HTTPS_PORT" ]; then
    fail "The dashboard, HTTP and HTTPS ports must all be different."
  fi
fi

# 2. Docker ------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required. Update Docker and try again."
ok "Docker $(docker version --format '{{.Server.Version}}')"

# 3. Larger address pools, so many stacks can have their own network ---------
DAEMON=/etc/docker/daemon.json
RUNNING="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ' || echo 0)"
CONFIGURE_DOCKER=1
if [ ! -f "$DAEMON" ] || ! grep -q "default-address-pools" "$DAEMON"; then
  # Changing daemon.json restarts Docker, and with it every container on this server.
  if [ "$RUNNING" -gt 0 ]; then
    if [ "$INTERACTIVE" = 1 ]; then
      printf '  \033[34m?\033[0m Docker must restart once to get larger address pools. %s running containers restart with it. Restart now? [Y/n]: ' "$RUNNING" >/dev/tty
      read -r yes </dev/tty || yes=""
      [[ "$yes" =~ ^[Nn] ]] && CONFIGURE_DOCKER=0
    else
      CONFIGURE_DOCKER=0
    fi
    [ "$CONFIGURE_DOCKER" = 0 ] && warn "Docker is left as it is. Serve still works; it has fewer address ranges for its networks."
  fi
fi
if [ "$CONFIGURE_DOCKER" = 1 ] && { [ ! -f "$DAEMON" ] || ! grep -q "default-address-pools" "$DAEMON"; }; then
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

# 4. Which release ----------------------------------------------------------------
# An exact version, never a moving tag: updates and rollbacks then know what runs.
if [ -z "${SERVE_IMAGE:-}" ]; then
  VERSION="${SERVE_VERSION:-}"
  if [ -z "$VERSION" ]; then
    VERSION="$(curl -fsSL --max-time 10 "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1 || true)"
  fi
  VERSION="${VERSION#v}"
  # No .env yet on a new install: sed fails, and with pipefail that must not stop the script.
  CURRENT="$(sed -n 's/^SERVE_IMAGE=//p' "$DATA_DIR/.env" 2>/dev/null | head -n1 || true)"
  if [ -n "$VERSION" ]; then
    IMAGE="$IMAGE_REPO:$VERSION"
  elif [ -n "$CURRENT" ]; then
    # GitHub did not answer (rate limit, offline): keep what runs instead of switching channels.
    IMAGE="$CURRENT"
    printf '  \033[33m!\033[0m Could not look up the newest release; keeping %s.\n' "$IMAGE"
  else
    IMAGE="$IMAGE_REPO:latest"
  fi
else
  IMAGE="$SERVE_IMAGE"
fi
ok "Serve image $IMAGE"

# 5. Data directory and secrets ------------------------------------------------
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
SERVE_PROXY_HTTP_PORT=$HTTP_PORT
SERVE_PROXY_HTTPS_PORT=$HTTPS_PORT
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

# 6. Image and compose file -----------------------------------------------------------
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

# 7. Ports ---------------------------------------------------------------------------
for p in "$HTTP_PORT" "$HTTPS_PORT" "$PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    if ! docker ps --format '{{.Names}}' | grep -qE '^(serve|serve-proxy)$'; then
      printf '  \033[33m!\033[0m Port %s is already in use. Serve may not start its proxy until it is free.\n' "$p"
    fi
  fi
done

# 8. Start ------------------------------------------------------------------------------
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
