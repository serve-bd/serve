#!/usr/bin/env bash
# Restores a Serve instance backup (Settings → Backups) on a Docker Compose install.
#
#   sudo bash /data/serve/restore-instance.sh serve-2026-01-01T03-00-00-v0.2.0.tar.gz
#
# It stops Serve, restores the database dump and the instance files into the data
# directory, and starts Serve again. /data/serve/.env must hold the SAME encryption key
# (SERVE_ENCRYPTION_KEY) as when the backup was made: backups never contain it.
#
# Environment:
#   SERVE_DATA_DIR   data directory (default /data/serve)
set -euo pipefail

BUNDLE="${1:-}"
DATA_DIR="${SERVE_DATA_DIR:-/data/serve}"
COMPOSE=(docker compose --project-directory "$DATA_DIR" -f "$DATA_DIR/docker-compose.yml")

fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
info() { printf '\033[1m==>\033[0m %s\n' "$1"; }

[ -n "$BUNDLE" ] || fail "Usage: restore-instance.sh <backup.tar.gz>"
[ -f "$BUNDLE" ] || fail "$BUNDLE not found."
[ -f "$DATA_DIR/docker-compose.yml" ] || fail "$DATA_DIR/docker-compose.yml not found. Run install.sh first."
[ -f "$DATA_DIR/.env" ] || fail "$DATA_DIR/.env not found. Restore it (with the original encryption key) first."
grep -q '^SERVE_ENCRYPTION_KEY=.' "$DATA_DIR/.env" || fail "SERVE_ENCRYPTION_KEY is missing in $DATA_DIR/.env."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

info "Checking the backup"
tar -xzf "$BUNDLE" -C "$WORK" manifest.json database.dump || fail "Not a Serve instance backup (manifest.json or database.dump missing)."
grep -q '"kind": "serve-instance-backup"' "$WORK/manifest.json" || fail "manifest.json does not describe a Serve instance backup."
grep -E '"(version|createdAt|schemaVersion)"' "$WORK/manifest.json" | sed 's/^ */    /'

read -r -p "This replaces Serve's database and instance files in $DATA_DIR. Continue? [y/N] " answer
[ "${answer,,}" = "y" ] || fail "Cancelled."

info "Stopping Serve"
"${COMPOSE[@]}" stop serve serve-worker

info "Starting the database"
"${COMPOSE[@]}" up -d serve-db
for _ in $(seq 1 60); do
  "${COMPOSE[@]}" exec -T serve-db pg_isready -U serve >/dev/null 2>&1 && break
  sleep 1
done

info "Restoring the database"
"${COMPOSE[@]}" exec -T serve-db pg_restore --clean --if-exists --no-owner -U serve -d serve < "$WORK/database.dump" \
  || echo "  pg_restore reported warnings (usually objects that did not exist yet); check the output above."

info "Restoring instance files"
tar -xzf "$BUNDLE" -C "$DATA_DIR" --exclude=manifest.json --exclude=database.dump

info "Starting Serve"
"${COMPOSE[@]}" up -d
printf '\033[32m✓\033[0m Restored. Open the dashboard; services redeploy from their saved settings when you deploy them.\n'
