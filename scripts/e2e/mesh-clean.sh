#!/usr/bin/env bash
# Removes the projects scripts/e2e/mesh-deploy.mts created, with their containers on the test servers.
#   set -a; source .env; source .env.e2e; set +a; scripts/e2e/mesh-clean.sh serve-e2e-remote serve-e2e-remote-2
set -euo pipefail
psql "$DATABASE_URL" -Atc "select s.id||' '||s.slug from service s join project p on p.id=s.project_id where p.name like 'mesh-%'" | while read -r id slug; do
  [ -z "$id" ] && continue
  for h in "$@"; do
    docker exec "$h" sh -c "docker ps -aq --filter label=serve.service=$id | xargs -r docker rm -f >/dev/null; docker volume ls -q | grep '^serve-$slug-' | xargs -r docker volume rm >/dev/null; docker network ls -q --filter name=${slug}_default | xargs -r docker network rm >/dev/null" 2>/dev/null || true
  done
done
psql "$DATABASE_URL" -Atc "delete from project where name like 'mesh-%'" >/dev/null
for h in "$@"; do
  docker exec "$h" sh -c 'docker ps -aq --filter label=serve.kind=mesh-link | xargs -r docker rm -f >/dev/null; docker network ls --format "{{.Name}}" | grep "^serve-env-" | xargs -r docker network rm >/dev/null 2>&1' || true
done
echo "cleaned"
