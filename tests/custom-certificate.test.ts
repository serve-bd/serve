import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Uploaded certificates: what is read from them, and that a key of another certificate is refused
// before anything is written. Certificates are made with openssl at test time.

const written = vi.hoisted(() => [] as { file: string; content: string; mode?: number }[]);
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ db: {}, schema: new Proxy({}, { get: () => ({}) }) }));
vi.mock("@/server/db/schema", () => ({ LOCAL_SERVER_ID: "local" }));
vi.mock("@/server/proxy/nginx", () => ({}));
vi.mock("@/server/settings", () => ({ getSettings: async () => ({}) }));
vi.mock("@/server/notify", () => ({ notify: vi.fn() }));
vi.mock("@/server/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/server/servers/context", () => ({
  getServer: async (id: string) => ({
    id,
    paths: { certs: `/data/${id}/certs` },
    fs: { writeFile: async (file: string, content: string, mode?: number) => void written.push({ file, content, mode }) },
  }),
}));

const { parseCertificate, saveCustomCertificate } = await import("@/server/ssl/certificates");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-cert-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
function makeCert(name: string, args: string[], keyArgs = ["-newkey", "rsa:2048"]) {
  const key = path.join(dir, `${name}.key`);
  const crt = path.join(dir, `${name}.crt`);
  execFileSync("openssl", ["req", "-x509", ...keyArgs, "-nodes", "-keyout", key, "-out", crt, "-days", "30", ...args], { stdio: "ignore" });
  return { cert: fs.readFileSync(crt, "utf8"), key: fs.readFileSync(key, "utf8") };
}

const san = makeCert("san", ["-subj", "/O=Acme, Inc./CN=a.example.com", "-addext", "subjectAltName=DNS:a.example.com,DNS:*.a.example.com,IP:203.0.113.5"]);
const cnOnly = makeCert("cn", ["-subj", "/CN=only.example.com"], ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"]);
const other = makeCert("other", ["-subj", "/CN=other.example.com"]);

describe("parseCertificate", () => {
  it("reads DNS names (not IPs), the issuer and the expiry", () => {
    const p = parseCertificate(san.cert);
    expect(p.names).toEqual(["a.example.com", "*.a.example.com"]);
    expect(p.issuer).toBe("Acme, Inc.");
    const days = (p.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
  });

  it("falls back to the common name without SANs, and to the issuer's CN without an organization", () => {
    const p = parseCertificate(cnOnly.cert);
    expect(p.names).toEqual(["only.example.com"]);
    expect(p.issuer).toBe("only.example.com");
  });

  it("takes the first certificate of a chain, with text around it", () => {
    const p = parseCertificate(`subject=...\n${cnOnly.cert}\n${san.cert}`);
    expect(p.names).toEqual(["only.example.com"]);
  });

  it("refuses text without a certificate, and a damaged one", () => {
    expect(() => parseCertificate("")).toThrow(/No PEM certificate/);
    expect(() => parseCertificate(san.key)).toThrow(/No PEM certificate/);
    const damaged = san.cert.replace(/(-----BEGIN CERTIFICATE-----\n)(.{20})/, "$1AAAAAAAAAAAAAAAAAAAA");
    expect(() => parseCertificate(damaged)).toThrow();
  });
});

describe("saveCustomCertificate", () => {
  beforeEach(() => void (written.length = 0));

  it("writes the pair on the server, the key readable by its owner only", async () => {
    const saved = await saveCustomCertificate("c1", `\n${san.cert}\n\n`, san.key, "srv2");
    expect(saved.names).toEqual(["a.example.com", "*.a.example.com"]);
    expect(saved.certPath).toMatch(/\/c1\/fullchain\.pem$/);
    expect(saved.keyPath).toMatch(/\/c1\/privkey\.pem$/);
    expect(written).toEqual([
      { file: "/data/srv2/certs/c1/fullchain.pem", content: `${san.cert.trim()}\n`, mode: undefined },
      { file: "/data/srv2/certs/c1/privkey.pem", content: `${san.key.trim()}\n`, mode: 0o600 },
    ]);
  });

  it("accepts an EC pair", async () => {
    await expect(saveCustomCertificate("c2", cnOnly.cert, cnOnly.key)).resolves.toMatchObject({ names: ["only.example.com"] });
  });

  it("refuses a key of another certificate and writes nothing", async () => {
    await expect(saveCustomCertificate("c3", san.cert, other.key)).rejects.toThrow(/does not match/);
    // Another key type altogether.
    await expect(saveCustomCertificate("c3", san.cert, cnOnly.key)).rejects.toThrow(/does not match/);
    expect(written).toEqual([]);
  });

  it("refuses a missing or unreadable key and writes nothing", async () => {
    for (const key of ["", "not a key", san.cert]) await expect(saveCustomCertificate("c4", san.cert, key)).rejects.toThrow();
    expect(written).toEqual([]);
  });
});
