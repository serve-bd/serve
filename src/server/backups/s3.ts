import crypto from "node:crypto";
import fs from "node:fs";

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

const hmac = (key: Buffer | string, data: string) => crypto.createHmac("sha256", key).update(data).digest();
const hash = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

function encodeKey(key: string) {
  return key
    .split("/")
    .map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/** Minimal AWS SigV4 signed request (path-style), works with S3, R2, MinIO, B2. */
async function signedFetch(cfg: S3Config, method: string, key: string, body?: Buffer | fs.ReadStream, size?: number, query = "") {
  const endpoint = new URL(cfg.endpoint.includes("://") ? cfg.endpoint : `https://${cfg.endpoint}`);
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
  delete headers.host;

  const res = await fetch(`${endpoint.origin}${pathname}${query ? `?${query}` : ""}`, {
    method,
    headers,
    body: body as BodyInit | undefined,
    // @ts-expect-error Node fetch needs duplex for streamed bodies
    duplex: body ? "half" : undefined,
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    const code = text.match(/<Code>(.+?)<\/Code>/)?.[1];
    const message = text.match(/<Message>(.+?)<\/Message>/)?.[1];
    throw new Error(`S3 ${method} failed: ${res.status}${code ? ` ${code}` : ""}${message ? ` — ${message}` : ""}`);
  }
  return res;
}

export async function s3Upload(cfg: S3Config, key: string, file: string) {
  const { size } = await fs.promises.stat(file);
  await signedFetch(cfg, "PUT", key, fs.createReadStream(file), size);
}

export async function s3Download(cfg: S3Config, key: string, file: string) {
  const res = await signedFetch(cfg, "GET", key);
  if (res.status === 404 || !res.body) throw new Error("Backup not found in S3");
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(file));
}

export async function s3Delete(cfg: S3Config, key: string) {
  await signedFetch(cfg, "DELETE", key);
}

/** Verifies credentials by listing at most one object. */
export async function s3Test(cfg: S3Config) {
  const res = await signedFetch(cfg, "GET", "", undefined, undefined, "list-type=2&max-keys=1");
  if (res.status === 404) throw new Error("Bucket not found");
}
