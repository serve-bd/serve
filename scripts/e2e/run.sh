#!/usr/bin/env bash
# Starts an isolated e2e instance (web on :3001 + worker) using .env.e2e.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source .env.e2e; set +a
mkdir -p .data/logs
nohup npx next dev -p 3001 > .data/logs/web-e2e.log 2>&1 &
nohup npx tsx watch --clear-screen=false src/worker/index.ts > .data/logs/worker-e2e.log 2>&1 &
echo "e2e instance starting on http://localhost:3001"
