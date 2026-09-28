#!/bin/sh
set -e
case "$1" in
  web)
    node /app/worker.cjs --migrate
    exec node /app/server.js
    ;;
  worker)
    exec node /app/worker.cjs
    ;;
  migrate)
    exec node /app/worker.cjs --migrate
    ;;
  *)
    exec "$@"
    ;;
esac
