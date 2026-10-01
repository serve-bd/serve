import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { demuxDockerBuffer, imageExists, LABEL, pullImage } from "@/server/docker/client";
import { getServer, type ServerCtx } from "@/server/servers/context";

/*
 * IP allowlists for database public ports, enforced by the server's own firewall.
 *
 * Docker publishes a port two ways, and both are covered:
 *   - Connections it forwards to the container (DNAT) pass the FORWARD chain, where Docker
 *     leaves DOCKER-USER to us. They are matched by the port they were sent to.
 *   - Connections its userland proxy answers (IPv6 without Docker's IPv6 support, for example)
 *     arrive at a local socket and pass INPUT.
 * Docker's ports skip ufw, so a rule there would not help. Rules live in Serve's own chains,
 * rebuilt as a whole on every run, so they survive Docker restarts; a worker tick puts them back
 * after a reboot.
 */

export type AllowEntry = { port: number; allow: string[] };

const HELPER_IMAGE = "alpine:3.22.6";
const FORWARD_CHAIN = "SERVE-DB-ALLOW";
const INPUT_CHAIN = "SERVE-DB-ALLOW-IN";

const isV6 = (range: string) => range.includes(":");

/** Firewall rules for one IP family, in iptables-restore form. */
export function familyRules(entries: AllowEntry[], v6: boolean) {
  const lines: string[] = [`-A ${INPUT_CHAIN} -i lo -j RETURN`];
  for (const e of entries) {
    const ranges = e.allow.filter((r) => isV6(r) === v6);
    const dnat = `-p tcp -m conntrack --ctstate DNAT --ctorigdstport ${e.port} --ctdir ORIGINAL`;
    for (const r of ranges) lines.push(`-A ${FORWARD_CHAIN} ${dnat} -s ${r} -j RETURN`);
    lines.push(`-A ${FORWARD_CHAIN} ${dnat} -j DROP`);
    for (const r of ranges) lines.push(`-A ${INPUT_CHAIN} -p tcp --dport ${e.port} -s ${r} -j RETURN`);
    // New connections only: a reply to a connection the machine opened from that port passes.
    lines.push(`-A ${INPUT_CHAIN} -p tcp --dport ${e.port} -m conntrack --ctstate NEW -j DROP`);
  }
  return lines;
}

/** iptables-restore input that replaces Serve's two chains at once (declaring a chain empties it). */
const ruleset = (lines: string[]) => ["*filter", `:${FORWARD_CHAIN} - [0:0]`, `:${INPUT_CHAIN} - [0:0]`, ...lines, "COMMIT", ""].join("\n");

/**
 * Shell script, run in the host's namespaces, that replaces Serve's database rules. It fails
 * (non-zero, with the reason) unless the rules are in place afterwards: an allowlist that did not
 * apply must never look applied.
 */
export function allowlistScript(entries: AllowEntry[]) {
  const want = entries.length > 0;
  return [
    "set -u",
    'fail() { echo "$*" >&2; exit 1; }',
    // Docker uses either iptables flavour; the rules must go where Docker's own rules are.
    'pick() { for b in nft legacy; do if command -v "$1-$b" >/dev/null 2>&1 && { "$1-$b" -w -t filter -S DOCKER-USER >/dev/null 2>&1 || "$1-$b" -w -t nat -S DOCKER >/dev/null 2>&1; }; then echo "$1-$b"; return; fi; done; if command -v "$1-nft" >/dev/null 2>&1; then echo "$1-nft"; elif command -v "$1" >/dev/null 2>&1; then echo "$1"; fi; }',
    "apply() {",
    // Connections Docker forwards pass DOCKER-USER; without it (another firewall backend), FORWARD.
    "  HOOK=FORWARD; $T -w -S DOCKER-USER >/dev/null 2>&1 && HOOK=DOCKER-USER",
    '  printf "%s" "$1" | $T-restore -w --noflush || fail "$T rejected the rules"',
    `  $T -w -C $HOOK -j ${FORWARD_CHAIN} 2>/dev/null || $T -w -I $HOOK 1 -j ${FORWARD_CHAIN} || fail "could not hook $HOOK"`,
    `  $T -w -C INPUT -j ${INPUT_CHAIN} 2>/dev/null || $T -w -I INPUT 1 -j ${INPUT_CHAIN} || fail "could not hook INPUT"`,
    `  $T -w -C $HOOK -j ${FORWARD_CHAIN} 2>/dev/null && $T -w -C INPUT -j ${INPUT_CHAIN} 2>/dev/null || fail "the rules are not in place on $T"`,
    "}",
    `T=$(pick iptables); [ -n "$T" ] || { ${want ? 'fail "iptables is not installed on this server"' : "exit 0"}; }`,
    `apply '${ruleset(familyRules(entries, false))}'`,
    // IPv6: without ip6tables there is no IPv6 firewall to bypass Docker with, so nothing to do.
    `T=$(pick ip6tables); [ -z "$T" ] || apply '${ruleset(familyRules(entries, true))}'`,
    "echo applied",
  ].join("\n");
}

/** Public ports of a server's databases that have an allowlist. */
export async function allowEntries(serverId: string): Promise<AllowEntry[]> {
  const rows = await db
    .select({ database: schema.service.database })
    .from(schema.service)
    .where(and(eq(schema.service.serverId, serverId), eq(schema.service.type, "database"), isNotNull(schema.service.database)));
  return rows
    .map((r) => r.database)
    .filter((d) => !!d?.publicPort && d.publicBind !== "127.0.0.1" && !!d.publicAllow?.length)
    .map((d) => ({ port: d!.publicPort!, allow: d!.publicAllow! }))
    .sort((a, b) => a.port - b.port);
}

/** Run a script on the server itself: a short-lived privileged container entering the host's namespaces. */
async function onHost(ctx: ServerCtx, script: string) {
  if (!(await imageExists(HELPER_IMAGE, ctx.docker))) await pullImage(HELPER_IMAGE, undefined, null, ctx.docker);
  const container = await ctx.docker.createContainer({
    Image: HELPER_IMAGE,
    Cmd: ["nsenter", "-t", "1", "-m", "-n", "--", "sh", "-c", script],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "firewall" },
    HostConfig: { Privileged: true, PidMode: "host", NetworkMode: "host" },
  });
  try {
    await container.start();
    const { StatusCode } = (await container.wait()) as { StatusCode: number };
    const text = demuxDockerBuffer(await container.logs({ stdout: true, stderr: true })).trim();
    if (StatusCode !== 0) throw new Error(text.split("\n").slice(-2).join(" ") || `exit code ${StatusCode}`);
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

/** What each server last got, so ticks only clear rules once after the last allowlist goes. */
const applied = (globalThis as unknown as { __serveDbAllow?: Map<string, string> }).__serveDbAllow ?? new Map<string, string>();
(globalThis as unknown as { __serveDbAllow?: Map<string, string> }).__serveDbAllow = applied;

/** Whether a server's firewall needs a run: something is listed, or rules may be left from before. */
export async function allowlistsPending(serverId: string) {
  return (await allowEntries(serverId)).length > 0 || applied.get(serverId) !== "[]";
}

/** Put a server's database allowlists in its firewall (and remove rules no longer wanted). */
export async function applyDatabaseAllowlists(serverId: string) {
  const entries = await allowEntries(serverId);
  const ctx = await getServer(serverId);
  await onHost(ctx, allowlistScript(entries));
  applied.set(serverId, JSON.stringify(entries));
  return entries;
}

/**
 * Worker tick: servers with allowlists get their rules again (they are gone after a reboot);
 * a server whose last allowlist went away gets its rules cleared once.
 */
export async function syncDatabaseAllowlists() {
  const servers = await db.select({ id: schema.server.id, status: schema.server.status }).from(schema.server);
  for (const s of servers) {
    if (s.status !== "ready") continue;
    const entries = await allowEntries(s.id);
    // A server this worker has not seen yet gets its rules set once, even to none: an allowlist
    // removed while no worker ran would otherwise leave its DROP rules behind.
    if (!entries.length && applied.get(s.id) === "[]") continue;
    await applyDatabaseAllowlists(s.id).catch((e) => console.error(`[db-allowlist] ${s.id}: ${(e as Error).message}`));
  }
}
