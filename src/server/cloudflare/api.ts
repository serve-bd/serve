import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { credentialToken } from "@/server/cloudflare/oauth";

const API = "https://api.cloudflare.com/client/v4";

export class CloudflareError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

type CfResponse<T> = {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; total_pages: number; count: number; total_count: number };
};

export type CfZone = {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  name_servers: string[];
  plan?: { name: string };
  account?: { id: string; name: string };
};

export type CfDnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  proxiable: boolean;
  ttl: number;
  comment?: string | null;
  priority?: number;
  modified_on?: string;
};

export type CfSslMode = "off" | "flexible" | "full" | "strict";

export type CfTunnel = {
  id: string;
  name: string;
  /** healthy | degraded | down | inactive */
  status: string;
  connections?: { id?: string; colo_name: string; is_pending_reconnect: boolean; origin_ip?: string; opened_at?: string; client_id?: string; client_version?: string }[];
  created_at?: string;
  /** When the tunnel last gained or lost all its connections. */
  conns_active_at?: string | null;
  conns_inactive_at?: string | null;
  token?: string;
};

export class Cloudflare {
  constructor(
    private token: string,
    private originCaKey?: string | null,
    /** Only this Cloudflare account's zones: a login can reach several accounts, each its own card. */
    private accountScope?: string | null,
  ) {}

  static async forAccount(accountId: string) {
    const [row] = await db.select().from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.id, accountId));
    if (!row) throw new Error("Cloudflare account not found");
    return Cloudflare.forRow(row);
  }

  /** A client for a stored account, through its login (with an OAuth token renewed when needed). */
  static async forRow(row: typeof schema.cloudflareAccount.$inferSelect) {
    const [[credential], siblings] = await Promise.all([
      db.select().from(schema.cloudflareCredential).where(eq(schema.cloudflareCredential.id, row.credentialId)),
      db.select({ id: schema.cloudflareAccount.id }).from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.credentialId, row.credentialId)),
    ]);
    if (!credential) throw new Error("Cloudflare account not found");
    // Only a login split into several cards sees one account per card. A single card keeps every
    // zone its token reaches (tokens connected before cards were split by account).
    return new Cloudflare(await credentialToken(credential), decryptOrNull(credential.originCaKey), siblings.length > 1 ? row.cfAccountId : null);
  }

  async request<T>(method: string, path: string, body?: unknown, useOriginKey = false): Promise<CfResponse<T>> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (useOriginKey && this.originCaKey) headers["X-Auth-User-Service-Key"] = this.originCaKey;
    else headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    let json: CfResponse<T>;
    try {
      json = (await res.json()) as CfResponse<T>;
    } catch {
      throw new CloudflareError(`Cloudflare returned HTTP ${res.status}`, res.status);
    }
    if (!res.ok || !json.success) {
      const message = json.errors?.map((e) => e.message).join("; ") || `Cloudflare returned HTTP ${res.status}`;
      throw new CloudflareError(message, res.status);
    }
    return json;
  }

  async verifyToken() {
    const res = await this.request<{ id: string; status: string }>("GET", "/user/tokens/verify").catch(async (e) => {
      // Account-owned tokens verify on a different endpoint.
      const accounts = await this.request<{ id: string }[]>("GET", "/accounts?per_page=5");
      if (accounts.result[0]) {
        return this.request<{ id: string; status: string }>("GET", `/accounts/${accounts.result[0].id}/tokens/verify`);
      }
      throw e;
    });
    return res.result;
  }

  async accounts() {
    return (await this.request<{ id: string; name: string }[]>("GET", "/accounts?per_page=50")).result;
  }

  async zones(): Promise<CfZone[]> {
    const zones: CfZone[] = [];
    for (let page = 1; page < 50; page++) {
      const scope = this.accountScope ? `&account.id=${encodeURIComponent(this.accountScope)}` : "";
      const res = await this.request<CfZone[]>("GET", `/zones?per_page=50&page=${page}${scope}`);
      zones.push(...res.result);
      if (!res.result_info || page >= res.result_info.total_pages) break;
    }
    return zones;
  }

  async zone(zoneId: string) {
    return (await this.request<CfZone>("GET", `/zones/${zoneId}`)).result;
  }

  /**
   * Find the zone that owns a hostname (longest suffix match). `activeOnly` skips zones whose
   * nameservers are not switched yet: anyone can add a pending zone, so only an active one proves control.
   */
  async zoneFor(hostname: string, { activeOnly = false }: { activeOnly?: boolean } = {}): Promise<CfZone | null> {
    const zones = (await this.zones()).filter((z) => !activeOnly || z.status === "active");
    const host = hostname.toLowerCase().replace(/^\*\./, "");
    return zones.filter((z) => host === z.name || host.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
  }

  async dnsRecords(zoneId: string, filter: { name?: string; type?: string } = {}): Promise<CfDnsRecord[]> {
    const records: CfDnsRecord[] = [];
    const qs = new URLSearchParams({ per_page: "500" });
    if (filter.name) qs.set("name", filter.name);
    if (filter.type) qs.set("type", filter.type);
    for (let page = 1; page < 20; page++) {
      qs.set("page", String(page));
      const res = await this.request<CfDnsRecord[]>("GET", `/zones/${zoneId}/dns_records?${qs}`);
      records.push(...res.result);
      if (!res.result_info || page >= res.result_info.total_pages) break;
    }
    return records;
  }

  async createDnsRecord(zoneId: string, record: Partial<CfDnsRecord>) {
    return (await this.request<CfDnsRecord>("POST", `/zones/${zoneId}/dns_records`, { ttl: 1, ...record })).result;
  }

  async updateDnsRecord(zoneId: string, recordId: string, record: Partial<CfDnsRecord>) {
    return (await this.request<CfDnsRecord>("PATCH", `/zones/${zoneId}/dns_records/${recordId}`, record)).result;
  }

  async deleteDnsRecord(zoneId: string, recordId: string) {
    await this.request("DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
  }

  /**
   * Create the A record for a hostname, or update one Serve created earlier.
   * Records created by someone else are never overwritten or adopted: when the user's own A
   * record already points at `ip`, it stays theirs and null is returned (nothing for Serve to delete later).
   */
  async upsertARecord(zoneId: string, hostname: string, ip: string, proxied: boolean, comment = "Managed by Serve"): Promise<CfDnsRecord | null> {
    const existing = (await this.dnsRecords(zoneId, { name: hostname })).filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
    const foreign = existing.filter((r) => r.comment !== comment);
    const blocking = foreign.filter((r) => !(r.type === "A" && r.content === ip));
    if (blocking.length) {
      throw new CloudflareError(`${hostname} already has a ${blocking[0].type} record (${blocking[0].content}). Remove it in Cloudflare or point it at this server yourself.`, 409);
    }
    if (foreign.length) return null;
    const a = existing.find((r) => r.type === "A");
    // Serve's own CNAME to a tunnel (the name went through one before) blocks any A record for the name.
    for (const r of existing) if (r !== a) await this.deleteDnsRecord(zoneId, r.id);
    if (a) return this.updateDnsRecord(zoneId, a.id, { content: ip, proxied, comment });
    return this.createDnsRecord(zoneId, { type: "A", name: hostname, content: ip, proxied, comment });
  }

  /**
   * Move a hostname's A records from one server to another: those pointing at `from` now point at
   * `to`, keeping their Cloudflare proxy setting and their owner (a record the user made stays
   * theirs). Records pointing anywhere else are left alone. A name with no record at all gets
   * Serve's own A record. Returns "moved", "created", or "untouched" when nothing pointed at `from`.
   */
  async moveARecords(
    zoneId: string,
    hostname: string,
    from: string,
    to: string,
    comment = "Managed by Serve",
  ): Promise<{ result: "moved" | "created" | "untouched"; record: CfDnsRecord | null }> {
    const existing = (await this.dnsRecords(zoneId, { name: hostname })).filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
    if (!existing.length) return { result: "created", record: await this.createDnsRecord(zoneId, { type: "A", name: hostname, content: to, proxied: false, comment }) };
    const atOld = existing.filter((r) => r.type === "A" && r.content === from);
    if (!atOld.length) return { result: existing.some((r) => r.type === "A" && r.content === to) ? "moved" : "untouched", record: null };
    // A record for the new IP already there (both servers listed): the old one goes, Cloudflare refuses duplicates.
    const already = existing.some((r) => r.type === "A" && r.content === to);
    let record: CfDnsRecord | null = null;
    for (const r of atOld) {
      if (already) await this.deleteDnsRecord(zoneId, r.id);
      else record = await this.updateDnsRecord(zoneId, r.id, { content: to });
    }
    return { result: "moved", record: record?.comment === comment ? record : null };
  }

  /**
   * Point a hostname at several servers (one DNS-only A record each), for names that lead to every
   * server something runs on (a database's read replicas). Serve's own records follow the list;
   * records someone else made are never changed, and block the name unless they match.
   */
  async setARecords(zoneId: string, hostname: string, ips: string[], comment: string) {
    const existing = (await this.dnsRecords(zoneId, { name: hostname })).filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
    const blocking = existing.filter((r) => r.comment !== comment && !(r.type === "A" && ips.includes(r.content)));
    if (blocking.length) {
      throw new CloudflareError(`${hostname} already has a ${blocking[0].type} record (${blocking[0].content}). Remove it in Cloudflare first.`, 409);
    }
    const covered = new Set(existing.filter((r) => r.type === "A").map((r) => r.content));
    for (const r of existing) if (r.comment === comment && (r.type !== "A" || !ips.includes(r.content))) await this.deleteDnsRecord(zoneId, r.id);
    for (const ip of ips) if (!covered.has(ip)) await this.createDnsRecord(zoneId, { type: "A", name: hostname, content: ip, proxied: false, comment });
  }

  /**
   * Point a hostname at a Cloudflare Tunnel (proxied CNAME to <id>.cfargotunnel.com).
   * Replaces records Serve created earlier (like an A record from before the tunnel); never foreign ones.
   */
  async upsertTunnelRecord(zoneId: string, hostname: string, tunnelId: string, comment = "Managed by Serve") {
    const target = `${tunnelId}.cfargotunnel.com`;
    const existing = (await this.dnsRecords(zoneId, { name: hostname })).filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
    const foreign = existing.filter((r) => r.comment !== comment && !(r.type === "CNAME" && r.content === target));
    if (foreign.length) {
      throw new CloudflareError(`${hostname} already has a ${foreign[0].type} record (${foreign[0].content}). Remove it in Cloudflare first.`, 409);
    }
    const cname = existing.find((r) => r.type === "CNAME");
    for (const r of existing) if (r !== cname) await this.deleteDnsRecord(zoneId, r.id);
    if (cname) return this.updateDnsRecord(zoneId, cname.id, { content: target, proxied: true, comment });
    return this.createDnsRecord(zoneId, { type: "CNAME", name: hostname, content: target, proxied: true, comment });
  }

  /* ------------------------------ Tunnels ------------------------------ */

  async createTunnel(accountId: string, name: string) {
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    return (await this.request<CfTunnel>("POST", `/accounts/${accountId}/cfd_tunnel`, { name, config_src: "cloudflare", tunnel_secret: secret })).result;
  }

  async tunnel(accountId: string, tunnelId: string) {
    return (await this.request<CfTunnel>("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}`)).result;
  }

  async tunnelToken(accountId: string, tunnelId: string) {
    return (await this.request<string>("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`)).result;
  }

  /** Replace the tunnel's routes (remotely managed configuration). */
  async setTunnelIngress(accountId: string, tunnelId: string, ingress: { hostname?: string; service: string; originRequest?: Record<string, unknown> }[]) {
    await this.request("PUT", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, { config: { ingress } });
  }

  async deleteTunnel(accountId: string, tunnelId: string) {
    // Drop lingering connector connections first; deletion fails while any exist.
    await this.request("DELETE", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`).catch(() => {});
    await this.request("DELETE", `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
  }

  async sslMode(zoneId: string): Promise<CfSslMode> {
    return (await this.request<{ value: CfSslMode }>("GET", `/zones/${zoneId}/settings/ssl`)).result.value;
  }

  async setSslMode(zoneId: string, value: CfSslMode) {
    await this.request("PATCH", `/zones/${zoneId}/settings/ssl`, { value });
  }

  async alwaysUseHttps(zoneId: string): Promise<boolean> {
    return (await this.request<{ value: string }>("GET", `/zones/${zoneId}/settings/always_use_https`)).result.value === "on";
  }

  async setAlwaysUseHttps(zoneId: string, on: boolean) {
    await this.request("PATCH", `/zones/${zoneId}/settings/always_use_https`, { value: on ? "on" : "off" });
  }

  async purgeCache(zoneId: string) {
    await this.request("POST", `/zones/${zoneId}/purge_cache`, { purge_everything: true });
  }

  /** Issue a Cloudflare Origin CA certificate (valid up to 15 years). */
  async createOriginCertificate(hostnames: string[], csr: string, days = 5475) {
    const res = await this.request<{ id: string; certificate: string; expires_on: string }>(
      "POST",
      "/certificates",
      { hostnames, csr, request_type: "origin-rsa", requested_validity: days },
      !!this.originCaKey,
    );
    return res.result;
  }
}
