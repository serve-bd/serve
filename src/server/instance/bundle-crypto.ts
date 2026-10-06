import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";

/**
 * Instance backups are encrypted with a key derived from the instance encryption key. A restore
 * needs that key anyway (it decrypts the secrets in the database), so this costs nothing, and a
 * copy in storage no longer reveals certificates, SSH keys or service files.
 * Format: MAGIC, 12-byte IV, AES-256-GCM ciphertext, 16-byte tag. scripts/restore-instance.sh
 * reads the same format.
 */
export const BUNDLE_MAGIC = Buffer.from("SERVEENC1\n");

export function bundleKey(encryptionKey: string) {
  return crypto.createHash("sha256").update("serve-instance-backup:").update(encryptionKey).digest();
}

export async function encryptBundle(src: string, dst: string, encryptionKey: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", bundleKey(encryptionKey), iv);
  const out = fs.createWriteStream(dst, { mode: 0o600 });
  out.write(Buffer.concat([BUNDLE_MAGIC, iv]));
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise<void>((resolve, reject) => out.end(cipher.getAuthTag(), (e?: Error | null) => (e ? reject(e) : resolve())));
}
