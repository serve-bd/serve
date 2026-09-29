#!/usr/bin/env bash
# Starts a fake remote server for multi-server e2e tests.
#   scripts/e2e/remote/run.sh "<public key line>"
# SSH: localhost:2222 (root), proxy: localhost:8090 (HTTP) / localhost:8453 (HTTPS).
set -euo pipefail
cd "$(dirname "$0")"
NAME=${REMOTE_NAME:-serve-e2e-remote}
docker build -q -t serve-e2e-remote . >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --privileged \
  -e AUTHORIZED_KEY="${1:?public key required}" \
  -e DOCKER_TLS_CERTDIR= \
  -p 2222:22 -p 8090:80 -p 8453:443 \
  -v serve-e2e-remote-docker:/var/lib/docker \
  serve-e2e-remote >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" docker info >/dev/null 2>&1 && { echo "remote server ready: ssh root@localhost -p 2222"; exit 0; }
  sleep 1
done
echo "remote dockerd did not start" >&2
docker logs "$NAME" | tail -20 >&2
exit 1
