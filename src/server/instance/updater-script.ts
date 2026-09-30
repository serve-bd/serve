/** Exit code of the update container when the new version failed and the previous one runs again. */
export const ROLLED_BACK_EXIT = 2;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell script the one-shot update container runs. It uses the NEW image, so the stack
 * definition it installs (/app/deploy/compose.yml) always matches the code it starts.
 *
 *   1. Keep the current compose file, install the new one and the restore script.
 *   2. Point SERVE_IMAGE in .env at the new release, pull the other images, restart the stack.
 *   3. Wait until the dashboard is healthy on the new image and the worker stays up.
 *   4. On any failure, put the old compose file and image back and restart them (exit 2).
 *
 * The database keeps what the new version migrated: migrations only add, so the previous
 * version still runs on it; the backup taken first is there to go back completely.
 */
export function updaterScript(o: { dir: string; previousImage: string; image: string; healthTimeoutSeconds?: number; settleSeconds?: number }) {
  const timeout = o.healthTimeoutSeconds ?? 300;
  const settle = o.settleSeconds ?? 20;
  return `set -u
D=${q(o.dir)}
F="$D/docker-compose.yml"
PREV=${q(o.previousImage)}
NEW=${q(o.image)}

compose() {
  if [ -f "$D/docker-compose.override.yml" ]; then
    docker compose --project-directory "$D" -f "$F" -f "$D/docker-compose.override.yml" "$@"
  else
    docker compose --project-directory "$D" -f "$F" "$@"
  fi
}

# Rewrites SERVE_IMAGE in place (same file, same permissions).
set_image() {
  awk -v img="$1" 'BEGIN { done = 0 } /^SERVE_IMAGE=/ { print "SERVE_IMAGE=" img; done = 1; next } { print } END { if (!done) print "SERVE_IMAGE=" img }' "$D/.env" > "$D/.env.next" \\
    && cat "$D/.env.next" > "$D/.env" && rm -f "$D/.env.next"
}

rollback() {
  echo "!! $1"
  echo "==> Going back to $PREV"
  if [ -f "$D/docker-compose.previous.yml" ]; then cp "$D/docker-compose.previous.yml" "$F"; fi
  set_image "$PREV"
  if compose up -d --remove-orphans; then
    echo "The previous version runs again. Nothing was lost; the backup taken before the update is kept."
  else
    echo "!! Could not start the previous version either. Run: cd $D && docker compose up -d"
  fi
  exit ${ROLLED_BACK_EXIT}
}

echo "==> Installing the stack definition of the new version"
cp "$F" "$D/docker-compose.previous.yml" || { echo "!! Could not keep a copy of $F"; exit 1; }
if [ -f /app/deploy/compose.yml ]; then cp /app/deploy/compose.yml "$F" || rollback "Could not write $F"; fi
if [ -f /app/deploy/restore-instance.sh ]; then cp /app/deploy/restore-instance.sh "$D/restore-instance.sh" && chmod 700 "$D/restore-instance.sh"; fi
set_image "$NEW" || rollback "Could not write $D/.env"
compose config --quiet || rollback "The new stack definition is not valid"

echo "==> Pulling images"
compose pull --quiet --ignore-pull-failures

echo "==> Restarting on $NEW"
# Give the worker that started this container a moment to record that it is running.
sleep 2
compose up -d --remove-orphans || rollback "docker compose could not start the new version"

echo "==> Waiting for the dashboard to report healthy"
waited=0
while :; do
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' serve 2>/dev/null || echo missing)
  image=$(docker inspect -f '{{.Config.Image}}' serve 2>/dev/null || echo missing)
  if [ "$health" = healthy ] && [ "$image" = "$NEW" ]; then break; fi
  if [ "$health" = unhealthy ]; then
    docker logs --tail 30 serve 2>&1 | sed 's/^/   /'
    rollback "The new dashboard reports unhealthy"
  fi
  if [ "$waited" -ge ${timeout} ]; then
    docker logs --tail 30 serve 2>&1 | sed 's/^/   /'
    rollback "The new dashboard did not become healthy within ${timeout} seconds"
  fi
  sleep 5
  waited=$((waited + 5))
done
echo "Dashboard is healthy"

echo "==> Checking that the worker stays up"
sleep ${settle}
worker=$(docker inspect -f '{{.State.Status}} {{.RestartCount}} {{.Config.Image}}' serve-worker 2>/dev/null || echo missing)
if [ "$worker" != "running 0 $NEW" ]; then
  docker logs --tail 30 serve-worker 2>&1 | sed 's/^/   /'
  rollback "The new worker did not stay up ($worker)"
fi
echo "Serve runs $NEW."
`;
}
