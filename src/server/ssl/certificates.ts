import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { paths, proxyPaths } from "@/server/paths";
import { run } from "@/server/process";
import { getSettings } from "@/server/settings";
import { ensureProxy, servicesUsingCertificate, syncDashboardProxy, syncServiceProxy } from "@/server/proxy/nginx";
import { Cloudflare } from "@/server/cloudflare/api";
import { notify } from "@/server/notify";
import { enqueue } from "@/server/queue";
import { certificateCovers } from "./match";

type Cert = typeof schema.certificate.$inferSelect;

const CERTBOT_IMAGE = "certbot/certbot:latest";
const CERTBOT_CF_IMAGE = "certbot/dns-cloudflare:latest";

export function parseCertificate(pem: string) {
  const first = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  if (!first) throw new Error("No PEM certificate found.");
  const x509 = new crypto.X509Certificate(first);
  const names = (x509.subjectAltName ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4));
  const cn = x509.subject.match(/CN=([^\n,]+)/)?.[1];
  return {
    names: names.length ? names : cn ? [cn] : [],
    issuer: x509.issuer.match(/O=([^\n,]+)/)?.[1] ?? x509.issuer.match(/CN=([^\n,]+)/)?.[1] ?? "Unknown",
    expiresAt: new Date(x509.validTo),
    x509,
  };
}

async function appendLog(id: string, text: string) {
  const [row] = await db.select({ logs: schema.certificate.logs }).from(schema.certificate).where(eq(schema.certificate.id, id));
  const logs = ((row?.logs ?? "") + text + "\n").slice(-100_000);
  await db.update(schema.certificate).set({ logs }).where(eq(schema.certificate.id, id));
}

/** Read a file produced by certbot (root-owned) through a throwaway container. */
async function readFromLetsencrypt(relative: string) {
  return run("docker", [
    "run",
    "--rm",
    "-v",
    `${paths.letsencrypt}:/etc/letsencrypt:ro`,
    "--entrypoint",
    "cat",
    CERTBOT_IMAGE,
    `/etc/letsencrypt/${relative}`,
  ]);
}

async function certbot(cert: Cert, log: (l: string) => void) {
  const settings = await getSettings();
  if (!settings.acmeEmail) throw new Error("Set a Let's Encrypt email in Settings → General first.");
  const isDns = cert.provider === "letsencrypt-cloudflare";
  const args = [
    "run",
    "--rm",
    "-v",
    `${paths.letsencrypt}:/etc/letsencrypt`,
    "-v",
    `${paths.acme}:/var/www/acme`,
    isDns ? CERTBOT_CF_IMAGE : CERTBOT_IMAGE,
    "certonly",
    "--non-interactive",
    "--agree-tos",
    "--email",
    settings.acmeEmail,
    "--cert-name",
    cert.id,
    "--keep-until-expiring",
    "--expand",
  ];
  if (settings.acmeStaging) args.push("--staging");
  if (isDns) {
    if (!cert.cloudflareAccountId) throw new Error("Pick a Cloudflare account for DNS validation.");
    const [account] = await db
      .select()
      .from(schema.cloudflareAccount)
      .where(eq(schema.cloudflareAccount.id, cert.cloudflareAccountId));
    if (!account) throw new Error("The Cloudflare account for this certificate was removed.");
    const credsDir = path.join(paths.letsencrypt, "serve-cloudflare");
    await fs.mkdir(credsDir, { recursive: true });
    const credsFile = path.join(credsDir, `${account.id}.ini`);
    await fs.writeFile(credsFile, `dns_cloudflare_api_token = ${decrypt(account.apiToken)}\n`, { mode: 0o600 });
    args.push(
      "--dns-cloudflare",
      "--dns-cloudflare-credentials",
      `/etc/letsencrypt/serve-cloudflare/${account.id}.ini`,
      "--dns-cloudflare-propagation-seconds",
      "30",
    );
  } else {
    await ensureProxy(log);
    args.push("--webroot", "-w", "/var/www/acme");
  }
  for (const d of cert.domains) args.push("-d", d);
  log(`$ certbot certonly ${isDns ? "--dns-cloudflare" : "--webroot"} ${cert.domains.map((d) => `-d ${d}`).join(" ")}`);
  await run("docker", args, { onLine: log });
  const pem = await readFromLetsencrypt(`live/${cert.id}/fullchain.pem`);
  return {
    pem,
    certPath: `${proxyPaths.letsencrypt}/live/${cert.id}/fullchain.pem`,
    keyPath: `${proxyPaths.letsencrypt}/live/${cert.id}/privkey.pem`,
  };
}

async function openssl(args: string[], cwd: string) {
  return run("openssl", args, { cwd });
}

async function cloudflareOrigin(cert: Cert, log: (l: string) => void) {
  if (!cert.cloudflareAccountId) throw new Error("Pick a Cloudflare account for the origin certificate.");
  const cf = await Cloudflare.forAccount(cert.cloudflareAccountId);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "serve-csr-"));
  try {
    log("Generating private key and CSR");
    await openssl(
      ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "csr.pem", "-subj", `/CN=${cert.domains[0]}`],
      tmp,
    );
    const csr = await fs.readFile(path.join(tmp, "csr.pem"), "utf8");
    log("Requesting Cloudflare Origin CA certificate");
    const result = await cf.createOriginCertificate(cert.domains, csr);
    const dir = path.join(paths.certs, cert.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "fullchain.pem"), result.certificate.trim() + "\n");
    await fs.copyFile(path.join(tmp, "key.pem"), path.join(dir, "privkey.pem"));
    await fs.chmod(path.join(dir, "privkey.pem"), 0o600);
    return {
      pem: result.certificate,
      certPath: `${proxyPaths.certs}/${cert.id}/fullchain.pem`,
      keyPath: `${proxyPaths.certs}/${cert.id}/privkey.pem`,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Save an uploaded certificate + key pair. */
export async function saveCustomCertificate(id: string, certPem: string, keyPem: string) {
  const parsed = parseCertificate(certPem);
  const key = crypto.createPrivateKey(keyPem);
  if (!parsed.x509.checkPrivateKey(key)) throw new Error("The private key does not match the certificate.");
  const dir = path.join(paths.certs, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "fullchain.pem"), certPem.trim() + "\n");
  await fs.writeFile(path.join(dir, "privkey.pem"), keyPem.trim() + "\n", { mode: 0o600 });
  return {
    ...parsed,
    certPath: `${proxyPaths.certs}/${id}/fullchain.pem`,
    keyPath: `${proxyPaths.certs}/${id}/privkey.pem`,
  };
}

/** Re-render every site that could use this certificate. */
export async function applyCertificate(cert: Cert) {
  const services = await servicesUsingCertificate(cert);
  for (const id of services) await syncServiceProxy(id).catch(() => {});
  const settings = await getSettings();
  if (settings.dashboardDomain && certificateCovers(cert.domains, settings.dashboardDomain)) {
    await syncDashboardProxy().catch(() => {});
  }
}

export async function issueCertificate(certificateId: string) {
  const [cert] = await db.select().from(schema.certificate).where(eq(schema.certificate.id, certificateId));
  if (!cert || cert.provider === "custom") return;
  const wasActive = cert.status === "active";
  await db
    .update(schema.certificate)
    .set({ status: "issuing", lastError: null, logs: `Started ${new Date().toISOString()}\n` })
    .where(eq(schema.certificate.id, cert.id));
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const flush = setInterval(() => {
    if (lines.length) void appendLog(cert.id, lines.splice(0).join("\n"));
  }, 1000);
  try {
    const result = cert.provider === "cloudflare-origin" ? await cloudflareOrigin(cert, log) : await certbot(cert, log);
    const parsed = parseCertificate(result.pem);
    clearInterval(flush);
    await appendLog(cert.id, [...lines.splice(0), `Certificate valid until ${parsed.expiresAt.toISOString()}`].join("\n"));
    const [updated] = await db
      .update(schema.certificate)
      .set({
        status: "active",
        certPath: result.certPath,
        keyPath: result.keyPath,
        issuer: parsed.issuer,
        expiresAt: parsed.expiresAt,
        lastError: null,
      })
      .where(eq(schema.certificate.id, cert.id))
      .returning();
    await applyCertificate(updated);
    void notify(cert.organizationId, "certificate.renewed", {
      ok: true,
      title: `Certificate ${wasActive ? "renewed" : "issued"}`,
      body: `${cert.domains.join(", ")} — valid until ${parsed.expiresAt.toDateString()}`,
      url: "/certificates",
    });
  } catch (error) {
    clearInterval(flush);
    const message = error instanceof Error ? error.message : String(error);
    const output = (error as { output?: string }).output;
    await appendLog(cert.id, [...lines.splice(0), `Failed: ${message}`].join("\n"));
    await db
      .update(schema.certificate)
      .set({ status: wasActive ? "active" : "failed", lastError: hint(output ?? message) })
      .where(eq(schema.certificate.id, cert.id));
    void notify(cert.organizationId, "certificate.failed", {
      ok: false,
      title: "Certificate request failed",
      body: `${cert.domains.join(", ")}: ${hint(output ?? message).slice(0, 300)}`,
      url: "/certificates",
    });
    throw error;
  }
}

/** Turn certbot's verbose output into a short, useful explanation. */
function hint(output: string) {
  const detail = output.match(/Detail: (.+)/)?.[1];
  if (/too many certificates|rateLimited/i.test(output)) return "Let's Encrypt rate limit reached. Try again later or use staging.";
  if (/NXDOMAIN|DNS problem/i.test(output)) return `DNS problem: ${detail ?? "the domain does not resolve yet."}`;
  if (/Connection refused|Timeout during connect|unauthorized/i.test(output))
    return `Validation failed: ${detail ?? "Let's Encrypt could not reach this server on port 80."} Check that the domain points to this server and port 80 is open.`;
  return (detail ?? output.trim().split("\n").slice(-3).join(" ")).slice(0, 1000);
}

/** Queue renewals for certificates expiring within 30 days. */
export async function renewDueCertificates() {
  const soon = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const due = await db
    .select()
    .from(schema.certificate)
    .where(and(eq(schema.certificate.autoRenew, true), lt(schema.certificate.expiresAt, soon)));
  for (const cert of due) {
    if (cert.provider === "custom") continue;
    await enqueue("certificate.issue", { certificateId: cert.id }, { concurrencyKey: `cert:${cert.id}`, maxAttempts: 3 });
  }
  await db
    .update(schema.certificate)
    .set({ status: "expired" })
    .where(and(eq(schema.certificate.status, "active"), lt(schema.certificate.expiresAt, new Date())));
}

/**
 * Make sure an HTTPS domain has a certificate. Reuses an existing one that covers
 * the hostname, otherwise requests a Let's Encrypt certificate.
 */
export async function ensureCertificateFor(domain: typeof schema.domain.$inferSelect, organizationId: string) {
  if (!domain.https) return null;
  const certs = await db.select().from(schema.certificate).where(eq(schema.certificate.organizationId, organizationId));
  const existing = certs.find(
    (c) => c.id === domain.certificateId || certificateCovers(c.domains, domain.hostname),
  );
  if (existing) {
    if (existing.status === "failed" && existing.provider !== "custom") {
      await enqueue("certificate.issue", { certificateId: existing.id }, { concurrencyKey: `cert:${existing.id}` });
    }
    return existing;
  }
  const settings = await getSettings();
  if (!settings.acmeEmail) return null;
  const useDns = !!domain.cloudflareAccountId;
  const id = newId();
  const [cert] = await db
    .insert(schema.certificate)
    .values({
      id,
      organizationId,
      name: domain.hostname,
      domains: [domain.hostname],
      provider: useDns ? "letsencrypt-cloudflare" : "letsencrypt-http",
      cloudflareAccountId: domain.cloudflareAccountId,
      status: "pending",
    })
    .returning();
  await enqueue("certificate.issue", { certificateId: id }, { concurrencyKey: `cert:${id}`, maxAttempts: 2 });
  return cert;
}

export async function deleteCertificateFiles(cert: Cert) {
  await fs.rm(path.join(paths.certs, cert.id), { recursive: true, force: true }).catch(() => {});
  if (cert.provider.startsWith("letsencrypt")) {
    await run("docker", [
      "run",
      "--rm",
      "-v",
      `${paths.letsencrypt}:/etc/letsencrypt`,
      CERTBOT_IMAGE,
      "delete",
      "--non-interactive",
      "--cert-name",
      cert.id,
    ]).catch(() => {});
  }
}
