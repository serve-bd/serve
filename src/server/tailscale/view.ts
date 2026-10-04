import { db, schema } from "@/server/db";
import { clientFor, getTailnet, looksLikeNetwork, tailnetReachHint, tcpProbe } from "./index";
import { deviceOnline, tailnetIpv4 } from "./api";

type ServerRow = typeof schema.server.$inferSelect;

/** What a server's page shows about Tailscale: the device as the API shows it now, and whether the dashboard reaches it. */
export type TailscaleView = {
  tailnetId: string | null;
  tailnetName: string | null;
  /** Added through Tailscale: no other way in. */
  only: boolean;
  /** A join command was made and has not run yet. */
  waiting: boolean;
  address: string | null;
  dnsName: string | null;
  online: boolean | null;
  lastSeen: string | null;
  /** The API's answer was read now (else the values are from the last check). */
  live: boolean;
  error: string | null;
  /** From the dashboard: the server's SSH port at its Tailscale address answers. Null: not checked. */
  reach: { ok: boolean; hint: string | null } | null;
  hasDevice: boolean;
};

async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export async function tailscaleView(row: ServerRow): Promise<TailscaleView | null> {
  const ts = row.tailscale;
  if (!ts) return null;
  const tailnet = await getTailnet(ts.tailnetId);
  const view: TailscaleView = {
    tailnetId: tailnet?.id ?? null,
    tailnetName: tailnet?.name ?? null,
    only: ts.only,
    waiting: !!ts.tokenHash && !ts.joinedAt,
    address: ts.address,
    dnsName: ts.dnsName,
    online: ts.online,
    lastSeen: ts.lastSeen,
    live: false,
    error: ts.error,
    reach: null,
    hasDevice: !!ts.deviceId,
  };
  if (tailnet && ts.deviceId) {
    try {
      // null: no answer in time, so the last check stays; { device: null }: the device is gone.
      const got = await within(
        clientFor(tailnet)
          .device(ts.deviceId)
          .then((device) => ({ device })),
        6000,
      );
      const device = got?.device;
      if (got && !device) {
        view.online = false;
        view.error = "This device is no longer in the tailnet (removed in the Tailscale admin console, or its key expired). Connect the server through Tailscale again.";
      } else if (device) {
        view.live = true;
        view.online = deviceOnline(device);
        view.lastSeen = device.lastSeen ?? null;
        view.address = tailnetIpv4(device) ?? view.address;
        view.dnsName = device.name?.replace(/\.$/, "") || view.dnsName;
        view.error = null;
      }
    } catch (error) {
      view.error = (error as Error).message;
    }
  }
  if (tailnet && view.address && !row.isLocal && ts.joinedAt) {
    const probe = await tcpProbe(view.address, row.port, 3000);
    view.reach = probe.ok
      ? { ok: true, hint: null }
      : {
          ok: false,
          hint: looksLikeNetwork(probe.error) ? await tailnetReachHint({ ...row, tailscale: { ...ts, online: view.online } }) : `The connection failed: ${probe.error}.`,
        };
  }
  return view;
}

/** Connected tailnets a server may join: the instance's servers only. */
export async function tailnetChoices(row: Pick<ServerRow, "ownerOrganizationId">) {
  if (row.ownerOrganizationId) return [];
  return db.select({ id: schema.tailscaleTailnet.id, name: schema.tailscaleTailnet.name }).from(schema.tailscaleTailnet).orderBy(schema.tailscaleTailnet.createdAt);
}
