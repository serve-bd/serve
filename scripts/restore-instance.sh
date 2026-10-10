#!/usr/bin/env bash
# Restores a Serve instance backup (Settings → Backups) on a Docker Compose install.
#
#   sudo bash /data/serve/restore-instance.sh serve-2026-01-01T03-00-00-v0.2.0.tar.gz.enc
#
# Backups ending in .enc are encrypted with a key derived from SERVE_ENCRYPTION_KEY; they are
# decrypted with the Serve image (Node.js), so nothing else needs to be installed.
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
# An explicit -f skips the override file Compose reads by itself: name it too, as updates do.
[ -f "$DATA_DIR/docker-compose.override.yml" ] && COMPOSE+=(-f "$DATA_DIR/docker-compose.override.yml")

fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
info() { printf '\033[1m==>\033[0m %s\n' "$1"; }

[ -n "$BUNDLE" ] || fail "Usage: restore-instance.sh <backup.tar.gz.enc>"
[ -f "$BUNDLE" ] || fail "$BUNDLE not found."
[ -f "$DATA_DIR/docker-compose.yml" ] || fail "$DATA_DIR/docker-compose.yml not found. Run install.sh first."
[ -f "$DATA_DIR/.env" ] || fail "$DATA_DIR/.env not found. Restore it (with the original encryption key) first."
grep -q '^SERVE_ENCRYPTION_KEY=.' "$DATA_DIR/.env" || fail "SERVE_ENCRYPTION_KEY is missing in $DATA_DIR/.env."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ "$BUNDLE" == *.enc ]]; then
  info "Decrypting the backup"
  # Same format as src/server/instance/bundle-crypto.ts: magic, 12-byte IV, AES-256-GCM data, 16-byte tag.
  DECRYPT='
    const crypto = require("node:crypto"), fs = require("node:fs"), { pipeline } = require("node:stream/promises");
    const magic = Buffer.from("SERVEENC1\n"), src = "/in/bundle", dst = "/out/bundle.tar.gz";
    const secret = process.env.SERVE_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET;
    const key = crypto.createHash("sha256").update("serve-instance-backup:").update(secret).digest();
    const size = fs.statSync(src).size, head = magic.length + 12, fd = fs.openSync(src, "r");
    const start = Buffer.alloc(head), tag = Buffer.alloc(16);
    fs.readSync(fd, start, 0, head, 0); fs.readSync(fd, tag, 0, 16, size - 16); fs.closeSync(fd);
    if (!start.subarray(0, magic.length).equals(magic)) { console.error("Not an encrypted Serve backup."); process.exit(1); }
    const d = crypto.createDecipheriv("aes-256-gcm", key, start.subarray(magic.length)); d.setAuthTag(tag);
    pipeline(fs.createReadStream(src, { start: head, end: size - 17 }), d, fs.createWriteStream(dst)).catch(() => {
      console.error("Could not decrypt: the encryption key differs from the one the backup was made with, or the file is damaged."); process.exit(1);
    });'
  "${COMPOSE[@]}" run --rm --no-deps -T -v "$(realpath "$BUNDLE"):/in/bundle:ro" -v "$WORK:/out" --entrypoint node serve -e "$DECRYPT" \
    || fail "Decryption failed."
  BUNDLE="$WORK/bundle.tar.gz"
fi

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

# The database as it is now, first: a restore that fails puts it back.
BEFORE="$DATA_DIR/serve-before-restore-$(date +%Y%m%d-%H%M%S).dump"
info "Saving the current database to $BEFORE"
"${COMPOSE[@]}" exec -T serve-db pg_dump -Fc -U serve -d serve > "$BEFORE" || fail "Could not save the current database; nothing was changed."

# Emptied whole, not object by object: tables a newer version added would otherwise survive next to
# an older migration history, and Serve would not start.
empty_database() {
  "${COMPOSE[@]}" exec -T serve-db psql -v ON_ERROR_STOP=1 -q -U serve -d serve \
    -c 'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
}

info "Restoring the database"
if ! { empty_database && "${COMPOSE[@]}" exec -T serve-db pg_restore --no-owner --exit-on-error --single-transaction -U serve -d serve < "$WORK/database.dump"; }; then
  echo "  The restore failed. Putting the database back as it was."
  { empty_database && "${COMPOSE[@]}" exec -T serve-db pg_restore --no-owner --exit-on-error --single-transaction -U serve -d serve < "$BEFORE"; } \
    || fail "Could not put the database back either. It is saved in $BEFORE (restore it with pg_restore)."
  "${COMPOSE[@]}" up -d
  fail "Nothing was restored; Serve runs as before."
fi

info "Restoring instance files"
tar -xzf "$BUNDLE" -C "$DATA_DIR" --exclude=manifest.json --exclude=database.dump

info "Starting Serve"
"${COMPOSE[@]}" up -d
printf '\033[32m✓\033[0m Restored. Open the dashboard; services redeploy from their saved settings when you deploy them.\n'
