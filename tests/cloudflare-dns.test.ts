import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));

import { Cloudflare, type CfDnsRecord } from "@/server/cloudflare/api";

/** A zone held in memory, with Cloudflare's rule that a name with a CNAME has no other record. */
function fakeZone(records: CfDnsRecord[]) {
  const cf = new Cloudflare("token");
  let next = 1;
  cf.dnsRecords = async (_zone, filter = {}) => records.filter((r) => !filter.name || r.name === filter.name);
  cf.deleteDnsRecord = async (_zone, id) => void records.splice(records.findIndex((r) => r.id === id), 1);
  cf.updateDnsRecord = async (_zone, id, patch) => Object.assign(records.find((r) => r.id === id)!, patch);
  cf.createDnsRecord = async (_zone, record) => {
    if (records.some((r) => r.name === record.name && (r.type === "CNAME" || record.type === "CNAME"))) throw new Error("A CNAME record with that host already exists.");
    const created = { id: `new-${next++}`, proxiable: true, ttl: 1, proxied: false, content: "", type: "A", name: "", ...record } as CfDnsRecord;
    records.push(created);
    return created;
  };
  return { cf, records };
}

const record = (r: Partial<CfDnsRecord>) => ({ id: "r1", type: "A", name: "db.example.com", content: "", proxied: false, proxiable: true, ttl: 1, ...r }) as CfDnsRecord;

describe("upsertARecord", () => {
  it("replaces Serve's own tunnel CNAME with the A record", async () => {
    const { cf, records } = fakeZone([record({ type: "CNAME", content: "abc.cfargotunnel.com", comment: "Serve database domain" })]);
    const created = await cf.upsertARecord("z", "db.example.com", "203.0.113.5", false, "Serve database domain");
    expect(created?.type).toBe("A");
    expect(records.map((r) => [r.type, r.content])).toEqual([["A", "203.0.113.5"]]);
  });

  it("never touches a record someone else made", async () => {
    const { cf, records } = fakeZone([record({ type: "CNAME", content: "elsewhere.example.net", comment: null })]);
    await expect(cf.upsertARecord("z", "db.example.com", "203.0.113.5", false)).rejects.toThrow(/already has a CNAME/);
    expect(records).toHaveLength(1);
    const same = fakeZone([record({ content: "203.0.113.5", comment: "mine" })]);
    expect(await same.cf.upsertARecord("z", "db.example.com", "203.0.113.5", false)).toBeNull();
    expect(same.records[0].comment).toBe("mine");
  });

  it("updates its own A record in place", async () => {
    const { cf, records } = fakeZone([record({ content: "198.51.100.1", comment: "Managed by Serve" })]);
    await cf.upsertARecord("z", "db.example.com", "203.0.113.5", true);
    expect(records).toEqual([expect.objectContaining({ id: "r1", content: "203.0.113.5", proxied: true })]);
  });
});
