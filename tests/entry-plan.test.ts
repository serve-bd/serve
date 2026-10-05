import { describe, expect, it } from "vitest";
import { type EntryDomain, type EntryServer, entryPlan, entryProblem, swappedExtras } from "@/server/services/entry-plan";

const server = (over: Partial<EntryServer> = {}): EntryServer => ({
  id: "n",
  name: "hel1",
  main: false,
  reachable: true,
  proxyKind: "nginx",
  proxyStopped: false,
  publicIp: "203.0.113.7",
  tunnels: [],
  deployed: true,
  ...over,
});

const domain = (over: Partial<EntryDomain> = {}): EntryDomain => ({
  id: "d1",
  hostname: "app.example.com",
  generated: false,
  tunnelId: null,
  tunnelAccountId: null,
  cloudflareAccountId: null,
  cloudflareZoneId: null,
  managedRecord: false,
  ...over,
});

describe("entryProblem", () => {
  it("accepts a server with a public IP, a running proxy and the current version", () => {
    expect(entryProblem(server())).toBeNull();
  });
  it("accepts a server reached only through a tunnel", () => {
    expect(entryProblem(server({ publicIp: null, tunnels: [{ id: "t", accountId: "a" }] }))).toBeNull();
  });
  it("refuses a server visitors cannot reach", () => {
    expect(entryProblem(server({ publicIp: null }))).toMatch(/no public IP and no Cloudflare Tunnel/);
  });
  it("refuses a server without a proxy, or with a stopped one", () => {
    expect(entryProblem(server({ proxyKind: "none" }))).toMatch(/No proxy runs/);
    expect(entryProblem(server({ proxyStopped: true }))).toMatch(/stopped/);
  });
  it("refuses an unreachable server and one that does not run the current version", () => {
    expect(entryProblem(server({ reachable: false }))).toMatch(/not reachable/);
    expect(entryProblem(server({ deployed: false }))).toMatch(/Deploy it first/);
  });
});

describe("entryPlan", () => {
  it("moves Serve's own A records and lists the user's own DNS", () => {
    const plan = entryPlan(server(), [
      domain({ id: "a", managedRecord: true, cloudflareZoneId: "z", cloudflareAccountId: "acc" }),
      domain({ id: "b", hostname: "www.example.com" }),
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.moves).toEqual([
      { domainId: "a", hostname: "app.example.com", kind: "record", ip: "203.0.113.7" },
      { domainId: "b", hostname: "www.example.com", kind: "manual", ip: "203.0.113.7" },
    ]);
  });

  it("moves the user's own record in a connected Cloudflare zone through the API", () => {
    const plan = entryPlan(server(), [domain({ id: "c", cloudflareZoneId: "z", cloudflareAccountId: "acc" })]);
    expect(plan.moves).toEqual([{ domainId: "c", hostname: "app.example.com", kind: "record", ip: "203.0.113.7" }]);
  });

  it("keeps a tunnel domain on a tunnel of the same Cloudflare account", () => {
    const plan = entryPlan(server({ tunnels: [{ id: "t2", accountId: "acc" }] }), [domain({ tunnelId: "t1", tunnelAccountId: "acc", cloudflareZoneId: "z" })]);
    expect(plan.moves).toEqual([{ domainId: "d1", hostname: "app.example.com", kind: "tunnel", tunnelId: "t2" }]);
  });

  it("turns a tunnel domain into an A record when the new server has no tunnel but a public IP", () => {
    const plan = entryPlan(server(), [domain({ tunnelId: "t1", tunnelAccountId: "acc", cloudflareAccountId: "acc", cloudflareZoneId: "z" })]);
    expect(plan.moves[0]).toMatchObject({ kind: "untunnel", ip: "203.0.113.7" });
  });

  it("blocks a tunnel domain the new server cannot carry", () => {
    const plan = entryPlan(server({ publicIp: null, tunnels: [{ id: "t2", accountId: "other" }] }), [domain({ tunnelId: "t1", tunnelAccountId: "acc", cloudflareZoneId: "z" })]);
    expect(plan.blockers).toHaveLength(1);
  });

  it("puts an IP domain on the tunnel when the new server has no public IP", () => {
    const plan = entryPlan(server({ publicIp: null, tunnels: [{ id: "t2", accountId: "acc" }] }), [
      domain({ cloudflareAccountId: "acc", cloudflareZoneId: "z", managedRecord: true }),
    ]);
    expect(plan.moves).toEqual([{ domainId: "d1", hostname: "app.example.com", kind: "tunnel", tunnelId: "t2" }]);
  });

  it("blocks domains outside Cloudflare, and wildcards, on a server with no public IP", () => {
    const target = server({ publicIp: null, tunnels: [{ id: "t2", accountId: "acc" }] });
    expect(entryPlan(target, [domain()]).blockers).toHaveLength(1);
    expect(entryPlan(target, [domain({ hostname: "*.example.com", cloudflareAccountId: "acc", cloudflareZoneId: "z" })]).blockers[0]).toMatch(/wildcard/);
  });

  it("renames generated domains", () => {
    expect(entryPlan(server({ publicIp: null, tunnels: [{ id: "t", accountId: "a" }] }), [domain({ generated: true })]).moves[0].kind).toBe("rename");
  });
});

describe("swappedExtras", () => {
  it("puts the old main server where the new one was", () => {
    expect(swappedExtras("p", "n", ["x", "n", "y"])).toEqual(["x", "p", "y"]);
  });
  it("leaves the list alone when the server is not an extra", () => {
    expect(swappedExtras("p", "n", ["x"])).toEqual(["x"]);
  });
});

describe("entryPlan with domains waiting for a tunnel", () => {
  it("connects them to the new server's tunnel, else they keep waiting", () => {
    const waiting = domain({ wantsTunnel: true, cloudflareAccountId: "acc", cloudflareZoneId: "z" });
    expect(entryPlan(server({ tunnels: [{ id: "t2", accountId: "acc" }] }), [waiting]).moves[0]).toMatchObject({ kind: "tunnel", tunnelId: "t2" });
    expect(entryPlan(server({ publicIp: null, tunnels: [] }), [waiting])).toEqual({ moves: [{ domainId: "d1", hostname: "app.example.com", kind: "keep" }], blockers: [] });
  });
});
