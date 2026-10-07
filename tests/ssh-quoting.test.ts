import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprint, formatHostKey, sh } from "@/server/servers/ssh";

// Commands sent over SSH are shell strings: every value Serve puts in one goes through sh().
// Checked against a real POSIX shell, not against the expected escaping.
const echoed = (value: string) => execFileSync("/bin/sh", ["-c", `printf '%s' ${sh(value)}`]).toString();

describe("sh quoting", () => {
  it("passes any value through a real shell unchanged, as one word", () => {
    for (const value of [
      "",
      "plain",
      "two words",
      "it's",
      "'",
      "''",
      "'; rm -rf / #",
      "$(touch /tmp/pwned)",
      "`id`",
      "$HOME ${PATH}",
      "a\nb",
      'back\\slash "double"',
      "*?[a-z]",
      "-n",
      "tab\there; && || | > < &",
      "ünïcödé ✓",
    ]) {
      expect(echoed(value)).toBe(value);
    }
  });

  it("keeps a value one argument, never splitting it", () => {
    const count = execFileSync("/bin/sh", ["-c", `set -- ${sh("a b' c")} ${sh("")}; echo $#`])
      .toString()
      .trim();
    expect(count).toBe("2");
  });

  it("never runs what a value contains", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-sh-"));
    const marker = path.join(dir, "ran");
    try {
      for (const value of [`$(touch ${marker})`, `\`touch ${marker}\``, `'; touch ${marker}; '`, `x'\ntouch ${marker}\n'`]) echoed(value);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("host keys", () => {
  it("fingerprints like ssh-keygen -l", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-key-"));
    try {
      const key = path.join(dir, "k");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
      const pub = fs.readFileSync(`${key}.pub`, "utf8");
      const expected = execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", `${key}.pub`])
        .toString()
        .split(" ")[1];
      expect(fingerprint(pub)).toBe(expected);
      // The stored "<type> <base64>" form of the same key gives the same fingerprint.
      const blob = Buffer.from(pub.split(" ")[1], "base64");
      expect(formatHostKey(blob)).toBe(pub.split(" ").slice(0, 2).join(" "));
      expect(fingerprint(formatHostKey(blob))).toBe(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an unparsable key blob as raw base64 instead of throwing", () => {
    expect(formatHostKey(Buffer.from("garbage"))).toBe(`unknown ${Buffer.from("garbage").toString("base64")}`);
  });
});
