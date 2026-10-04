import { sh } from "@/server/tunnel";

/**
 * Shell scripts that put a machine in the tailnet. POSIX sh (they also run through `sh -c` on the
 * machine the dashboard runs on), except the join command's script, which is bash like the tunnel's.
 */

/** Installs Tailscale when missing, starts its service, and reads its state into TS_* variables. */
const FUNCTIONS = `ts_fail() { printf '\\033[31mError:\\033[0m %s\\n' "$*" >&2; exit 1; }
ts_install() {
  command -v tailscale >/dev/null 2>&1 && return 0
  printf '\\033[1m==>\\033[0m %s\\n' "Installing Tailscale (the official script from tailscale.com)"
  curl -fsSL https://tailscale.com/install.sh | sh || ts_fail "Tailscale could not be installed on this system. Install it by hand (https://tailscale.com/download/linux), then try again."
  command -v tailscale >/dev/null 2>&1 || ts_fail "Tailscale could not be installed on this system. Install it by hand (https://tailscale.com/download/linux), then try again."
}
ts_start() {
  tailscale status --json >/dev/null 2>&1 && return 0
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl enable --now tailscaled >/dev/null 2>&1 || true
  elif command -v rc-service >/dev/null 2>&1; then rc-update add tailscale default >/dev/null 2>&1 || true; rc-service tailscale start >/dev/null 2>&1 || true
  else mkdir -p /var/lib/tailscale; nohup tailscaled --state=/var/lib/tailscale/tailscaled.state >/var/log/tailscaled.log 2>&1 &
  fi
  i=0
  while [ $i -lt 20 ]; do tailscale status --json >/dev/null 2>&1 && return 0; i=$((i + 1)); sleep 1; done
  ts_fail "The Tailscale service (tailscaled) does not run. Start it, then try again."
}
ts_field() { { printf '%s' "$TS_STATUS" | grep -o "\\"$1\\": *\\"[^\\"]*\\"" | head -1 | sed 's/.*: *"\\(.*\\)"/\\1/'; } || true; }
ts_read() {
  TS_STATUS=$(tailscale status --json --peers=false 2>/dev/null || true)
  TS_STATE=$(ts_field BackendState)
  TS_NODEKEY=$(ts_field PublicKey)
  TS_SUFFIX=$(ts_field MagicDNSSuffix)
  TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || true)
}`;

/** Prints the state of Tailscale on the machine as KEY=value lines (see parseProbe). Installs nothing. */
export const PROBE_SCRIPT = `${FUNCTIONS}
[ "$(uname -s)" = Linux ] || { echo TS_OS=unsupported; exit 0; }
if ! command -v tailscale >/dev/null 2>&1; then echo TS_INSTALLED=0; exit 0; fi
echo TS_INSTALLED=1
tailscale status --json >/dev/null 2>&1 || { echo TS_STATE=NoDaemon; exit 0; }
ts_read
echo "TS_STATE=$TS_STATE"
echo "TS_NODEKEY=$TS_NODEKEY"
echo "TS_SUFFIX=$TS_SUFFIX"
echo "TS_IP=$TS_IP"`;

/** A node key as Tailscale prints it; a logged-out machine shows none or only zeros. */
export const realNodeKey = (v: string | null | undefined) => (v && /^nodekey:[0-9a-f]{16,}$/.test(v) && !/^nodekey:0+$/.test(v) ? v : null);

export type Probe = { os: "linux" | "unsupported"; installed: boolean; state: string | null; nodeKey: string | null; suffix: string | null; ip: string | null };

/** Reads the KEY=value lines of the probe (or of the join script). */
export function parseProbe(output: string): Probe {
  const get = (k: string) => output.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() || null;
  const nodeKey = get("TS_NODEKEY");
  return {
    os: get("TS_OS") === "unsupported" ? "unsupported" : "linux",
    installed: get("TS_INSTALLED") !== "0",
    state: get("TS_STATE"),
    nodeKey: realNodeKey(nodeKey),
    suffix: get("TS_SUFFIX"),
    ip: get("TS_IP"),
  };
}

/**
 * Installs Tailscale if needed and joins the tailnet with a single-use auth key, as `hostname`.
 * A machine in another tailnet is only moved with `reauth` (the caller asked for it). Ends with
 * the probe lines of the joined machine.
 */
export function upScript(opts: { authKey: string; hostname: string; reauth: boolean }) {
  return `${FUNCTIONS}
[ "$(uname -s)" = Linux ] || ts_fail "Tailscale through Serve works on Linux only."
command -v curl >/dev/null 2>&1 || ts_fail "curl is required."
ts_install
ts_start
printf '\\033[1m==>\\033[0m %s\\n' ${sh(`Joining the tailnet as ${opts.hostname}`)}
tailscale up --reset --auth-key=${sh(opts.authKey)} --hostname=${sh(opts.hostname)} --timeout=90s${opts.reauth ? " --force-reauth" : ""} || ts_fail "tailscale up failed (see above). If it says the tags are not permitted, set the tag's owner in the tailnet policy."
ts_read
[ -n "$TS_IP" ] || ts_fail "Tailscale is up but has no address yet. Try again in a minute."
echo "TS_STATE=$TS_STATE"
echo "TS_NODEKEY=$TS_NODEKEY"
echo "TS_SUFFIX=$TS_SUFFIX"
echo "TS_IP=$TS_IP"`;
}

/** Brings a machine that is already in the tailnet up again (after `tailscale down`). */
export const RESUME_SCRIPT = `${FUNCTIONS}
ts_start
ts_read
[ "$TS_STATE" = Running ] || tailscale up --timeout=60s || ts_fail "tailscale up failed (see above)."
ts_read
echo "TS_STATE=$TS_STATE"
echo "TS_NODEKEY=$TS_NODEKEY"
echo "TS_SUFFIX=$TS_SUFFIX"
echo "TS_IP=$TS_IP"`;

/**
 * Script of the join command (`curl … | sudo bash`) of a server that connects through Tailscale:
 * the SSH server and Serve's key first, then Tailscale with an auth key Serve makes at that moment
 * (so it never runs out while the command waits), then Serve looks the machine up in the tailnet.
 * Running it again is safe: a machine already in the tailnet only reports its address again.
 */
export function joinScript(opts: { joinUrl: string; user: string }) {
  return `#!/usr/bin/env bash
# Connects this machine to Serve through Tailscale.
set -euo pipefail
JOIN_URL=${sh(opts.joinUrl)}
EXPECTED_USER=${sh(opts.user)}
FORCE="\${SERVE_TAILSCALE_FORCE:-0}"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

say() { printf '\\033[1m==>\\033[0m %s\\n' "$*"; }
fail() { printf '\\033[31mError:\\033[0m %s\\n' "$*" >&2; exit 1; }
${FUNCTIONS}

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

if ! command -v sshd >/dev/null && [ ! -x /usr/sbin/sshd ]; then
  say "Installing the SSH server (Serve signs in through Tailscale)"
  install_pkg openssh-server
fi
if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1 || true
elif ! pgrep -x sshd >/dev/null; then
  mkdir -p /run/sshd; ssh-keygen -A >/dev/null 2>&1 || true; "$(command -v sshd || echo /usr/sbin/sshd)"
fi

# Checked before asking for a key, so a problem here costs nothing.
getent passwd "$EXPECTED_USER" >/dev/null || fail "The user $EXPECTED_USER does not exist on this machine. Create it, or add the server in Serve again with another user."
if [ "$EXPECTED_USER" = root ]; then
  PRL=$("$(command -v sshd || echo /usr/sbin/sshd)" -T 2>/dev/null | awk '/^permitrootlogin /{print $2}' || true)
  [ "$PRL" != no ] || fail "This machine's SSH server does not let root sign in (PermitRootLogin no). Add the server in Serve again with a user that has passwordless sudo, or allow root to sign in with keys."
fi

ts_install
ts_start
ts_read

post() {
  CODE=$(curl -sS -o "$TMP" -w '%{http_code}' -X POST "$@" "$JOIN_URL") || fail "Could not reach Serve at $JOIN_URL."
  [ "$CODE" = 200 ] || fail "$(head -c 600 "$TMP" | tr -d '\\n') (HTTP $CODE)"
}
value() { sed -n "s/^$1=//p" "$TMP" | head -1; }

say "Asking Serve for a Tailscale key"
post --data-urlencode "step=key" --data-urlencode "state=$TS_STATE" --data-urlencode "nodeKey=$TS_NODEKEY" --data-urlencode "suffix=$TS_SUFFIX" --data-urlencode "force=$FORCE"
SERVE_KEY=$(value SERVE_KEY); SSH_USER=$(value SSH_USER); TS_HOSTNAME=$(value TS_HOSTNAME); AUTH_KEY=$(value AUTH_KEY); ALREADY=$(value ALREADY)
[ -n "$SERVE_KEY" ] && [ -n "$SSH_USER" ] || fail "Unexpected answer from Serve."

HOME_DIR=$(getent passwd "$SSH_USER" | cut -d: -f6) || fail "The user $SSH_USER does not exist on this machine."
say "Letting Serve sign in as $SSH_USER"
mkdir -p "$HOME_DIR/.ssh"; touch "$HOME_DIR/.ssh/authorized_keys"
grep -qxF "$SERVE_KEY" "$HOME_DIR/.ssh/authorized_keys" || printf '%s\\n' "$SERVE_KEY" >> "$HOME_DIR/.ssh/authorized_keys"
chmod 700 "$HOME_DIR/.ssh"; chmod 600 "$HOME_DIR/.ssh/authorized_keys"; chown -R "$SSH_USER": "$HOME_DIR/.ssh"

if [ "$ALREADY" = 1 ]; then
  say "This machine is in the tailnet already"
  [ "$TS_STATE" = Running ] || tailscale up --timeout=60s || fail "tailscale up failed (see above)."
else
  [ -n "$AUTH_KEY" ] && [ -n "$TS_HOSTNAME" ] || fail "Unexpected answer from Serve."
  say "Joining the tailnet as $TS_HOSTNAME"
  REAUTH=""
  [ -z "$TS_NODEKEY" ] || [ "$TS_STATE" = NeedsLogin ] || REAUTH="--force-reauth"
  # shellcheck disable=SC2086
  tailscale up --reset --auth-key="$AUTH_KEY" --hostname="$TS_HOSTNAME" --timeout=90s $REAUTH \\
    || fail "tailscale up failed (see above). If it says the tags are not permitted, set the tag's owner in the tailnet policy (Integrations, Tailscale in Serve shows how)."
fi
ts_read
[ -n "$TS_IP" ] && [ -n "$TS_NODEKEY" ] || fail "Tailscale is up but has no address yet. Run this command again in a minute."

say "Telling Serve this machine's Tailscale address ($TS_IP)"
post --data-urlencode "step=done" --data-urlencode "nodeKey=$TS_NODEKEY" --data-urlencode "ip=$TS_IP"
say "Connected. Serve reaches this machine at $TS_IP through Tailscale."
`;
}
