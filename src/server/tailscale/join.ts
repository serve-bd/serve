import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import type { ServerTailscale } from "@/server/db/schema";
import { AUTH_KEY_TTL_SECONDS, clientFor, deviceFields, findByNodeKey, getTailnet, recordTailnetCheck, type TailnetRow } from "./index";
import { type TailscaleDevice, tailnetHostname, tailnetIpv4 } from "./api";
import { parseProbe, PROBE_SCRIPT, type Probe, RESUME_SCRIPT, upScript } from "./script";

type ServerRow = typeof schema.server.$inferSelect;

/** A join that cannot go on, with the reason to show (and the HTTP status for the join command). */
export class JoinRefused extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/** Logged in to a tailnet (any), as opposed to logged out or never set up. */
const loggedIn = (p: Pick<Probe, "state" | "nodeKey">) => !!p.nodeKey && ["Running", "Stopped", "Starting"].includes(p.state ?? "");

export type KeyPlan = { already: true; hostname: string } | { already: false; hostname: string; authKey: string; reauth: boolean };

/**
 * What a machine needs to join: nothing when it is in this tailnet already (a second run of the
 * command), else a single-use, pre-authorized auth key with the tailnet's tag, made right now.
 * A machine in another tailnet is only moved when `force` says so.
 */
export async function prepareKey(
  row: Pick<ServerRow, "id" | "name" | "tailscale">,
  tailnet: TailnetRow,
  probe: Pick<Probe, "state" | "nodeKey" | "suffix">,
  force: boolean,
): Promise<KeyPlan> {
  const client = clientFor(tailnet);
  let devices: TailscaleDevice[];
  try {
    devices = await client.devices();
  } catch (error) {
    await recordTailnetCheck(tailnet.id, (error as Error).message);
    throw new JoinRefused(`Serve could not read the tailnet: ${(error as Error).message}`, 502);
  }
  const inAny = loggedIn(probe);
  const mine = inAny ? findByNodeKey(devices, probe.nodeKey) : null;
  if (mine) return { already: true, hostname: mine.hostname };
  // Still logged in to this very tailnet, but its device is gone (removed in the admin console, or its
  // key expired): it simply joins again. Only a different tailnet needs the person to agree.
  const norm = (d: string | null | undefined) => d?.replace(/\.$/, "").toLowerCase() ?? null;
  const sameTailnet = !!probe.suffix && !!tailnet.dnsSuffix && norm(probe.suffix) === norm(tailnet.dnsSuffix);
  if (inAny && !force && !sameTailnet)
    throw new JoinRefused(
      `This machine is already in another tailnet${probe.suffix ? ` (${probe.suffix})` : ""}. Joining ${tailnet.name} takes it out of that one. To move it, run the command again with SERVE_TAILSCALE_FORCE=1 (curl ... | sudo SERVE_TAILSCALE_FORCE=1 bash), or sign it out first with: sudo tailscale logout`,
    );
  const hostname = tailnetHostname(row.name, devices, probe.nodeKey);
  // An earlier run's key that was never used must not stay valid.
  if (row.tailscale?.authKeyId) await client.deleteKey(row.tailscale.authKeyId).catch(() => {});
  let key: { id: string; key: string };
  try {
    key = await client.createAuthKey({ tags: [tailnet.tag], description: `Serve ${row.name}`, expirySeconds: AUTH_KEY_TTL_SECONDS });
  } catch (error) {
    await recordTailnetCheck(tailnet.id, (error as Error).message);
    throw new JoinRefused(`Serve could not create a Tailscale auth key: ${(error as Error).message}`, 502);
  }
  await db
    .update(schema.server)
    .set({ tailscale: sql`${schema.server.tailscale} || ${JSON.stringify({ authKeyId: key.id, hostname })}::jsonb` })
    .where(eq(schema.server.id, row.id));
  return { already: false, hostname, authKey: key.key, reauth: inAny };
}

/** The machine's device, looked up by its node key; it can take a moment to show after joining. */
async function waitForDevice(tailnet: TailnetRow, nodeKey: string) {
  const client = clientFor(tailnet);
  for (let attempt = 0; ; attempt++) {
    const devices = await client.devices();
    const device = findByNodeKey(devices, nodeKey);
    if (device || attempt >= 4) {
      await recordTailnetCheck(tailnet.id, null, devices);
      return device;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * The machine joined: find its device in the tailnet (Serve trusts the API, not the address the
 * machine reports), keep its address, and connect to it there from now on. `tokenHash` claims the
 * join command at the same time, so it works once.
 */
export async function completeJoin(serverId: string, nodeKey: string, opts: { tokenHash?: string } = {}) {
  const [row] = await db.select().from(schema.server).where(eq(schema.server.id, serverId));
  if (!row?.tailscale) throw new JoinRefused("This server does not use Tailscale any more.", 404);
  const tailnet = await getTailnet(row.tailscale.tailnetId);
  if (!tailnet) throw new JoinRefused("The Tailscale integration this command was made for was removed. Connect Tailscale again and make a new command.", 409);
  let device: TailscaleDevice | null;
  try {
    device = await waitForDevice(tailnet, nodeKey);
  } catch (error) {
    throw new JoinRefused(`Serve could not read the tailnet: ${(error as Error).message}`, 502);
  }
  if (!device)
    throw new JoinRefused(
      `Serve cannot find this machine in the tailnet ${tailnet.name}. Check that it shows in the Tailscale admin console under Machines, then run the command again.`,
    );
  const address = tailnetIpv4(device);
  if (!address) throw new JoinRefused("This machine has no Tailscale IPv4 address. Turn IPv4 on for the tailnet, then run the command again.");
  // One machine is one server: two servers on the same device would fight over its Docker.
  const [twin] = await db
    .select({ name: schema.server.name })
    .from(schema.server)
    .where(and(ne(schema.server.id, serverId), isNotNull(schema.server.tailscale), sql`${schema.server.tailscale}->>'deviceId' = ${device.id}`));
  if (twin) throw new JoinRefused(`This machine is already in Serve as the server "${twin.name}". Remove that server first, or use it instead.`);
  const next: ServerTailscale = {
    ...row.tailscale,
    ...deviceFields(device),
    hostname: device.hostname || row.tailscale.hostname,
    tokenHash: null,
    tokenExpiresAt: null,
    authKeyId: null,
    joinedAt: new Date().toISOString(),
  };
  const claimed = await db
    .update(schema.server)
    .set({
      tailscale: next,
      // A server added through Tailscale shows its MagicDNS name as its host.
      ...(row.tailscale.only ? { host: next.dnsName ?? next.hostname, hostKey: null, status: "validating" as const, statusMessage: "Connecting through Tailscale" } : {}),
    })
    .where(and(eq(schema.server.id, serverId), opts.tokenHash ? sql`${schema.server.tailscale}->>'tokenHash' = ${opts.tokenHash}` : sql`true`))
    .returning({ id: schema.server.id });
  if (!claimed.length) throw new JoinRefused("This join command expired or was used already. Create a new one on the server's page in the dashboard.", 404);
  // The key is used up; removing it keeps the tailnet's key list tidy.
  if (row.tailscale.authKeyId)
    await clientFor(tailnet)
      .deleteKey(row.tailscale.authKeyId)
      .catch(() => {});
  const { forgetServer } = await import("@/server/servers/context");
  forgetServer(serverId);
  const { enqueue } = await import("@/server/queue");
  // Set up (or checked) again over the new address; this pins the host key the tailnet route shows.
  if (!row.isLocal) await enqueue("server.setup", { serverId }, { concurrencyKey: `server:${serverId}` });
  if (row.mesh?.enabled) await enqueue("mesh.sync", {}, { concurrencyKey: "mesh" }).catch(() => {});
  return { address, dnsName: next.dnsName };
}

/**
 * Puts a server Serve already reaches in the tailnet by itself: over SSH, or on the machine the
 * dashboard runs on through a helper container in the host's namespaces. No command to copy.
 */
export async function joinThroughShell(serverId: string, opts: { force?: boolean } = {}) {
  const { getServer } = await import("@/server/servers/context");
  const { hostRun } = await import("@/server/servers/os-updates");
  const [row] = await db.select().from(schema.server).where(eq(schema.server.id, serverId));
  if (!row?.tailscale) throw new JoinRefused("This server is not set to use Tailscale.");
  const tailnet = await getTailnet(row.tailscale.tailnetId);
  if (!tailnet) throw new JoinRefused("The Tailscale integration was removed.");
  // Reached the usual way while joining: the Tailscale address only counts once it joined.
  const ctx = await getServer(serverId);
  const tail: string[] = [];
  const keep = (line: string) => {
    tail.push(line);
    if (tail.length > 12) tail.shift();
  };
  const run = async (script: string, timeoutMs: number) => {
    const res = await hostRun(ctx, script, { onLine: keep, timeoutMs });
    if (res.code !== 0) {
      const why = (res.stderr || tail.join("\n")).trim().split("\n").filter(Boolean).slice(-4).join(" ");
      throw new JoinRefused(why.replace(/\x1b\[[0-9;]*m/g, "") || `exit code ${res.code}`);
    }
    return parseProbe(res.stdout || tail.join("\n"));
  };
  const probe = await run(PROBE_SCRIPT, 60_000);
  if (probe.os === "unsupported") throw new JoinRefused("Tailscale through Serve works on Linux only.");
  const plan = await prepareKey(row, tailnet, probe, opts.force === true);
  const joined = plan.already ? await run(RESUME_SCRIPT, 120_000) : await run(upScript({ authKey: plan.authKey, hostname: plan.hostname, reauth: plan.reauth }), 6 * 60_000);
  if (!joined.nodeKey) throw new JoinRefused("Tailscale came up, but its node key could not be read. Try again.");
  return completeJoin(serverId, joined.nodeKey);
}
