#!/usr/bin/env bash
# Stops the e2e web and worker processes started by run.sh.
cd "$(dirname "$0")/../.."
root="$PWD"
for pid in $(pgrep -f "next-server|next dev|tsx"); do
  [ "$pid" = "$$" ] && continue
  [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$root" ] || continue
  if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx 'NEXT_DIST_DIR=.next-e2e'; then
    kill "$pid" 2>/dev/null && echo "stopped $pid"
  fi
done
