#!/usr/bin/env bash
# Simulates GitHub pull_request webhooks against the e2e instance.
set -euo pipefail
SVC="$1"
q() { docker exec serve-dev-db psql -U serve -d serve_e2e -tAc "$1"; }
q "update service set previews_enabled=true where id='$SVC'" >/dev/null
SEC=$(q "select webhook_secret from service where id='$SVC'")
U="http://localhost:3001/api/webhooks/git/$SVC"
send() {
  B="{\"action\":\"$1\",\"number\":7,\"pull_request\":{\"number\":7,\"title\":\"Try new header\",\"head\":{\"ref\":\"main\",\"sha\":\"deadbeef1234\",\"repo\":{\"clone_url\":\"https://github.com/heroku/node-js-getting-started.git\"}},\"user\":{\"login\":\"ada\"}},\"repository\":{\"full_name\":\"heroku/node-js-getting-started\"}}"
  SIG=$(printf '%s' "$B" | openssl dgst -sha256 -hmac "$SEC" | awk '{print $2}')
  curl -s -X POST "$U" -H 'x-github-event: pull_request' -H "x-hub-signature-256: sha256=$SIG" -d "$B"; echo
}
send opened
for _ in $(seq 1 60); do
  st=$(q "select status from service where parent_service_id='$SVC'")
  [ "$st" = running ] || [ "$st" = failed ] && break
  sleep 2
done
q "select name, status, slug from service where parent_service_id='$SVC'"
H=$(q "select d.hostname from domain d join service s on s.id=d.service_id where s.parent_service_id='$SVC'")
curl -s -o /dev/null -w "preview http: %{http_code}\n" -H "Host: $H" http://localhost:8081/
send closed
sleep 6
echo "previews left: $(q "select count(*) from service where parent_service_id='$SVC'")"
