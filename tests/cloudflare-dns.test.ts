import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));

import { Cloudflare, type CfDnsRecord } from "@/server/cloudflare/api";

/** A zone held in memory, with Cloudflare's rule that a name with a CNAME has no other record. */
function fakeZone(records: CfDnsRecord[]) {
  const cf = new Cloudflare("token");
  let next = 1;
  cf.dnsRecords = async (_zone, filter = {}) => records.filter((r) => !filter.name || r.name === filter.name);
  cf.deleteDnsRecord = async (_zone, id) =>
    void records.splice(
      records.findIndex((r) => r.id === id),
      1,
    );
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

describe("moveARecords", () => {
  const OLD = "152.53.195.199";
  const NEW = "62.238.45.251";

  it("moves the user's own A record from the old server, keeping its proxy setting and owner", async () => {
    const { cf, records } = fakeZone([record({ name: "serve.bd", content: OLD, proxied: true, comment: null })]);
    expect((await cf.moveARecords("z", "serve.bd", OLD, NEW)).result).toBe("moved");
    expect(records).toEqual([expect.objectContaining({ id: "r1", content: NEW, proxied: true, comment: null })]);
  });

  it("leaves records that point anywhere else alone", async () => {
    const { cf, records } = fakeZone([
      record({ name: "serve.bd", content: "198.51.100.9" }),
      record({ id: "r2", name: "serve.bd", type: "CNAME", content: "elsewhere.example.net" }),
    ]);
    expect((await cf.moveARecords("z", "serve.bd", OLD, NEW)).result).toBe("untouched");
    expect(records.map((r) => r.content)).toEqual(["198.51.100.9", "elsewhere.example.net"]);
  });

  it("drops the old record when the new IP is already listed", async () => {
    const { cf, records } = fakeZone([record({ name: "serve.bd", content: OLD }), record({ id: "r2", name: "serve.bd", content: NEW })]);
    expect((await cf.moveARecords("z", "serve.bd", OLD, NEW)).result).toBe("moved");
    expect(records.map((r) => r.content)).toEqual([NEW]);
  });

  it("creates Serve's own record when the name has none", async () => {
    const { cf, records } = fakeZone([]);
    const moved = await cf.moveARecords("z", "serve.bd", OLD, NEW);
    expect(moved.result).toBe("created");
    expect(records).toEqual([expect.objectContaining({ type: "A", name: "serve.bd", content: NEW, comment: "Managed by Serve" })]);
  });
});
