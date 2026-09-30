import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isPrivateAddress } from "@/server/net/public-fetch";

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Refuse endpoints that resolve to a private address. */
  publicOnly?: boolean;
};

const hmac = (key: Buffer | string, data: string) => crypto.createHmac("sha256", key).update(data).digest();
const hash = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

function encodeKey(key: string) {
  return key
    .split("/")
    .map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/**
 * DNS lookup that refuses private addresses. It is the socket's own lookup, so the address checked
 * is the address connected to (no DNS rebinding between a check and the request).
 */
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) return callback(new Error("The storage address is on a private network."), "", 4);
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

type S3Response = { status: number; headers: http.IncomingHttpHeaders; body: http.IncomingMessage };

/** Minimal AWS SigV4 signed request (path-style), works with S3, R2, MinIO, B2. Redirects are not followed. */
async function signedFetch(cfg: S3Config, method: string, key: string, body?: Buffer | fs.ReadStream, size?: number, query = ""): Promise<S3Response> {
  const endpoint = new URL(cfg.endpoint.includes("://") ? cfg.endpoint : `https://${cfg.endpoint}`);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("The storage address must be http or https.");
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  // An IP address skips the lookup, so it is checked here.
  if (cfg.publicOnly && net.isIP(host) && isPrivateAddress(host)) throw new Error("The storage address is on a private network.");
  const region = cfg.region || "auto";
  const pathname = `/${cfg.bucket}${key ? `/${encodeKey(key)}` : ""}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = "UNSIGNED-PAYLOAD";
  const headers: Record<string, string> = {
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (size !== undefined) headers["content-length"] = String(size);
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join("");
  const canonical = [method, pathname, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hash(canonical)].join("\n");
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = new URL(`${endpoint.origin}${pathname}${query ? `?${query}` : ""}`);
  let req: http.ClientRequest | undefined;
  // Idle timeout until the answer starts; the error text below is read under it too. publicOnly
  // takes no pooled socket, so every request goes through the lookup check.
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    req = (url.protocol === "https:" ? https : http).request(
      url,
      { method, headers, lookup: cfg.publicOnly ? publicLookup : undefined, agent: cfg.publicOnly ? false : undefined, timeout: 120_000 },
      resolve,
    );
    req.on("timeout", () => req?.destroy(new Error("The storage did not answer in time.")));
    req.on("error", reject);
    if (body instanceof fs.ReadStream) pipeline(body, req).catch(reject);
    else req.end(body);
  });
  const status = res.statusCode ?? 0;
  // 404 is an answer for reads and deletes (the object is not there); a write that gets it failed.
  const missingOk = status === 404 && (method === "GET" || method === "HEAD" || method === "DELETE");
  if ((status < 200 || status >= 300) && !missingOk) {
    const text = await new Promise<string>((resolve) => {
      let t = "";
      res.on("data", (c: Buffer) => (t += t.length < 65_536 ? c.toString() : ""));
      res.on("end", () => resolve(t));
      res.on("error", () => resolve(t));
    });
    const code = text.match(/<Code>(.+?)<\/Code>/)?.[1];
    const message = text.match(/<Message>(.+?)<\/Message>/)?.[1];
    throw new Error(`S3 ${method} failed: ${status}${code ? ` ${code}` : ""}${message ? ` — ${message}` : ""}`);
  }
  // A streamed body goes on at the reader's pace (a browser download may pause): no timeout from here.
  req?.setTimeout(0);
  return { status, headers: res.headers, body: res };
}

export async function s3Upload(cfg: S3Config, key: string, file: string) {
  const { size } = await fs.promises.stat(file);
  (await signedFetch(cfg, "PUT", key, fs.createReadStream(file), size)).body.resume();
}

export async function s3Download(cfg: S3Config, key: string, file: string) {
  const res = await signedFetch(cfg, "GET", key);
  if (res.status === 404) {
    res.body.resume();
    throw new Error("Backup not found in S3");
  }
  await pipeline(res.body, fs.createWriteStream(file));
}

/** Opens an object as a web stream with its size, or null when it is missing. */
export async function s3Stream(cfg: S3Config, key: string) {
  const res = await signedFetch(cfg, "GET", key);
  if (res.status === 404) {
    res.body.resume();
    return null;
  }
  return { body: Readable.toWeb(res.body) as ReadableStream<Uint8Array>, size: Number(res.headers["content-length"] ?? 0) || null };
}

export async function s3Delete(cfg: S3Config, key: string) {
  (await signedFetch(cfg, "DELETE", key)).body.resume();
}

/** Verifies credentials by listing at most one object. */
export async function s3Test(cfg: S3Config) {
  const res = await signedFetch(cfg, "GET", "", undefined, undefined, "list-type=2&max-keys=1");
  res.body.resume();
  if (res.status === 404) throw new Error("Bucket not found");
}
