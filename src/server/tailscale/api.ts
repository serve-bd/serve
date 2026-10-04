/**
 * Tailscale API (v2): only what Serve needs. Pure, without the database: the caller hands in how
 * to get a bearer token, so an OAuth client's one-hour access token can be cached and renewed.
 */

export const TAILSCALE_API = "https://api.tailscale.com/api/v2";

/** An error from the Tailscale API, with its HTTP status and the message Tailscale gave. */
export class TailscaleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type TailscaleDevice = {
  id: string;
  nodeId?: string;
  /** MagicDNS name: host.tail1234.ts.net */
  name: string;
  hostname: string;
  addresses: string[];
  nodeKey?: string;
  os?: string;
  tags?: string[];
  authorized?: boolean;
  lastSeen?: string | null;
  connectedToControl?: boolean;
  keyExpiryDisabled?: boolean;
  expires?: string | null;
};

export type CreatedKey = { id: string; key: string; expires?: string };

type Fetch = typeof fetch;

/** Reads the message out of an error answer: Tailscale sends {"message": "..."}. */
async function errorOf(res: Response, what: string): Promise<TailscaleError> {
  const text = await res.text().catch(() => "");
  let message = text.trim();
  try {
    const body = JSON.parse(text) as { message?: string; error?: string; error_description?: string };
    message = body.message || body.error_description || body.error || message;
  } catch {}
  message = message.replace(/\s+/g, " ").slice(0, 400) || res.statusText || "no answer";
  return new TailscaleError(`${what}: ${message} (HTTP ${res.status})`, res.status);
}

/** A short-lived access token for an OAuth client (client credentials). */
export async function oauthToken(clientId: string, clientSecret: string, f: Fetch = fetch): Promise<{ token: string; expiresAt: Date }> {
  let res: Response;
  try {
    res = await f(`${TAILSCALE_API}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new TailscaleError(`Could not reach Tailscale: ${(error as Error).message}`, 0);
  }
  if (!res.ok) {
    const error = await errorOf(res, "Tailscale did not accept the OAuth client");
    // A wrong secret or a deleted client both answer 401.
    if (res.status === 400 || res.status === 401) error.message += ". Check the client id and secret, or create a new OAuth client.";
    throw error;
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new TailscaleError("Tailscale sent no access token.", res.status);
  return { token: body.access_token, expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000) };
}

export type TailscaleClient = ReturnType<typeof tailscaleClient>;

/**
 * Calls for one tailnet. `token(renew)` returns the bearer token; with `renew` an OAuth client
 * gets a new one (a cached token may have run out or been revoked early): a 401 is tried once more.
 */
export function tailscaleClient(opts: { tailnet: string; token: (renew: boolean) => Promise<string>; renewable: boolean; fetch?: Fetch }) {
  const f = opts.fetch ?? fetch;
  const tailnet = encodeURIComponent(opts.tailnet || "-");

  async function call(method: string, path: string, what: string, body?: unknown): Promise<Response> {
    const send = async (renew: boolean) => {
      const token = await opts.token(renew);
      try {
        return await f(`${TAILSCALE_API}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw new TailscaleError(`Could not reach Tailscale: ${(error as Error).message}`, 0);
      }
    };
    let res = await send(false);
    if (res.status === 401 && opts.renewable) res = await send(true);
    if (!res.ok) {
      const error = await errorOf(res, what);
      if (res.status === 401)
        error.message += opts.renewable ? " The OAuth client may have been deleted." : " The API access key expired or was revoked: connect Tailscale again with a new one.";
      if (res.status === 403) error.message += " Check the scopes of the OAuth client (auth_keys and devices:core) and its tags.";
      throw error;
    }
    return res;
  }

  return {
    async devices(): Promise<TailscaleDevice[]> {
      const res = await call("GET", `/tailnet/${tailnet}/devices?fields=all`, "Could not list the devices of the tailnet");
      const body = (await res.json()) as { devices?: TailscaleDevice[] };
      return body.devices ?? [];
    },

    async device(id: string): Promise<TailscaleDevice | null> {
      try {
        const res = await call("GET", `/device/${encodeURIComponent(id)}?fields=all`, "Could not read the device");
        return (await res.json()) as TailscaleDevice;
      } catch (error) {
        if (error instanceof TailscaleError && error.status === 404) return null;
        throw error;
      }
    },

    /** A single-use, pre-authorized auth key: the device joins with `tags` and needs no approval. */
    async createAuthKey(input: { tags: string[]; description: string; expirySeconds: number }): Promise<CreatedKey> {
      const res = await call("POST", `/tailnet/${tailnet}/keys`, "Could not create an auth key", authKeyRequest(input));
      const body = (await res.json()) as CreatedKey;
      if (!body.key || !body.id) throw new TailscaleError("Tailscale sent no auth key.", res.status);
      return body;
    },

    /** Revokes a key; one that is gone already counts as done. */
    async deleteKey(id: string) {
      try {
        await call("DELETE", `/tailnet/${tailnet}/keys/${encodeURIComponent(id)}`, "Could not remove the auth key");
      } catch (error) {
        if (!(error instanceof TailscaleError && error.status === 404)) throw error;
      }
    },

    /** Removes a device from the tailnet; one that is gone already counts as done. */
    async deleteDevice(id: string) {
      try {
        await call("DELETE", `/device/${encodeURIComponent(id)}`, "Could not remove the device from the tailnet");
      } catch (error) {
        if (!(error instanceof TailscaleError && error.status === 404)) throw error;
      }
    },
  };
}

/** Body of POST /tailnet/{tailnet}/keys. Descriptions take letters, digits, spaces and dashes, 50 at most. */
export function authKeyRequest(input: { tags: string[]; description: string; expirySeconds: number }) {
  return {
    capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: input.tags } } },
    expirySeconds: input.expirySeconds,
    description:
      input.description
        .replace(/[^A-Za-z0-9 -]+/g, "-")
        .replace(/-{2,}/g, "-")
        .slice(0, 50)
        .trim() || "Serve",
  };
}

/** The device's Tailscale IPv4 address (100.64.0.0/10). */
export const tailnetIpv4 = (d: Pick<TailscaleDevice, "addresses">) => d.addresses.find((a) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(a)) ?? null;

/** Whether a device is online: connected to Tailscale's control servers, or (older answers) seen in the last five minutes. */
export function deviceOnline(d: Pick<TailscaleDevice, "connectedToControl" | "lastSeen">, now = Date.now()) {
  if (typeof d.connectedToControl === "boolean") return d.connectedToControl;
  return !!d.lastSeen && now - new Date(d.lastSeen).getTime() < 5 * 60_000;
}

/** The MagicDNS suffix of a tailnet from a device name: host.tail1234.ts.net → tail1234.ts.net. */
export const dnsSuffixOf = (name: string) => name.replace(/\.$/, "").split(".").slice(1).join(".") || null;

/** The host name Serve gives a server in the tailnet: serve-<name>, lower case, DNS-safe, free in the tailnet. */
export function tailnetHostname(serverName: string, devices: Pick<TailscaleDevice, "hostname" | "name" | "nodeKey">[], ownNodeKey?: string | null) {
  const base = `serve-${
    serverName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "server"
  }`.slice(0, 56);
  // Another device already has the name: Tailscale would add a number by itself, so choose it now and know it.
  const taken = new Set(devices.filter((d) => !ownNodeKey || d.nodeKey !== ownNodeKey).flatMap((d) => [d.hostname.toLowerCase(), d.name.split(".")[0].toLowerCase()]));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
