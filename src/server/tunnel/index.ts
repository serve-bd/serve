import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { utils } from "ssh2";

/**
 * Servers without a public address connect out to Serve: they keep `ssh -R` open to the tunnel
 * listener in the worker, and the worker opens a relay port per server that leads to its sshd.
 * Everything else (deploys, terminals, the private network) uses that relay like any SSH host.
 */

/** Port the tunnel listener answers on (inside the worker, and published on the host). */
export const tunnelPort = () => Number(process.env.SERVE_TUNNEL_PORT ?? 7822);

/** Installed with Docker Compose: the web and the worker are separate containers. */
const inCompose = () => !!process.env.SERVE_ROLE;

/** Where the web and the worker reach the relays: the worker container, or this machine. */
export const relayHost = () => process.env.SERVE_RELAY_HOST ?? (inCompose() ? "serve-worker" : "127.0.0.1");

/** Address relays listen on: the Compose network, or only this machine. */
export const relayBind = () => process.env.SERVE_RELAY_BIND ?? (inCompose() ? "0.0.0.0" : "127.0.0.1");

/** Relay ports are handed out from here, one per tunnelled server. */
export const RELAY_PORTS = { from: 42000, to: 42999 };

export function allocateRelayPort(taken: Set<number>): number | null {
  for (let p = RELAY_PORTS.from; p <= RELAY_PORTS.to; p++) if (!taken.has(p)) return p;
  return null;
}

/** How long a join command works. */
export const JOIN_TTL_MS = 24 * 60 * 60_000;

export function newJoinToken() {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token), expiresAt: new Date(Date.now() + JOIN_TTL_MS).toISOString() };
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function tokenMatches(hash: string | null, token: string) {
  if (!hash) return false;
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(hashToken(token), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** known_hosts line for the listener, as OpenSSH writes it for a non-standard port. */
export const knownHostsLine = (address: string, port: number, publicKey: string) => `${port === 22 ? address : `[${address}]:${port}`} ${publicKey}`;

/** "<type> <base64>" of an OpenSSH public key line, or null when it is not one. */
export function normalizePublicKey(line: string): string | null {
  const parsed = utils.parseKey(line.trim());
  if (parsed instanceof Error || Array.isArray(parsed)) return null;
  if (parsed.isPrivateKey()) return null;
  return `${parsed.type} ${parsed.getPublicSSH().toString("base64")}`;
}

/** A value quoted for a POSIX shell. */
export const sh = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

/**
 * Script the server runs once (as root): a key for the tunnel, Serve's key in authorized_keys,
 * and a service that keeps the tunnel open (systemd, or a background loop without it).
 */
export function installScript(opts: { joinUrl: string; user: string }) {
  return `#!/usr/bin/env bash
# Connects this machine to Serve through an outgoing SSH tunnel.
set -euo pipefail
JOIN_URL=${sh(opts.joinUrl)}
EXPECTED_USER=${sh(opts.user)}
DIR=/etc/serve-tunnel

say() { printf '\\033[1m==>\\033[0m %s\\n' "$*"; }
fail() { printf '\\033[31mError:\\033[0m %s\\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "Run this as root: curl -fsSL <command> | sudo bash"
[ "$(uname -s)" = Linux ] || fail "Only Linux is supported."
command -v curl >/dev/null || fail "curl is required."

install_pkg() {
  if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q "$@" >/dev/null
  elif command -v yum >/dev/null; then yum install -y -q "$@" >/dev/null
  elif command -v apk >/dev/null; then apk add -q "$@" >/dev/null
  elif command -v pacman >/dev/null; then pacman -Sy --noconfirm "$@" >/dev/null
  else fail "Install $* and run this again."; fi
}

if ! command -v ssh >/dev/null || ! command -v ssh-keygen >/dev/null; then
  say "Installing the SSH client"
  if command -v apt-get >/dev/null; then install_pkg openssh-client; else install_pkg openssh-clients || install_pkg openssh; fi
fi
if ! command -v sshd >/dev/null && [ ! -x /usr/sbin/sshd ]; then
  say "Installing the SSH server (Serve signs in through the tunnel)"
  install_pkg openssh-server
fi
if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1 || true
elif ! pgrep -x sshd >/dev/null; then
  mkdir -p /run/sshd; ssh-keygen -A >/dev/null 2>&1 || true; "$(command -v sshd || echo /usr/sbin/sshd)"
fi

# Checked before registering, so a problem here does not use up the command.
getent passwd "$EXPECTED_USER" >/dev/null || fail "The user $EXPECTED_USER does not exist on this machine. Create it, or add the server in Serve again with another user."
if [ "$EXPECTED_USER" = root ]; then
  PRL=$("$(command -v sshd || echo /usr/sbin/sshd)" -T 2>/dev/null | awk '/^permitrootlogin /{print $2}' || true)
  [ "$PRL" != no ] || fail "This machine's SSH server does not let root sign in (PermitRootLogin no). Add the server in Serve again with a user that has passwordless sudo, or allow root to sign in with keys."
fi

mkdir -p "$DIR"; chmod 700 "$DIR"
[ -f "$DIR/key" ] || ssh-keygen -q -t ed25519 -N "" -C "serve-tunnel@$(hostname)" -f "$DIR/key"

say "Registering with Serve"
CODE=$(curl -sS -o "$DIR/join.txt" -w '%{http_code}' -X POST --data-urlencode "publicKey=$(cat "$DIR/key.pub")" --data-urlencode "hostname=$(hostname)" "$JOIN_URL") \\
  || fail "Could not reach Serve at $JOIN_URL."
[ "$CODE" = 200 ] || fail "Serve refused this command ($CODE): $(head -c 300 "$DIR/join.txt"). A command works once and for 24 hours: create a new one on the server's page."
RESPONSE=$(cat "$DIR/join.txt"); rm -f "$DIR/join.txt"
SERVE_KEY=""; SSH_USER=""; SSH_PORT=""; TUNNEL_HOST=""; TUNNEL_PORT=""; KNOWN_HOSTS=""
while IFS= read -r line; do
  case "$line" in
    SERVE_KEY=*) SERVE_KEY="\${line#SERVE_KEY=}" ;;
    SSH_USER=*) SSH_USER="\${line#SSH_USER=}" ;;
    SSH_PORT=*) SSH_PORT="\${line#SSH_PORT=}" ;;
    TUNNEL_HOST=*) TUNNEL_HOST="\${line#TUNNEL_HOST=}" ;;
    TUNNEL_PORT=*) TUNNEL_PORT="\${line#TUNNEL_PORT=}" ;;
    KNOWN_HOSTS=*) KNOWN_HOSTS="\${line#KNOWN_HOSTS=}" ;;
  esac
done <<< "$RESPONSE"
[ -n "$SERVE_KEY" ] && [ -n "$TUNNEL_HOST" ] || fail "Unexpected answer from Serve."

HOME_DIR=$(getent passwd "$SSH_USER" | cut -d: -f6) || fail "The user $SSH_USER does not exist on this machine."
say "Letting Serve sign in as $SSH_USER"
mkdir -p "$HOME_DIR/.ssh"; touch "$HOME_DIR/.ssh/authorized_keys"
grep -qxF "$SERVE_KEY" "$HOME_DIR/.ssh/authorized_keys" || printf '%s\\n' "$SERVE_KEY" >> "$HOME_DIR/.ssh/authorized_keys"
chmod 700 "$HOME_DIR/.ssh"; chmod 600 "$HOME_DIR/.ssh/authorized_keys"; chown -R "$SSH_USER": "$HOME_DIR/.ssh"
printf '%s\\n' "$KNOWN_HOSTS" > "$DIR/known_hosts"

SSH_BIN=$(command -v ssh)
ARGS="-NT -i $DIR/key -p $TUNNEL_PORT -o BatchMode=yes -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$DIR/known_hosts -R 22:localhost:$SSH_PORT serve@$TUNNEL_HOST"

if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/serve-tunnel.service <<UNIT
[Unit]
Description=Serve tunnel (lets Serve reach this machine without a public address)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$SSH_BIN $ARGS
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable serve-tunnel >/dev/null 2>&1
  systemctl restart serve-tunnel
  say "Connected. The tunnel starts again after reboots (systemctl status serve-tunnel)."
else
  cat > "$DIR/run.sh" <<RUN
#!/bin/sh
while true; do $SSH_BIN $ARGS; sleep 5; done
RUN
  chmod 700 "$DIR/run.sh"
  pkill -f "$DIR/run.sh" 2>/dev/null || true
  nohup "$DIR/run.sh" >/var/log/serve-tunnel.log 2>&1 &
  say "Connected. Without systemd the tunnel does not start again after a reboot: run $DIR/run.sh then."
fi
`;
}
