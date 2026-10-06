import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

/*
 * Backup encryption with a passphrase, in the format of `openssl enc -aes-256-cbc -pbkdf2`
 * ("Salted__", an 8-byte salt, then the data): a backup can be decrypted without Serve:
 *
 *   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in backup.sql.gz.enc -out backup.sql.gz
 *
 * CBC carries no authentication of its own: the SHA-256 recorded for the backup when it was made
 * covers the encrypted file and is checked before anything is decrypted. Files made by openssl with
 * its default 10,000 rounds (an import) decrypt too.
 */

const MAGIC = Buffer.from("Salted__");
/** PBKDF2 rounds for new backups (OWASP's figure for SHA-256); openssl's own default is tried too. */
const ITERATIONS = 600_000;
const OPENSSL_DEFAULT_ITERATIONS = 10_000;

/** Derived without blocking: 600,000 rounds take a moment. */
async function keyOf(passphrase: string, salt: Buffer, iterations = ITERATIONS) {
  const k = await promisify(crypto.pbkdf2)(passphrase, salt, iterations, 48, "sha256");
  return { key: k.subarray(0, 32), iv: k.subarray(32, 48) };
}

/** A short fingerprint of a passphrase: tells which one a backup was made with, without storing it. */
export const keyHint = (passphrase: string) => crypto.createHash("sha256").update(`serve-backup-key:${passphrase}`).digest("hex").slice(0, 12);

export const ENCRYPTED_SUFFIX = ".enc";

export async function encryptFile(src: string, dest: string, passphrase: string) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = await keyOf(passphrase, salt);
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
  // New backups use ITERATIONS; a file made by plain openssl uses its default rounds.
  for (const iterations of [ITERATIONS, OPENSSL_DEFAULT_ITERATIONS]) {
    const { key, iv } = await keyOf(passphrase, head.subarray(8, 16), iterations);
    try {
      await pipeline(fs.createReadStream(src, { start: 16 }), crypto.createDecipheriv("aes-256-cbc", key, iv), fs.createWriteStream(dest));
      return;
    } catch (e) {
      await fs.promises.rm(dest, { force: true });
      // A wrong key shows as bad padding at the end; anything else is a real error.
      if (!/bad decrypt|wrong final block|BAD_DECRYPT/i.test((e as Error).message)) throw e;
    }
  }
  throw new Error("The passphrase does not match this backup.");
}
