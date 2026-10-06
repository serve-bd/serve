import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";

/*
 * Backup encryption with a passphrase, in the format of `openssl enc -aes-256-cbc -pbkdf2`
 * ("Salted__", an 8-byte salt, then the data): a backup can be decrypted without Serve:
 *
 *   openssl enc -d -aes-256-cbc -pbkdf2 -in backup.sql.gz.enc -out backup.sql.gz
 *
 * The checksum recorded for the backup covers the encrypted file, so a changed file is caught
 * before it is decrypted.
 */

const MAGIC = Buffer.from("Salted__");
const ITERATIONS = 10_000; // openssl's default with -pbkdf2

function keyOf(passphrase: string, salt: Buffer) {
  const k = crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, 48, "sha256");
  return { key: k.subarray(0, 32), iv: k.subarray(32, 48) };
}

/** A short fingerprint of a passphrase: tells which one a backup was made with, without storing it. */
export const keyHint = (passphrase: string) => crypto.createHash("sha256").update(`serve-backup-key:${passphrase}`).digest("hex").slice(0, 12);

export const ENCRYPTED_SUFFIX = ".enc";

export async function encryptFile(src: string, dest: string, passphrase: string) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = keyOf(passphrase, salt);
  const out = fs.createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, salt]));
  await pipeline(fs.createReadStream(src), crypto.createCipheriv("aes-256-cbc", key, iv), out);
}

export async function decryptFile(src: string, dest: string, passphrase: string) {
  const fd = await fs.promises.open(src, "r");
  const head = Buffer.alloc(16);
  await fd.read(head, 0, 16, 0);
  await fd.close();
  if (!head.subarray(0, 8).equals(MAGIC)) throw new Error("This file is not an encrypted backup.");
  const { key, iv } = keyOf(passphrase, head.subarray(8, 16));
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  try {
    await pipeline(fs.createReadStream(src, { start: 16 }), decipher, fs.createWriteStream(dest));
  } catch (e) {
    await fs.promises.rm(dest, { force: true });
    // A wrong passphrase shows as bad padding at the end.
    if (/bad decrypt|wrong final block|BAD_DECRYPT/i.test((e as Error).message)) throw new Error("The passphrase does not match this backup.");
    throw e;
  }
}
