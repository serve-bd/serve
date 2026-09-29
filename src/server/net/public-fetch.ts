import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Readable } from "node:stream";

/** Loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(address: string) {
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
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
  opts: { maxRedirects?: number; timeoutMs?: number } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Readable }> {
  let url = new URL(raw);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new PublicFetchError("Only http and https URLs are allowed.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isPrivateAddress(host)) throw new PublicFetchError("That address points at a private network.");
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = (url.protocol === "https:" ? https : http).get(url, { lookup: publicLookup, timeout: opts.timeoutMs ?? 30_000 }, resolve);
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
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const url = new URL(raw);
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
          if (size <= 65_536) chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new PublicFetchError("The server did not answer in time.")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
