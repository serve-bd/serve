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

export async function decryptBundle(src: string, dst: string, encryptionKey: string) {
  const { size } = await fs.promises.stat(src);
  const head = BUNDLE_MAGIC.length + 12;
  if (size < head + 16) throw new Error("Not an encrypted Serve backup.");
  const fd = await fs.promises.open(src, "r");
  const start = Buffer.alloc(head);
  const tag = Buffer.alloc(16);
  await fd.read(start, 0, head, 0);
  await fd.read(tag, 0, 16, size - 16);
  await fd.close();
  if (!start.subarray(0, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC)) throw new Error("Not an encrypted Serve backup.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", bundleKey(encryptionKey), start.subarray(BUNDLE_MAGIC.length));
  decipher.setAuthTag(tag);
  await pipeline(fs.createReadStream(src, { start: head, end: size - 17 }), decipher, fs.createWriteStream(dst, { mode: 0o600 }));
}
