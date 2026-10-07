import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-backup-encrypt";

const { decryptFile, encryptFile, keyHint } = await import("@/server/backups/encrypt");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-enc-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name: string, content?: Buffer | string) => {
  const p = path.join(dir, name);
  if (content !== undefined) fs.writeFileSync(p, content);
  return p;
};
// Not a multiple of the AES block size, with every byte value.
const data = Buffer.concat([crypto.randomBytes(100_003), Buffer.from([...Array(256).keys()])]);

describe("backup encryption", () => {
  it("decrypts what it encrypted, byte for byte", async () => {
    await encryptFile(file("a.sql", data), file("a.enc"), "correct horse");
    expect(fs.readFileSync(file("a.enc")).subarray(0, 8).toString()).toBe("Salted__");
    await decryptFile(file("a.enc"), file("a.out"), "correct horse");
    expect(fs.readFileSync(file("a.out")).equals(data)).toBe(true);
  });

  it("uses a new salt each time", async () => {
    await encryptFile(file("b.sql", "same"), file("b1.enc"), "pw");
    await encryptFile(file("b.sql"), file("b2.enc"), "pw");
    expect(fs.readFileSync(file("b1.enc")).equals(fs.readFileSync(file("b2.enc")))).toBe(false);
  });

  it("refuses a wrong passphrase and leaves no partial output", async () => {
    await expect(decryptFile(file("a.enc"), file("wrong.out"), "Correct horse")).rejects.toThrow(/passphrase does not match/);
    expect(fs.existsSync(file("wrong.out"))).toBe(false);
  });

  it("refuses a truncated file and leaves no partial output", async () => {
    const whole = fs.readFileSync(file("a.enc"));
    for (const cut of [whole.length - 1, whole.length - 16, 16, 20]) {
      file("cut.enc", whole.subarray(0, cut));
      await expect(decryptFile(file("cut.enc"), file("cut.out"), "correct horse")).rejects.toThrow();
      expect(fs.existsSync(file("cut.out"))).toBe(false);
    }
  });

  it("refuses a file that is not encrypted", async () => {
    await expect(decryptFile(file("plain.sql", "-- PostgreSQL database dump\n"), file("plain.out"), "pw")).rejects.toThrow(/not an encrypted backup/);
    await expect(decryptFile(file("empty.sql", ""), file("empty.out"), "pw")).rejects.toThrow(/not an encrypted backup/);
  });

  it("is openssl's format both ways (backups decrypt without Serve; openssl files import)", async () => {
    // Serve's file, decrypted by the command the docs give.
    execFileSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-in", file("a.enc"), "-out", file("a.openssl"), "-pass", "pass:correct horse"]);
    expect(fs.readFileSync(file("a.openssl")).equals(data)).toBe(true);
    // A file made by plain openssl with its default rounds.
    execFileSync("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-in", file("a.sql"), "-out", file("o.enc"), "-pass", "pass:from openssl"]);
    await decryptFile(file("o.enc"), file("o.out"), "from openssl");
    expect(fs.readFileSync(file("o.out")).equals(data)).toBe(true);
  });

  it("hints which passphrase was used without revealing it", () => {
    expect(keyHint("one")).toBe(keyHint("one"));
    expect(keyHint("one")).not.toBe(keyHint("two"));
    expect(keyHint("one")).toHaveLength(12);
    expect(keyHint("one")).not.toBe(crypto.createHash("sha256").update("serve-backup-key:one").digest("hex").slice(0, 12));
  });
});
