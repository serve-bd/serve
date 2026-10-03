import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "@/server/process";
import type { ServerCtx } from "@/server/servers/context";

/** Directory on the server holding a database's certificate authority and server certificate. */
export const tlsDir = (ctx: ServerCtx, serviceId: string) => path.posix.join(ctx.paths.service(serviceId), "tls");

/**
 * Makes sure the database has a private certificate authority and a server
 * certificate signed by it. Created once and kept, so clients that trust the CA
 * keep working across restarts. Returns true when new files were created.
 */
export async function ensureDatabaseTls(ctx: ServerCtx, serviceId: string, names: string[], log?: (l: string) => void) {
  const dir = tlsDir(ctx, serviceId);
  if ((await ctx.fs.exists(path.posix.join(dir, "server.pem"))) && (await ctx.fs.exists(path.posix.join(dir, "ca.crt")))) return false;
  log?.("Creating a certificate authority and server certificate for TLS");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "serve-dbtls-"));
  try {
    const openssl = (args: string[]) => run("openssl", args, { cwd: tmp });
    const dns = [...new Set(names.filter(Boolean))];
    const san = dns.map((n) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(n) ? `IP:${n}` : `DNS:${n}`)).join(",");
    await openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-keyout", "ca.key", "-out", "ca.crt", "-subj", `/CN=Serve database CA ${serviceId}`]);
    await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", `/CN=${dns[0] ?? "database"}`]);
    // clientAuth too: MongoDB replica set members present it when they connect to each other.
    await fs.writeFile(path.join(tmp, "ext.cnf"), `subjectAltName=${san}\nextendedKeyUsage=serverAuth,clientAuth\n`);
    await openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "3650", "-out", "server.crt", "-extfile", "ext.cnf"]);
    const read = (f: string) => fs.readFile(path.join(tmp, f), "utf8");
    const [ca, caKey, cert, key] = await Promise.all([read("ca.crt"), read("ca.key"), read("server.crt"), read("server.key")]);
    await ctx.fs.writeFile(path.posix.join(dir, "ca.crt"), ca, 0o644);
    // The signing key never enters the container (a file read in the database could reach it).
    await ctx.fs.writeFile(path.posix.join(dir, "..", "tls-ca", "ca.key"), caKey, 0o600);
    await ctx.fs.rm(path.posix.join(dir, "ca.key")).catch(() => {});
    await ctx.fs.writeFile(path.posix.join(dir, "server.crt"), cert, 0o644);
    // The start script copies these as root inside the container and hands them to the server user.
    await ctx.fs.writeFile(path.posix.join(dir, "server.key"), key, 0o600);
    await ctx.fs.writeFile(path.posix.join(dir, "server.pem"), cert + key, 0o600);
    return true;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** The CA certificate clients use to verify the database. Null before TLS was turned on. */
export async function databaseCa(ctx: ServerCtx, serviceId: string) {
  const file = path.posix.join(tlsDir(ctx, serviceId), "ca.crt");
  return (await ctx.fs.exists(file)) ? ctx.fs.readFile(file) : null;
}

const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

/**
 * A server certificate made before it could be a client certificate too (MongoDB replica set
 * members need both) is issued again by the same authority, for the same names: clients that trust
 * the authority keep working. True when it was renewed; the database restarts to load it.
 */
export async function ensureClientAuth(ctx: ServerCtx, serviceId: string, log?: (l: string) => void) {
  const dir = tlsDir(ctx, serviceId);
  const pem = await ctx.fs.readFile(path.posix.join(dir, "server.crt")).catch(() => null);
  if (!pem) return false;
  const cert = new X509Certificate(pem);
  if (!cert.keyUsage || cert.keyUsage.includes(CLIENT_AUTH)) return false;
  const caKey = await ctx.fs.readFile(path.posix.join(dir, "..", "tls-ca", "ca.key")).catch(() => null);
  const ca = await ctx.fs.readFile(path.posix.join(dir, "ca.crt"));
  if (!caKey) throw new Error("The database's certificate authority key is missing: turn TLS off and on again to create a new one.");
  log?.("Renewing the database's certificate so replica set members can use it too");
  const san = (cert.subjectAltName ?? "")
    .split(/,\s*/)
    .map((n) => n.replace(/^IP Address:/, "IP:"))
    .filter(Boolean)
    .join(",");
  const cn = cert.subject.match(/CN=([^\n]+)/)?.[1] ?? "database";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "serve-dbtls-"));
  try {
    const openssl = (args: string[]) => run("openssl", args, { cwd: tmp });
    await fs.writeFile(path.join(tmp, "ca.crt"), ca);
    await fs.writeFile(path.join(tmp, "ca.key"), caKey, { mode: 0o600 });
    await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", `/CN=${cn}`]);
    await fs.writeFile(path.join(tmp, "ext.cnf"), `${san ? `subjectAltName=${san}\n` : ""}extendedKeyUsage=serverAuth,clientAuth\n`);
    await openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "3650", "-out", "server.crt", "-extfile", "ext.cnf"]);
    const read = (f: string) => fs.readFile(path.join(tmp, f), "utf8");
    const [crt, key] = await Promise.all([read("server.crt"), read("server.key")]);
    await ctx.fs.writeFile(path.posix.join(dir, "server.crt"), crt, 0o644);
    await ctx.fs.writeFile(path.posix.join(dir, "server.key"), key, 0o600);
    await ctx.fs.writeFile(path.posix.join(dir, "server.pem"), crt + key, 0o600);
    return true;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
