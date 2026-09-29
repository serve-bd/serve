#!/usr/bin/env bash
# A local Ubuntu "server" to add to the dashboard, for multi-server testing without a VPS.
#
#   scripts/dev-server/run.sh [name] [ssh-port] [http-port] [https-port]
#   scripts/dev-server/add-key.sh [name] "<public key from the dashboard>"
#
# Add it in Servers → Add server with host 127.0.0.1 (pnpm dev) or host.docker.internal (dashboard in Docker),
# the SSH port printed below, user "ubuntu". Its data survives restarts (a Docker volume).
set -euo pipefail
cd "$(dirname "$0")"
NAME=${1:-serve-dev-ubuntu}
SSH_PORT=${2:-2223}
HTTP_PORT=${3:-8091}
HTTPS_PORT=${4:-8454}
docker build -q -t serve-dev-ubuntu . >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --hostname "$NAME" --privileged --cgroupns=private \
  --add-host=host.docker.internal:host-gateway \
  -p "$SSH_PORT:22" -p "$HTTP_PORT:80" -p "$HTTPS_PORT:443" \
  -v "$NAME-docker:/var/lib/docker" -v "$NAME-home:/home/ubuntu" -v "$NAME-etc-docker:/etc/docker" \
  serve-dev-ubuntu >/dev/null
# Keep the ubuntu user's .ssh correct on a fresh home volume.
docker exec "$NAME" bash -c 'install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh && touch /home/ubuntu/.ssh/authorized_keys && chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys && chmod 600 /home/ubuntu/.ssh/authorized_keys'
cat <<INFO
$NAME is running (Ubuntu 24.04, no Docker yet).
  Host:  127.0.0.1 when the dashboard runs with pnpm dev; host.docker.internal when it runs in Docker
  Port:  $SSH_PORT     User: ubuntu     Proxy: http://localhost:$HTTP_PORT  https://localhost:$HTTPS_PORT
Next: add it in Servers → Add server, then run
  scripts/dev-server/add-key.sh $NAME "<public key shown there>"
INFO
