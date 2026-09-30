import crypto from "node:crypto";
import dns from "node:dns/promises";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import { newId } from "@/server/id";
import { serverAllowsOrg } from "@/server/servers/ownership";
import { getSetting, getSettings } from "@/server/settings";
import { UserError } from "@/server/action";

export const VERIFY_LABEL = "_serve-verify";

/** The TXT value that proves an organization controls a domain. Keyed with the instance secret, so it cannot be guessed. */
export function verificationValue(organizationId: string) {
  const token = crypto.createHmac("sha256", env.encryptionKey).update(`domain-verify:${organizationId}`).digest("hex").slice(0, 32);
  return `serve-verify=${token}`;
}

/** The name and every parent with at least two labels: a.b.example.com → a.b.example.com, b.example.com, example.com. */
export function ownershipCandidates(hostname: string) {
  const labels = hostname.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "").split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

/** Names Serve hands out itself need no proof: sslip.io/nip.io addresses and names under a server's wildcard domain. */
export function ownershipExempt(hostname: string, wildcardDomains: string[]) {
  const host = hostname.toLowerCase().replace(/^\*\./, "");
  if (/\.(sslip\.io|nip\.io)$/.test(host)) return true;
  return wildcardDomains.some((w) => {
    const base = w.toLowerCase().replace(/^\*\./, "");
    return !!base && host.endsWith(`.${base}`);
  });
}

type WildcardServer = { wildcardDomain: string | null; ownerOrganizationId: string | null; organizationIds: string[] | null };

/**
 * Wildcard domains whose names an organization may use without proof: those of servers it deploys
 * to. Only Root admins, or an owner that proved the domain, can save a server's wildcard (updateServer).
 */
export function trustedWildcards(servers: WildcardServer[], organizationId: string) {
  return servers.filter((s) => !!s.wildcardDomain && serverAllowsOrg(s, organizationId)).map((s) => s.wildcardDomain!);
}

async function txtRecords(name: string): Promise<string[]> {
  // Public resolvers first: a record just added is not held back by a local cache.
  const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const records = await resolver.resolveTxt(name).catch(() => dns.resolveTxt(name).catch(() => [] as string[][]));
  return records.map((chunks) => chunks.join(""));
}

export type Ownership =
  | { verified: true; via: "root" | "off" | "exempt" | "verified" | "txt" | "cloudflare"; name?: string }
  | { verified: false; recordName: string; recordValue: string };

/**
 * Whether an organization may add a custom domain. Checks, in order: the Root organization and the
 * setting, names Serve generates, domains it verified before (a parent covers its subdomains), a
 * TXT record at _serve-verify.<name or parent>, and the zone in one of its Cloudflare accounts.
 * A new proof is remembered.
 */
export async function domainOwnership(org: { id: string; isRoot: boolean }, hostname: string): Promise<Ownership> {
  if (org.isRoot) return { verified: true, via: "root" };
  if (!(await getSetting("domainVerification"))) return { verified: true, via: "off" };
  if (ownershipExempt(hostname, await trustedWildcardsFor(org.id))) return { verified: true, via: "exempt" };

  const candidates = ownershipCandidates(hostname);
  const [known] = await db
    .select({ name: schema.verifiedDomain.name })
    .from(schema.verifiedDomain)
    .where(and(eq(schema.verifiedDomain.organizationId, org.id), inArray(schema.verifiedDomain.name, candidates)));
  if (known) return { verified: true, via: "verified", name: known.name };

  const value = verificationValue(org.id);
  for (const name of candidates) {
    if ((await txtRecords(`${VERIFY_LABEL}.${name}`)).some((r) => r.trim() === value)) {
      await remember(org.id, name, "txt");
      return { verified: true, via: "txt", name };
    }
  }

  // The zone in the organization's own Cloudflare account proves control of its DNS.
  const accounts = await db.select({ id: schema.cloudflareAccount.id }).from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.organizationId, org.id));
  if (accounts.length) {
    const { Cloudflare } = await import("@/server/cloudflare/api");
    for (const account of accounts) {
      const zone = await Cloudflare.forAccount(account.id)
        .then((cf) => cf.zoneFor(hostname.replace(/^\*\./, ""), { activeOnly: true }))
        .catch(() => null);
      if (zone) {
        await remember(org.id, zone.name.toLowerCase(), "cloudflare");
        return { verified: true, via: "cloudflare", name: zone.name };
      }
    }
  }
  return { verified: false, recordName: `${VERIFY_LABEL}.${candidates[0]}`, recordValue: value };
}

async function trustedWildcardsFor(organizationId: string) {
  const servers = await db
    .select({ wildcardDomain: schema.server.wildcardDomain, ownerOrganizationId: schema.server.ownerOrganizationId, organizationIds: schema.server.organizationIds })
    .from(schema.server);
  return trustedWildcards(servers, organizationId);
}

async function remember(organizationId: string, name: string, method: "txt" | "cloudflare") {
  await db.insert(schema.verifiedDomain).values({ id: newId(), organizationId, name, method }).onConflictDoNothing();
}

/** The dashboard's own hostnames belong to it; a wildcard over them only to the Root organization. */
export async function assertNotDashboardHost(org: { isRoot: boolean }, hostname: string) {
  const settings = await getSettings();
  const reserved = [settings.dashboardDomain, new URL(env.appUrl).hostname].filter((h): h is string => !!h).map((h) => h.toLowerCase());
  if (reserved.includes(hostname)) throw new UserError("That is the dashboard's own domain.");
  if (hostname.startsWith("*.") && !org.isRoot) {
    const suffix = hostname.slice(1);
    if (reserved.some((h) => h.endsWith(suffix) && !h.slice(0, -suffix.length).includes("."))) throw new UserError("That wildcard would cover the dashboard's domain.");
  }
}

/** The message shown when a domain still needs its TXT record. */
export function ownershipMessage(hostname: string, o: Extract<Ownership, { verified: false }>) {
  return `Prove you own ${hostname.replace(/^\*\./, "")}: add a TXT record named ${o.recordName} with the value ${o.recordValue} (a record on a parent domain like _serve-verify.example.com covers all its subdomains), then try again.`;
}
