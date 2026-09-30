import { createHash } from "node:crypto";

/**
 * The private network agent: a small container on every server in the private network.
 * It keeps the WireGuard interface, its addresses and the firewall rules in line with
 * config.json (written by Serve) and the running containers, and reports to status.json.
 *
 * Traffic flow, for a container on server A reaching service X on server B:
 *   A: X's private name resolves (Docker DNS) to a small "link" container on the environment
 *      network, which forwards everything to X's mesh address → routed into WireGuard, source
 *      rewritten to the address of the environment on A (SNAT).
 *   B: the mesh address is rewritten to X's container (DNAT), allowed only from the
 *      addresses of X's own environment on the other servers.
 * Names stay in Docker DNS, so they follow a service that moves between servers.
 */
export const AGENT_SCRIPT = String.raw`#!/bin/sh
set -u
DIR=/etc/serve-mesh
CONF=$DIR/config.json
STATUS=$DIR/status.json
IF=serve-mesh
SOCK=/var/run/docker.sock
TMP=/tmp/serve-mesh
IMAGE=$(printenv SERVE_MESH_IMAGE || echo serve-mesh:latest)
MODE=kernel
ERR=""
LAST=""
IPT=iptables-nft
umask 077
mkdir -p $TMP

log() { echo "[serve-mesh] $*"; }

# Docker uses either iptables flavour; the rules must go where Docker's own rules are.
pick_backend() {
  if iptables-nft -t nat -S DOCKER >/dev/null 2>&1 || iptables-nft -t filter -S DOCKER-USER >/dev/null 2>&1; then IPT=iptables-nft
  elif iptables-legacy -t nat -S DOCKER >/dev/null 2>&1 || iptables-legacy -t filter -S DOCKER-USER >/dev/null 2>&1; then IPT=iptables-legacy
  else IPT=iptables-nft; fi
}

ensure_iface() {
  ip link show $IF >/dev/null 2>&1 && return 0
  if ip link add $IF type wireguard 2>$TMP/link.err; then MODE=kernel; LAST=""; return 0; fi
  log "kernel WireGuard is not available ($(cat $TMP/link.err)); starting wireguard-go"
  MODE=userspace
  LAST=""
  WG_PROCESS_FOREGROUND=0 wireguard-go $IF >$TMP/wg-go.log 2>&1 || return 1
  ip link show $IF >/dev/null 2>&1
}

# Put a rule at the top of a chain (Docker inserts its own rules above ours at times).
first() {
  t=$1; c=$2; shift 2
  if [ "$($IPT -t $t -S $c 2>/dev/null | sed -n 2p)" != "-A $c $*" ]; then
    while $IPT -t $t -D $c "$@" 2>/dev/null; do :; done
    $IPT -t $t -I $c 1 "$@"
  fi
}

jumps() {
  first nat PREROUTING -j SERVE-MESH-PRE
  first nat POSTROUTING -j SERVE-MESH-POST
  if $IPT -t filter -S DOCKER-USER >/dev/null 2>&1; then first filter DOCKER-USER -j SERVE-MESH-FWD; else first filter FORWARD -j SERVE-MESH-FWD; fi
  first filter INPUT -j SERVE-MESH-IN
  first mangle FORWARD -j SERVE-MESH-MSS
}

apply() {
  jq -e .privateKey $CONF >/dev/null 2>&1 || { ERR="The configuration file is missing."; return 1; }
  ensure_iface || { ERR="Could not create the WireGuard interface: $(cat $TMP/link.err $TMP/wg-go.log 2>/dev/null | tail -2)"; return 1; }

  curl -sf -G --unix-socket $SOCK --data-urlencode 'filters={"label":["serve.service"],"status":["running"]}' http://docker/containers/json >$TMP/containers.json \
    || { ERR="Could not list containers through the Docker socket."; return 1; }
  echo '{}' >$TMP/nets.json
  for n in $(jq -r '[.sources[].networks[]] | unique | .[]' $CONF); do
    s=$(curl -sf --unix-socket $SOCK "http://docker/networks/$n" | jq -c '[.IPAM.Config[]?.Subnet | select(. != null and (contains(":") | not))]') || s='[]'
    [ -n "$s" ] || s='[]'
    jq --arg n "$n" --argjson s "$s" '. + {($n): $s}' $TMP/nets.json >$TMP/nets.next && mv $TMP/nets.next $TMP/nets.json
  done

  jq -r -f /usr/local/share/serve-mesh/wg.jq $CONF >$TMP/wg.conf
  jq -r --arg if $IF --slurpfile c $TMP/containers.json --slurpfile nets $TMP/nets.json -f /usr/local/share/serve-mesh/rules.jq $CONF >$TMP/rules
  jq -r '[.address] + .localAddresses | unique | .[]' $CONF >$TMP/addresses
  sig=$(cat $TMP/wg.conf $TMP/rules $TMP/addresses | md5sum | cut -d' ' -f1)-$IPT

  if [ "$sig" != "$LAST" ]; then
    wg syncconf $IF $TMP/wg.conf 2>$TMP/wg.err || { ERR="WireGuard rejected the configuration: $(head -1 $TMP/wg.err)"; return 1; }
    ip -o -4 addr show dev $IF | awk '{print $4}' | cut -d/ -f1 | sort -u >$TMP/have
    for a in $(cat $TMP/addresses); do grep -qx "$a" $TMP/have || ip addr add "$a/32" dev $IF; done
    for a in $(cat $TMP/have); do grep -qx "$a" $TMP/addresses || ip addr del "$a/32" dev $IF; done
    ip link set $IF mtu "$(jq -r '.mtu // 1420' $CONF)" up
    src=$(jq -r .address $CONF)
    for r in $(jq -r '.routes[]' $CONF); do
      # Another interface already uses the range (a VPN, for example): do not take it over.
      other=$(ip -4 route show root "$r" | grep -v "dev $IF" | head -1)
      [ -z "$other" ] || { ERR="The private range $r is already used on this server ($other)."; return 1; }
      ip route replace "$r" dev $IF src "$src"
    done
    $IPT-restore --noflush <$TMP/rules 2>$TMP/ipt.err || { ERR="The firewall rules were rejected: $(head -1 $TMP/ipt.err)"; return 1; }
    LAST=$sig
    log "applied ($(grep -c DNAT $TMP/rules) forwarded addresses, $(grep -c '^\[Peer\]' $TMP/wg.conf) peers, $IPT)"
  fi
  jumps 2>$TMP/jumps.err || { ERR="Could not install the firewall rules: $(head -1 $TMP/jumps.err)"; LAST=""; return 1; }
  links || { ERR="Could not start the name forwarders: $(tail -1 $TMP/links.err 2>/dev/null)"; return 1; }
  ERR=""
  return 0
}

api() { curl -sf --unix-socket $SOCK "$@"; }

# One "link" container per service on another server, on each environment network that uses it.
# It answers to the service's names and forwards every connection into the private network.
links() {
  : >$TMP/links.err
  api -G --data-urlencode all=1 --data-urlencode 'filters={"label":["serve.kind=mesh-link"]}' http://docker/containers/json >$TMP/links.json || { echo "Docker did not answer" >$TMP/links.err; return 1; }
  jq -c --arg img "$IMAGE" -f /usr/local/share/serve-mesh/links.jq $CONF >$TMP/links.want
  jq -r '.[] | "\(.Names[0] | ltrimstr("/")) \(.Labels["serve.mesh-link"] // "")"' $TMP/links.json | while read -r name spec; do
    jq -e --arg n "$name" --arg s "$spec" 'select(.name == $n and .spec == $s)' $TMP/links.want >/dev/null 2>&1 && continue
    api -X DELETE "http://docker/containers/$name?force=1" >/dev/null || echo "Could not remove $name" >>$TMP/links.err
  done
  while read -r want; do
    name=$(echo "$want" | jq -r .name)
    state=$(jq -r --arg n "/$name" --arg s "$(echo "$want" | jq -r .spec)" '.[] | select(.Names[0] == $n and .Labels["serve.mesh-link"] == $s) | .State' $TMP/links.json)
    [ "$state" = "running" ] && continue
    if [ -z "$state" ]; then
      echo "$want" | jq -c .body | api -X POST -H 'Content-Type: application/json' -d @- "http://docker/containers/create?name=$name" >/dev/null 2>>$TMP/links.err || {
        # The environment network does not exist here yet (nothing of it deployed): try again later.
        api "http://docker/networks/$(echo "$want" | jq -r .network)" >/dev/null || continue
        echo "Could not create $name" >>$TMP/links.err; continue; }
    fi
    api -X POST "http://docker/containers/$name/start" >/dev/null || echo "Could not start $name" >>$TMP/links.err
  done <$TMP/links.want
  [ ! -s $TMP/links.err ]
}

# Inside a link container: send everything addressed to it on to the service's mesh address.
link() {
  me=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)
  iptables -t nat -C PREROUTING -d "$me" -j DNAT --to-destination "$1" 2>/dev/null || iptables -t nat -A PREROUTING -d "$me" -j DNAT --to-destination "$1"
  iptables -t nat -C POSTROUTING -d "$1" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -d "$1" -j MASQUERADE
  trap 'exit 0' TERM INT
  while :; do sleep 3600 & wait $!; done
}

status() {
  wg show $IF dump 2>/dev/null | tail -n +2 >$TMP/dump || : >$TMP/dump
  jq -R -s -c --arg err "$ERR" --arg mode "$MODE" --arg ipt "$IPT" --arg hash "$(jq -r '.hash // ""' $CONF 2>/dev/null)" --argjson now "$(date +%s)" '
    { ok: ($err == ""), error: (if $err == "" then null else $err end), mode: $mode, firewall: $ipt, hash: $hash, updatedAt: $now,
      peers: [split("\n")[] | select(length > 0) | split("\t") | { publicKey: .[0], endpoint: (if .[2] == "(none)" then null else .[2] end),
        latestHandshake: (.[4] | tonumber), rx: (.[5] | tonumber), tx: (.[6] | tonumber) }] }' $TMP/dump >$STATUS.tmp && chmod 644 $STATUS.tmp && mv $STATUS.tmp $STATUS
}

down() {
  pick_backend
  for spec in "nat PREROUTING SERVE-MESH-PRE" "nat POSTROUTING SERVE-MESH-POST" "filter DOCKER-USER SERVE-MESH-FWD" "filter FORWARD SERVE-MESH-FWD" "filter INPUT SERVE-MESH-IN" "mangle FORWARD SERVE-MESH-MSS"; do
    set -- $spec
    while $IPT -t $1 -D $2 -j $3 2>/dev/null; do :; done
    $IPT -t $1 -F $3 2>/dev/null
    $IPT -t $1 -X $3 2>/dev/null
  done
  ip link del $IF 2>/dev/null
  api -G --data-urlencode all=1 --data-urlencode 'filters={"label":["serve.kind=mesh-link"]}' http://docker/containers/json 2>/dev/null \
    | jq -r '.[].Id' 2>/dev/null | while read -r id; do api -X DELETE "http://docker/containers/$id?force=1" >/dev/null; done
  rm -f $STATUS
  log "removed"
}

if [ "$#" -gt 0 ] && [ "$1" = "down" ]; then down; exit 0; fi
if [ "$#" -gt 1 ] && [ "$1" = "link" ]; then link "$2"; exit 0; fi

trap 'exit 0' TERM INT
trap ':' USR1
log "starting"
while :; do
  pick_backend
  apply || log "$ERR"
  status
  sleep 3 &
  wait $! 2>/dev/null
  kill $! 2>/dev/null
done
`;

/** WireGuard configuration (wg syncconf format) from config.json. */
export const WG_JQ = String.raw`"[Interface]\nPrivateKey = \(.privateKey)\nListenPort = \(.listenPort)\n\n"
+ ([.peers[] | "[Peer]\nPublicKey = \(.publicKey)\nAllowedIPs = \(.allowedIps | join(", "))\n"
  + (if .endpoint then "Endpoint = \(.endpoint)\n" else "" end)
  + "PersistentKeepalive = 25\n"] | join("\n"))
`;

/**
 * Firewall rules (iptables-restore format) from config.json, the running containers ($c)
 * and the subnets of the environment networks ($nets). Declaring a chain empties it, so each
 * run replaces Serve's chains atomically and leaves every other rule alone.
 */
export const RULES_JQ = String.raw`def targets($e):
  [$c[0][]
    | select(.Labels["serve.service"] == $e.service and .Labels["serve.kind"] != "predeploy")
    | select($e.compose == null or .Labels["com.docker.compose.service"] == $e.compose)
    | select($e.deployment == null or .Labels["serve.deployment"] == null or .Labels["serve.deployment"] == $e.deployment)
    | (if $e.network then .NetworkSettings.Networks[$e.network].IPAddress else ([.NetworkSettings.Networks[].IPAddress | select(. != "")] | first) end)
    | select(. != null and . != "")] | unique;
def dnat($e):
  targets($e) as $t | ($t | length) as $n
  | range(0; $n) as $i
  | "-A SERVE-MESH-PRE -i \($if) -d \($e.ip)/32"
    + (if $i < $n - 1 then " -m statistic --mode random --probability \(1 / ($n - $i))" else "" end)
    + " -j DNAT --to-destination \($t[$i])";
. as $cfg
| ([.sources[] | . as $s | ([.networks[] | $nets[0][.] // [] | .[]] + .subnets | unique | .[]) | "-A SERVE-MESH-POST -o \($if) -s \(.) -j SNAT --to-source \($s.ip)"]) as $snat
| ([.exposures[] | dnat(.)]) as $dnat
| ([.exposures[] | . as $e | .allow[] | "-A SERVE-MESH-FWD -i \($if) -s \(.)/32 -m conntrack --ctorigdst \($e.ip)/32 -j ACCEPT"]) as $allow
| (["*nat", ":SERVE-MESH-PRE - [0:0]", ":SERVE-MESH-POST - [0:0]"] + $dnat + $snat + ["COMMIT",
   "*filter", ":SERVE-MESH-FWD - [0:0]", ":SERVE-MESH-IN - [0:0]",
   "-A SERVE-MESH-FWD -o \($if) -j ACCEPT",
   "-A SERVE-MESH-FWD -i \($if) -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"]
   + $allow
   + ["-A SERVE-MESH-FWD -i \($if) -j DROP",
   "-A SERVE-MESH-IN -p udp --dport \($cfg.listenPort) -j ACCEPT",
   "-A SERVE-MESH-IN -i \($if) -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
   "-A SERVE-MESH-IN -i \($if) -p icmp -j ACCEPT",
   "-A SERVE-MESH-IN -i \($if) -j DROP",
   "COMMIT",
   "*mangle", ":SERVE-MESH-MSS - [0:0]",
   "-A SERVE-MESH-MSS -o \($if) -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu",
   "-A SERVE-MESH-MSS -i \($if) -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu",
   "COMMIT"]) | join("\n")
`;

/** Link containers to run, from config.json: name, a spec that changes when they must be recreated, and the create body. */
export const LINKS_JQ = `.imports[] | . as $i
| ($i.ip + "|" + $i.network + "|" + ($i.aliases | join(",")) + "|" + $img) as $spec
| { name: $i.name, spec: $spec, network: $i.network, body: {
    Image: $img, Cmd: ["link", $i.ip],
    Labels: { "serve.managed": "true", "serve.kind": "mesh-link", "serve.mesh-link": $spec },
    HostConfig: {
      NetworkMode: $i.network, CapAdd: ["NET_ADMIN"], Sysctls: { "net.ipv4.ip_forward": "1" },
      RestartPolicy: { Name: "unless-stopped" }, LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } } },
    NetworkingConfig: { EndpointsConfig: { ($i.network): { Aliases: $i.aliases } } } } }
`;

// Pinned base: WireGuard tools come from its package repository when the agent is built. The
// agent is rebuilt on every server when this file changes, so a release that moves the base
// also brings newer WireGuard tools. The WireGuard module itself is part of the host's kernel.
export const AGENT_BASE = "alpine:3.22.6";
export const AGENT_DOCKERFILE = `FROM ${AGENT_BASE}
RUN apk add --no-cache wireguard-tools-wg wireguard-go iproute2 iptables iptables-legacy jq curl
COPY agent.sh /usr/local/bin/serve-mesh
COPY wg.jq rules.jq links.jq /usr/local/share/serve-mesh/
RUN chmod +x /usr/local/bin/serve-mesh
ENTRYPOINT ["/usr/local/bin/serve-mesh"]
`;

/** Changes whenever the agent changes, so servers rebuild it. */
export const AGENT_VERSION = createHash("sha256").update(AGENT_SCRIPT).update(WG_JQ).update(RULES_JQ).update(LINKS_JQ).update(AGENT_DOCKERFILE).digest("hex").slice(0, 12);
export const AGENT_IMAGE = `serve-mesh:${AGENT_VERSION}`;
export const AGENT_CONTAINER = "serve-mesh";
export const MESH_INTERFACE = "serve-mesh";
