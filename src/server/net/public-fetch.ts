import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Readable } from "node:stream";

const blocked = new net.BlockList();
for (const [a, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(a, bits, "ipv4");
for (const [a, bits] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form
  ["64:ff9b::", 96], // NAT64: carries an IPv4 address
  ["64:ff9b:1::", 48],
  ["2002::", 16], // 6to4: carries an IPv4 address
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(a, bits, "ipv6");

/**
 * Loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved ranges, in any
 * spelling: IPv4-mapped IPv6 (::ffff:7f00:1) is checked against the IPv4 ranges.
 */
export function isPrivateAddress(address: string) {
  const ip = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = net.isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export class PublicFetchError extends Error {}

/**
 * DNS lookup that refuses private addresses. Used as the socket's lookup, so the address
 * checked is the address connected to: a name cannot resolve publicly for a check and
 * privately for the request (DNS rebinding).
 */
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (!list.length || bad) return callback(new PublicFetchError(`${hostname} points at a private network address.`), "", 4);
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

/**
 * GET a public http(s) URL as a stream. Every redirect hop is checked again and the
 * connection itself refuses private addresses.
 */
export async function publicGet(
  raw: string,
  /** headers: sent only to the first URL's host, never to a host a redirect leads to. */
  opts: { maxRedirects?: number; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Readable }> {
  let url = new URL(raw);
  const origin = url.host;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new PublicFetchError("Only http and https URLs are allowed.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isPrivateAddress(host)) throw new PublicFetchError("That address points at a private network.");
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = (url.protocol === "https:" ? https : http).get(
        url,
        { lookup: publicLookup, timeout: opts.timeoutMs ?? 30_000, headers: url.host === origin ? opts.headers : undefined },
        resolve,
      );
      req.on("timeout", () => req.destroy(new PublicFetchError("The server did not answer in time.")));
      req.on("error", reject);
    });
    const location = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.resume();
      url = new URL(location, url);
      continue;
    }
    return { status: res.statusCode ?? 0, headers: res.headers, body: res };
  }
  throw new PublicFetchError("Too many redirects.");
}

/**
 * Send a request with a body to a public http(s) URL and read the answer (up to 64 KB).
 * Redirects are not followed: a webhook that redirects answers with its 3xx status.
 */
export async function publicRequest(
  raw: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const url = new URL(raw);
  const maxBytes = opts.maxBytes ?? 65_536;
  // The socket timeout only catches silence; a server that trickles bytes forever still ends here.
  const deadline = (opts.timeoutMs ?? 15_000) * 4;
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new PublicFetchError("Only http and https URLs are allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host)) throw new PublicFetchError("That address points at a private network.");
  const body = opts.body !== undefined ? Buffer.from(opts.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: opts.method ?? "POST",
        lookup: publicLookup,
        timeout: opts.timeoutMs ?? 15_000,
        headers: { ...(body ? { "content-length": String(body.length) } : {}), ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) return req.destroy(new PublicFetchError(`The answer is larger than ${Math.round(maxBytes / 1024)} KB.`));
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new PublicFetchError("The server did not finish answering in time.")), deadline);
    timer.unref();
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new PublicFetchError("The server did not answer in time.")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
