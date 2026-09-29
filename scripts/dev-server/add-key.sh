#!/usr/bin/env bash
# Lets the dashboard's SSH key log in to the local test server.
#   scripts/dev-server/add-key.sh [name] <public key>     (quotes around the key are optional)
set -euo pipefail
if [[ ${1:-} == ssh-* || ${1:-} == ecdsa-* ]]; then NAME=serve-dev-ubuntu; else NAME=${1:?server name or key required}; shift; fi
KEY="$*"
if ! [[ $KEY =~ ^(ssh-[a-z0-9-]+|ecdsa-[a-z0-9-]+)\ [A-Za-z0-9+/=]{40,} ]]; then
  echo "That does not look like a whole public key (ssh-ed25519 AAAA… name). Copy the full line from the dashboard." >&2
  exit 1
fi
# Drop broken lines from earlier attempts, then add this key once.
docker exec -i "$NAME" bash -c 'f=/home/ubuntu/.ssh/authorized_keys; grep -E "^(ssh|ecdsa)-[a-z0-9-]+ [A-Za-z0-9+/=]{40,}" "$f" > "$f.tmp" || true; mv "$f.tmp" "$f"; chown ubuntu:ubuntu "$f"; chmod 600 "$f"; key=$(cat); grep -qxF "$key" "$f" || echo "$key" >> "$f"' <<<"$KEY"
echo "Key added to $NAME."
