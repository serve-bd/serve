#!/bin/bash
# No systemd in a container: start Docker (once installed) and SSH by hand.
set -e
if command -v dockerd >/dev/null 2>&1 && ! pgrep -x dockerd >/dev/null; then
  (dockerd >/var/log/dockerd.log 2>&1 &)
fi
exec /usr/sbin/sshd -D -e
