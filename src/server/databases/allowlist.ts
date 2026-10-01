import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { imageExists, LABEL, pullImage } from "@/server/docker/client";
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

/** Firewall rules for one IP family. */
export function familyRules(entries: AllowEntry[], v6: boolean) {
  const lines: string[] = [];
  for (const e of entries) {
    const ranges = e.allow.filter((r) => isV6(r) === v6);
    const dnat = `-p tcp -m conntrack --ctstate DNAT --ctorigdstport ${e.port} --ctdir ORIGINAL`;
    for (const r of ranges) lines.push(`$T -A ${FORWARD_CHAIN} ${dnat} -s ${r} -j RETURN`);
    lines.push(`$T -A ${FORWARD_CHAIN} ${dnat} -j DROP`);
    for (const r of ranges) lines.push(`$T -A ${INPUT_CHAIN} -p tcp --dport ${e.port} -s ${r} -j RETURN`);
    lines.push(`$T -A ${INPUT_CHAIN} -p tcp --dport ${e.port} -j DROP`);
  }
  return lines;
}

/** Shell script, run in the host's namespaces, that replaces Serve's database rules. */
export function allowlistScript(entries: AllowEntry[]) {
  return [
    "set -u",
    // Docker uses either iptables flavour; the rules must go where Docker's own rules are.
    'pick() { for b in nft legacy; do if command -v "$1-$b" >/dev/null 2>&1 && { "$1-$b" -t filter -S DOCKER-USER >/dev/null 2>&1 || "$1-$b" -t nat -S DOCKER >/dev/null 2>&1; }; then echo "$1-$b"; return; fi; done; command -v "$1" >/dev/null 2>&1 && echo "$1"; }',
    "rules() {",
    `  $T -N ${FORWARD_CHAIN} 2>/dev/null; $T -F ${FORWARD_CHAIN}`,
    `  $T -N ${INPUT_CHAIN} 2>/dev/null; $T -F ${INPUT_CHAIN}`,
    `  $T -A ${INPUT_CHAIN} -i lo -j RETURN`,
    '  if [ "$F" = 6 ]; then',
    ...familyRules(entries, true).map((l) => `    ${l}`),
    "    :",
    "  else",
    ...familyRules(entries, false).map((l) => `    ${l}`),
    "    :",
    "  fi",
    // Jumps first in their chains (Docker inserts its own rules above ours at times).
    `  if $T -S DOCKER-USER >/dev/null 2>&1; then while $T -D DOCKER-USER -j ${FORWARD_CHAIN} 2>/dev/null; do :; done; $T -I DOCKER-USER 1 -j ${FORWARD_CHAIN}; fi`,
    `  while $T -D INPUT -j ${INPUT_CHAIN} 2>/dev/null; do :; done; $T -I INPUT 1 -j ${INPUT_CHAIN}`,
    "}",
    'T=$(pick iptables); F=4; [ -z "$T" ] || rules',
    'T=$(pick ip6tables); F=6; [ -z "$T" ] || rules',
    'command -v iptables >/dev/null 2>&1 || command -v iptables-nft >/dev/null 2>&1 || { echo "iptables is not installed on this server" >&2; exit 1; }',
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
    const logs = (await container.logs({ stdout: true, stderr: true })).toString("utf8");
    // Docker's log stream has an 8-byte header per frame; keep the readable text.
    const text = logs.replace(/[\u0000-\u0008\u000e-\u001f]/g, "").trim();
    if (StatusCode !== 0) throw new Error(text.split("\n").slice(-2).join(" ") || `exit code ${StatusCode}`);
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

/** What each server last got, so ticks only clear rules once after the last allowlist goes. */
const applied = (globalThis as unknown as { __serveDbAllow?: Map<string, string> }).__serveDbAllow ?? new Map<string, string>();
(globalThis as unknown as { __serveDbAllow?: Map<string, string> }).__serveDbAllow = applied;

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
    if (!entries.length && (applied.get(s.id) ?? "[]") === "[]") continue;
    await applyDatabaseAllowlists(s.id).catch((e) => console.error(`[db-allowlist] ${s.id}: ${(e as Error).message}`));
  }
}
