#!/usr/bin/env bash
# Lets the dashboard's SSH key log in to the local test server.
#   scripts/dev-server/add-key.sh [name] "<public key>"
set -euo pipefail
if [ $# -eq 1 ]; then NAME=serve-dev-ubuntu; KEY=$1; else NAME=$1; KEY=${2:?public key required}; fi
docker exec -i "$NAME" bash -c 'cat >> /home/ubuntu/.ssh/authorized_keys' <<<"$KEY"
echo "Key added to $NAME."
