#!/bin/sh
set -e
if [ -n "$AUTHORIZED_KEY" ]; then
  echo "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi
/usr/sbin/sshd -e
exec dockerd-entrypoint.sh "$@"
