import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt, decryptOrNull } from "@/server/crypto";

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

export class Cloudflare {
  constructor(
    private token: string,
    private originCaKey?: string | null,
  ) {}

  static async forAccount(accountId: string) {
    const [row] = await db.select().from(schema.cloudflareAccount).where(eq(schema.cloudflareAccount.id, accountId));
    if (!row) throw new Error("Cloudflare account not found");
    return new Cloudflare(decrypt(row.apiToken), decryptOrNull(row.originCaKey));
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
        return this.request<{ id: string; status: string }>(
          "GET",
          `/accounts/${accounts.result[0].id}/tokens/verify`,
        );
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
      const res = await this.request<CfZone[]>("GET", `/zones?per_page=50&page=${page}`);
      zones.push(...res.result);
      if (!res.result_info || page >= res.result_info.total_pages) break;
    }
    return zones;
  }

  async zone(zoneId: string) {
    return (await this.request<CfZone>("GET", `/zones/${zoneId}`)).result;
  }

  /** Find the zone that owns a hostname (longest suffix match). */
  async zoneFor(hostname: string): Promise<CfZone | null> {
    const zones = await this.zones();
    const host = hostname.toLowerCase().replace(/^\*\./, "");
    return (
      zones
        .filter((z) => host === z.name || host.endsWith(`.${z.name}`))
        .sort((a, b) => b.name.length - a.name.length)[0] ?? null
    );
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

  /** Create or update the A record for a hostname so it points at `ip`. */
  async upsertARecord(zoneId: string, hostname: string, ip: string, proxied: boolean, comment = "Managed by Serve") {
    const existing = await this.dnsRecords(zoneId, { name: hostname });
    const conflicting = existing.filter((r) => r.type === "CNAME");
    for (const r of conflicting) await this.deleteDnsRecord(zoneId, r.id);
    const a = existing.find((r) => r.type === "A");
    if (a) return this.updateDnsRecord(zoneId, a.id, { content: ip, proxied, comment });
    return this.createDnsRecord(zoneId, { type: "A", name: hostname, content: ip, proxied, comment });
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
