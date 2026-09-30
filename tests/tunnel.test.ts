import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { utils } from "ssh2";
import { describe, expect, it } from "vitest";
import { allocateRelayPort, hashToken, installScript, knownHostsLine, newJoinToken, normalizePublicKey, RELAY_PORTS, sh, tokenMatches } from "@/server/tunnel";

describe("server tunnels", () => {
  it("makes one-time tokens that only match themselves", () => {
    const a = newJoinToken();
    const b = newJoinToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(tokenMatches(a.hash, a.token)).toBe(true);
    expect(tokenMatches(a.hash, b.token)).toBe(false);
    expect(tokenMatches(null, a.token)).toBe(false);
    expect(hashToken(a.token)).toBe(a.hash);
    expect(new Date(a.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });

  it("hands out relay ports in its range", () => {
    expect(allocateRelayPort(new Set())).toBe(RELAY_PORTS.from);
    expect(allocateRelayPort(new Set([RELAY_PORTS.from]))).toBe(RELAY_PORTS.from + 1);
    const all = new Set(Array.from({ length: RELAY_PORTS.to - RELAY_PORTS.from + 1 }, (_, i) => RELAY_PORTS.from + i));
    expect(allocateRelayPort(all)).toBeNull();
  });

  it("writes known_hosts lines like OpenSSH", () => {
    expect(knownHostsLine("203.0.113.10", 7822, "ssh-ed25519 AAAA")).toBe("[203.0.113.10]:7822 ssh-ed25519 AAAA");
    expect(knownHostsLine("serve.example.com", 22, "ssh-ed25519 AAAA")).toBe("serve.example.com ssh-ed25519 AAAA");
  });

  it("accepts only public keys", () => {
    const pair = utils.generateKeyPairSync("ed25519", { comment: "me@pc" });
    const normalized = normalizePublicKey(pair.public);
    expect(normalized).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+$/);
    // The comment is dropped, so the same key always compares equal.
    expect(normalized).toBe(normalizePublicKey(pair.public.replace("me@pc", "other")));
    expect(normalizePublicKey(pair.private)).toBeNull();
    expect(normalizePublicKey("not a key")).toBeNull();
    expect(normalizePublicKey("")).toBeNull();
  });

  it("quotes values for the shell", () => {
    expect(sh("plain")).toBe("'plain'");
    expect(sh("it's")).toBe(`'it'\\''s'`);
  });

  it("writes an install script bash accepts, with the values quoted", () => {
    const script = installScript({ joinUrl: "https://serve.example.com/api/servers/join/abc_DEF-123", user: "deploy'; rm -rf /" });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "serve-tunnel-")), "install.sh");
    fs.writeFileSync(file, script);
    // Syntax only: nothing runs.
    expect(() => execFileSync("bash", ["-n", file])).not.toThrow();
    expect(script).toContain("JOIN_URL='https://serve.example.com/api/servers/join/abc_DEF-123'");
    expect(script).toContain(`EXPECTED_USER='deploy'\\''; rm -rf /'`);
    // Keeps the tunnel up, pins the listener's key, allows only the one forward it needs.
    expect(script).toContain("ExitOnForwardFailure=yes");
    expect(script).toContain("StrictHostKeyChecking=yes");
    expect(script).toContain("-R 22:localhost:$SSH_PORT");
    expect(script).toContain("Restart=always");
  });
});
