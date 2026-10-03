import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { LOCAL_SERVER_ID } from "@/server/db/schema";
import { decrypt } from "@/server/crypto";
import { newId } from "@/server/id";
import { proxyPaths } from "@/server/paths";
import { run } from "@/server/process";
import { getSettings } from "@/server/settings";
import { getServer, type ServerCtx } from "@/server/servers/context";
import { ensureServerProxy, reloadProxy, servicesUsingCertificate, syncDashboardProxy, syncServiceProxy } from "@/server/proxy/nginx";
import { Cloudflare } from "@/server/cloudflare/api";
import { notify } from "@/server/notify";
import { enqueue } from "@/server/queue";
import { certificateCovers } from "./match";
import { isCloudflareIp, resolveA } from "@/server/dns";
import { publicRequest } from "@/server/net/public-fetch";

type Cert = typeof schema.certificate.$inferSelect;

// Pinned by digest: they run with every private key mounted.
const CERTBOT_IMAGE = "certbot/certbot:v5.8.0@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20";
const CERTBOT_CF_IMAGE = "certbot/dns-cloudflare:v5.8.0@sha256:c45edb002b883da1a1235abb205dff474a7a1a459d878e8d5fdc7f9d83073aea";

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

/** Docker CLI on the certificate's server (certbot runs where the proxy serves the challenge). */
async function docker(ctx: ServerCtx, args: string[], opts: { onLine?: (l: string) => void } = {}) {
  return run("docker", args, { env: await ctx.cliEnv(), onLine: opts.onLine });
}

/** Read a file produced by certbot (root-owned) through a throwaway container. */
async function readFromLetsencrypt(ctx: ServerCtx, relative: string) {
  return docker(ctx, ["run", "--rm", "-v", `${ctx.paths.letsencrypt}:/etc/letsencrypt:ro`, "--entrypoint", "cat", CERTBOT_IMAGE, `/etc/letsencrypt/${relative}`]);
}

/** The PEM files of a certificate as the proxy uses them: the certificate with its chain, and the private key. */
export async function readCertificateFiles(cert: Cert) {
  if (!cert.certPath || !cert.keyPath) throw new Error("This certificate has no files yet.");
  const ctx = await certificateServer(cert);
  const read = (proxyPath: string) =>
    proxyPath.startsWith(`${proxyPaths.letsencrypt}/`)
      ? readFromLetsencrypt(ctx, proxyPath.slice(proxyPaths.letsencrypt.length + 1))
      : ctx.fs.readFile(path.posix.join(ctx.paths.certs, path.posix.relative(proxyPaths.certs, proxyPath)));
  const [certificate, privateKey] = await Promise.all([read(cert.certPath), read(cert.keyPath)]);
  return { certificate: certificate.trim(), privateKey: privateKey.trim() };
}

/** The server a certificate is stored on and served from. */
export function certificateServer(cert: Pick<Cert, "serverId">) {
  return getServer(cert.serverId || LOCAL_SERVER_ID);
}

/**
 * Catch HTTP challenges that cannot pass before asking Let's Encrypt, which
 * counts failures against rate limits. Only definite problems stop the run.
 */
async function httpPreflight(ctx: ServerCtx, cert: Cert, log: (l: string) => void) {
  if (ctx.proxyHttpPort === 0) {
    throw new Error(
      `The proxy on ${ctx.name} takes no ports on the machine, so Let's Encrypt cannot reach it. Serve the domain through a Cloudflare Tunnel (it brings its own certificate), or connect Cloudflare in Integrations to use the DNS check.`,
    );
  }
  // Another program can own port 80 and pass requests on to the proxy (a system nginx in front).
  // Ask the domains for a file only the proxy has: when they answer with it, the check passes.
  if (ctx.proxyHttpPort !== 80 && !(await port80ReachesProxy(ctx, cert, log))) {
    throw new Error(
      `The proxy on ${ctx.name} listens on port ${ctx.proxyHttpPort}, but Let's Encrypt only checks port 80, and port 80 of ${cert.domains[0]} does not reach the proxy. Pass port 80 on to port ${ctx.proxyHttpPort} from the program that owns it, connect Cloudflare in Integrations to use the DNS check, or turn off HTTPS for the domain and open http://${cert.domains[0]}:${ctx.proxyHttpPort}.`,
    );
  }
  const { serverAddressing } = await import("@/server/proxy/addressing");
  const { publicIp } = await serverAddressing(ctx.id);
  for (const domain of cert.domains) {
    if (domain.startsWith("*.")) throw new Error(`Wildcard ${domain} needs the DNS check. Connect Cloudflare in Integrations and choose Cloudflare DNS.`);
    const records = await resolveA(domain).catch(() => [] as string[]);
    if (!records.length) throw new Error(`DNS problem: NXDOMAIN looking up A for ${domain} - no A record points to this server yet.`);
    if (records.every(isCloudflareIp)) {
      log(`${domain} is behind Cloudflare's proxy; the check reaches this server only if Cloudflare can connect to it on port 80.`);
      continue;
    }
    if (publicIp && !records.includes(publicIp)) {
      throw new Error(`${domain} points to ${records.join(", ")}, not to ${ctx.name} (${publicIp}). Update its A record and retry.`);
    }
  }
}

/** Whether http://<domain>/ on port 80 reaches this server's proxy, for every domain of the certificate. */
async function port80ReachesProxy(ctx: ServerCtx, cert: Cert, log: (l: string) => void) {
  const domains = cert.domains.filter((d) => !d.startsWith("*."));
  if (!domains.length) return false;
  await ensureServerProxy(ctx, log);
  const name = `serve-check-${crypto.randomBytes(12).toString("hex")}`;
  const token = crypto.randomBytes(24).toString("hex");
  const file = path.posix.join(ctx.paths.acme, ".well-known/acme-challenge", name);
  await ctx.fs.writeFile(file, token);
  try {
    for (const domain of domains) {
      // The domain's address is the organization's choice: only public addresses are asked.
      const body = await publicRequest(`http://${domain}/.well-known/acme-challenge/${name}`, { method: "GET", timeoutMs: 10_000 })
        .then((r) => (r.status >= 200 && r.status < 300 ? r.text : null))
        .catch(() => null);
      if (body?.trim() !== token) return false;
    }
    log(`Port 80 of ${domains.join(", ")} reaches the proxy on port ${ctx.proxyHttpPort}.`);
    return true;
  } finally {
    await ctx.fs.rm(file).catch(() => {});
  }
}

/** One certbot run at a time per server: runs share /etc/letsencrypt and its lock. */
const certbotRuns = new Map<string, Promise<unknown>>();

function oneAtATime<T>(serverId: string, run: () => Promise<T>): Promise<T> {
  const previous = certbotRuns.get(serverId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  certbotRuns.set(serverId, next);
  void next.finally(() => certbotRuns.get(serverId) === next && certbotRuns.delete(serverId)).catch(() => {});
  return next;
}

async function certbot(cert: Cert, log: (l: string) => void) {
  const ctx = await certificateServer(cert);
  return oneAtATime(ctx.id, () => certbotOn(ctx, cert, log));
}

async function certbotOn(ctx: ServerCtx, cert: Cert, log: (l: string) => void) {
  const settings = await getSettings();
  if (!settings.acmeEmail) throw new Error("Set a Let's Encrypt email in Settings → General first.");
  const isDns = cert.provider === "letsencrypt-cloudflare";
  if (!isDns) await httpPreflight(ctx, cert, log);
  const args = [
    "run",
    "--rm",
    "-v",
    `${ctx.paths.letsencrypt}:/etc/letsencrypt`,
    "-v",
    `${ctx.paths.acme}:/var/www/acme`,
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
  const credsFiles: string[] = [];
  if (isDns) {
    if (!cert.cloudflareAccountId) throw new Error("Pick a Cloudflare account for DNS validation.");
    const [account] = await db.select().from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.id, cert.cloudflareAccountId));
    if (!account) throw new Error("The Cloudflare account for this certificate was removed.");
    // One file per certificate: a run that ends does not delete the file of another still running.
    // Outside the letsencrypt directory, which the proxy mounts: the token is for certbot alone.
    const credsDir = path.posix.join(ctx.paths.letsencrypt, "..", "letsencrypt-creds");
    const credsFile = path.posix.join(credsDir, `${cert.id}.ini`);
    // Earlier versions kept the files inside the letsencrypt directory, one per account: those go too.
    credsFiles.push(
      credsFile,
      path.posix.join(ctx.paths.letsencrypt, "serve-cloudflare", `${cert.id}.ini`),
      path.posix.join(ctx.paths.letsencrypt, "serve-cloudflare", `${account.id}.ini`),
    );
    await ctx.fs.writeFile(credsFile, `dns_cloudflare_api_token = ${decrypt(account.apiToken)}\n`, 0o600);
    // A docker option: before the image, or certbot gets it as its own argument.
    args.splice(args.indexOf(CERTBOT_CF_IMAGE), 0, "-v", `${credsDir}:/etc/serve-creds:ro`);
    args.push("--dns-cloudflare", "--dns-cloudflare-credentials", `/etc/serve-creds/${cert.id}.ini`, "--dns-cloudflare-propagation-seconds", "30");
  } else {
    await ensureServerProxy(ctx, log);
    args.push("--webroot", "-w", "/var/www/acme");
  }
  for (const d of cert.domains) args.push("-d", d);
  log(`$ certbot certonly ${isDns ? "--dns-cloudflare" : "--webroot"} ${cert.domains.map((d) => `-d ${d}`).join(" ")}${ctx.local ? "" : `  (on ${ctx.name})`}`);
  try {
    await docker(ctx, args, { onLine: log });
  } finally {
    // The token is written again for every run: it does not stay on the server between them.
    for (const file of credsFiles) await ctx.fs.rm(file).catch(() => {});
  }
  const pem = await readFromLetsencrypt(ctx, `live/${cert.id}/fullchain.pem`);
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
  const ctx = await certificateServer(cert);
  const cf = await Cloudflare.forAccount(cert.cloudflareAccountId);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "serve-csr-"));
  try {
    log("Generating private key and CSR");
    await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "csr.pem", "-subj", `/CN=${cert.domains[0]}`], tmp);
    const csr = await fs.readFile(path.join(tmp, "csr.pem"), "utf8");
    log("Requesting Cloudflare Origin CA certificate");
    const result = await cf.createOriginCertificate(cert.domains, csr);
    const dir = path.posix.join(ctx.paths.certs, cert.id);
    await ctx.fs.writeFile(path.posix.join(dir, "fullchain.pem"), result.certificate.trim() + "\n");
    await ctx.fs.writeFile(path.posix.join(dir, "privkey.pem"), await fs.readFile(path.join(tmp, "key.pem")), 0o600);
    return {
      pem: result.certificate,
      certPath: `${proxyPaths.certs}/${cert.id}/fullchain.pem`,
      keyPath: `${proxyPaths.certs}/${cert.id}/privkey.pem`,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Save an uploaded certificate + key pair on the server that will serve it. */
export async function saveCustomCertificate(id: string, certPem: string, keyPem: string, serverId: string = LOCAL_SERVER_ID) {
  const parsed = parseCertificate(certPem);
  const key = crypto.createPrivateKey(keyPem);
  if (!parsed.x509.checkPrivateKey(key)) throw new Error("The private key does not match the certificate.");
  const ctx = await getServer(serverId);
  const dir = path.posix.join(ctx.paths.certs, id);
  await ctx.fs.writeFile(path.posix.join(dir, "fullchain.pem"), certPem.trim() + "\n");
  await ctx.fs.writeFile(path.posix.join(dir, "privkey.pem"), keyPem.trim() + "\n", 0o600);
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
  // The dashboard is served by the local proxy only.
  if (cert.serverId === LOCAL_SERVER_ID && settings.dashboardDomain && certificateCovers(cert.domains, settings.dashboardDomain)) {
    await syncDashboardProxy().catch(() => {});
  }
  // A renewal writes the same file paths: sites with their own proxy config would keep the old one.
  if (cert.serverId) {
    await getServer(cert.serverId)
      .then((server) => reloadProxy(server))
      .catch(() => {});
    // Databases on domains serve the certificate themselves: they load a new or renewed one.
    const { refreshDatabaseCertificates } = await import("@/server/databases/domain-tls");
    await refreshDatabaseCertificates(cert.serverId, cert.domains, cert.organizationId).catch(() => {});
  }
}

/** A connected Cloudflare account whose zones contain every domain, if any. */
export async function cloudflareAccountFor(domains: string[], organizationId: string) {
  const accounts = await db.select().from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.organizationId, organizationId));
  for (const account of accounts) {
    try {
      const cf = new Cloudflare(decrypt(account.apiToken));
      const zones = await Promise.all(domains.map((d) => cf.zoneFor(d.replace(/^\*\./, ""))));
      if (zones.every(Boolean)) return account.id;
    } catch {
      // try the next account
    }
  }
  return null;
}

export async function issueCertificate(certificateId: string) {
  let [cert] = await db.select().from(schema.certificate).where(eq(schema.certificate.id, certificateId));
  if (!cert || cert.provider === "custom") return;
  // The DNS challenge works behind Cloudflare's proxy, NAT and non-standard ports;
  // the HTTP challenge does not. Prefer it whenever Cloudflare manages the domain.
  if (cert.provider === "letsencrypt-http") {
    const accountId = await cloudflareAccountFor(cert.domains, cert.organizationId);
    if (accountId) {
      [cert] = await db
        .update(schema.certificate)
        .set({ provider: "letsencrypt-cloudflare", cloudflareAccountId: accountId })
        .where(eq(schema.certificate.id, cert.id))
        .returning();
    }
  }
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
      status: wasActive ? "renewed" : "issued",
      dedupKey: `certificate:${cert.id}`,
      data: { certificateId: cert.id, domains: cert.domains, expiresAt: parsed.expiresAt.toISOString() },
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
      error: hint(output ?? message).slice(0, 2000),
      dedupKey: `certificate:${cert.id}`,
      data: { certificateId: cert.id, domains: cert.domains },
    });
    // Report the reason, not "docker run exited with code 1", in the job and worker log.
    throw new Error(
      `${cert.domains.join(", ")}: ${hint(output ?? message)
        .split("\n")[0]
        .slice(0, 500)}`,
    );
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
/**
 * The certificate a domain uses, requested when there is none. Before a service's first deploy an
 * existing one is used, but none is requested: nothing serves the domain yet, and a certificate
 * nobody uses still counts against Let's Encrypt's limits and renews every few months. The first
 * deploy asks with `requestNow`.
 */
export async function ensureCertificateFor(domain: typeof schema.domain.$inferSelect, organizationId: string, opts: { requestNow?: boolean } = {}) {
  if (!domain.https) return null;
  // Certificates live on the server whose proxy serves the domain.
  const [svc] = await db
    .select({ serverId: schema.service.serverId, currentDeploymentId: schema.service.currentDeploymentId })
    .from(schema.service)
    .where(eq(schema.service.id, domain.serviceId));
  const serverId = svc?.serverId ?? LOCAL_SERVER_ID;
  // Caddy and Traefik obtain and renew certificates themselves.
  const [server] = await db.select({ kind: schema.server.proxyKind }).from(schema.server).where(eq(schema.server.id, serverId));
  if (server && server.kind !== "nginx") return null;
  const certs = await db
    .select()
    .from(schema.certificate)
    .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, serverId)));
  const existing = certs.find((c) => c.id === domain.certificateId || certificateCovers(c.domains, domain.hostname));
  if (existing) {
    if (existing.status === "failed" && existing.provider !== "custom") {
      await enqueue("certificate.issue", { certificateId: existing.id }, { concurrencyKey: `cert:${existing.id}` });
    }
    return existing;
  }
  if (!svc?.currentDeploymentId && !opts.requestNow) return null;
  const settings = await getSettings();
  if (!settings.acmeEmail) return null;
  const cloudflareAccountId = domain.cloudflareAccountId ?? (await cloudflareAccountFor([domain.hostname], organizationId));
  const useDns = !!cloudflareAccountId;
  const id = newId();
  const [cert] = await db
    .insert(schema.certificate)
    .values({
      id,
      organizationId,
      serverId,
      name: domain.hostname,
      domains: [domain.hostname],
      provider: useDns ? "letsencrypt-cloudflare" : "letsencrypt-http",
      cloudflareAccountId,
      status: "pending",
    })
    .returning();
  await enqueue("certificate.issue", { certificateId: id }, { concurrencyKey: `cert:${id}`, maxAttempts: 2 });
  return cert;
}

/** Certificates of an organization with the name of the server each one lives on. */
export async function certificatesWithServers(organizationId: string) {
  return db
    .select({ certificate: schema.certificate, serverName: schema.server.name, serverIsLocal: schema.server.isLocal })
    .from(schema.certificate)
    .innerJoin(schema.server, eq(schema.certificate.serverId, schema.server.id))
    .where(eq(schema.certificate.organizationId, organizationId))
    .orderBy(asc(schema.certificate.createdAt));
}

/** Whether a site, a database domain or the dashboard on the certificate's server still uses it. */
async function certificateInUse(cert: Cert) {
  if ((await servicesUsingCertificate(cert)).length) return true;
  const databases = await db
    .select({ domain: sql<string | null>`${schema.service.database}->>'domain'`, tunnel: sql<string | null>`${schema.service.database}->>'domainTunnelId'` })
    .from(schema.service)
    .innerJoin(schema.project, eq(schema.service.projectId, schema.project.id))
    .where(and(eq(schema.project.organizationId, cert.organizationId), eq(schema.service.serverId, cert.serverId), eq(schema.service.type, "database")));
  // A database on its domain through a tunnel needs no certificate: Cloudflare carries the TLS.
  if (databases.some((d) => d.domain && !d.tunnel && certificateCovers(cert.domains, d.domain))) return true;
  const settings = await getSettings();
  return cert.serverId === LOCAL_SERVER_ID && !!settings.dashboardDomain && certificateCovers(cert.domains, settings.dashboardDomain);
}

/**
 * A domain was given up: the certificate Serve got for that one name goes too, with its files,
 * unless something else on the server still uses it. Certificates someone made (uploaded, several
 * names, a wildcard) stay.
 */
export async function retireCertificateFor(hostname: string, serverId: string, organizationId: string) {
  const certs = await db
    .select({ id: schema.certificate.id })
    .from(schema.certificate)
    .where(and(eq(schema.certificate.organizationId, organizationId), eq(schema.certificate.serverId, serverId), eq(schema.certificate.name, hostname)));
  for (const c of certs) await enqueue("certificate.retire", { certificateId: c.id }, { concurrencyKey: `cert:${c.id}` });
}

export async function retireCertificate(certificateId: string) {
  const [cert] = await db.select().from(schema.certificate).where(eq(schema.certificate.id, certificateId));
  if (!cert) return;
  if (!cert.provider.startsWith("letsencrypt") || cert.domains.length !== 1 || cert.domains[0] !== cert.name) return;
  if (await certificateInUse(cert)) return;
  await db.delete(schema.certificate).where(eq(schema.certificate.id, cert.id));
  await deleteCertificateFiles(cert);
}

export async function deleteCertificateFiles(cert: Cert) {
  let ctx: ServerCtx;
  try {
    ctx = await certificateServer(cert);
  } catch {
    return; // server removed
  }
  await ctx.fs.rm(path.posix.join(ctx.paths.certs, cert.id)).catch(() => {});
  await ctx.fs.rm(path.posix.join(ctx.paths.letsencrypt, "serve-cloudflare", `${cert.id}.ini`)).catch(() => {});
  await ctx.fs.rm(path.posix.join(ctx.paths.letsencrypt, "..", "letsencrypt-creds", `${cert.id}.ini`)).catch(() => {});
  if (cert.provider.startsWith("letsencrypt")) {
    await docker(ctx, ["run", "--rm", "-v", `${ctx.paths.letsencrypt}:/etc/letsencrypt`, CERTBOT_IMAGE, "delete", "--non-interactive", "--cert-name", cert.id]).catch(() => {});
  }
}
