import crypto from "node:crypto";
import { env } from "@/server/env";

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (!cachedKey) {
    cachedKey = crypto.createHash("sha256").update(env.encryptionKey).digest();
  }
  return cachedKey;
}

/** Keyed SHA-256 (hex): a fingerprint of values that may hold secrets, useless without this instance's key. */
export function hmac(value: string): string {
  return crypto.createHmac("sha256", key()).update(value).digest("hex");
}

/** AES-256-GCM encrypt. Output: v1:<iv>:<tag>:<ciphertext> (base64url). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(":");
}

export function decrypt(payload: string): string {
  // Every secret is stored encrypted: anything else was not written by Serve and is not trusted.
  if (!payload.startsWith("v1:")) throw new Error("A stored secret is not encrypted.");
  const [, iv, tag, data] = payload.split(":");
  const tagBytes = Buffer.from(tag, "base64url");
  if (tagBytes.length !== 16) throw new Error("Corrupt encrypted value.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"), { authTagLength: 16 });
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function decryptOrNull(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomSecret(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Password without characters that tend to break connection strings. */
export function randomPassword(length = 28): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
