import { describe, expect, it } from "vitest";
import { closestServerPlan, restorePlan } from "@/server/services/closest-server";

// Which of an app's domains can go through its shared tunnel: names in the chosen account's zones.

const zones = [
  { id: "z1", name: "example.com" },
  { id: "z2", name: "eu.example.com" },
];
const d = (id: string, hostname: string, generated = false) => ({ id, hostname, generated });

describe("closestServerPlan", () => {
  it("moves names in the account's zones, picking the longest zone that holds each", () => {
    const plan = closestServerPlan([d("a", "example.com"), d("b", "app.example.com"), d("c", "shop.eu.example.com"), d("e", "App.Example.com")], zones);
    expect(plan.move).toEqual([
      { id: "a", hostname: "example.com", zoneId: "z1" },
      { id: "b", hostname: "app.example.com", zoneId: "z1" },
      { id: "c", hostname: "shop.eu.example.com", zoneId: "z2" },
      { id: "e", hostname: "App.Example.com", zoneId: "z1" },
    ]);
    expect(plan.stay).toEqual([]);
  });
  it("keeps generated names, wildcards and names outside the account on the main server", () => {
    const plan = closestServerPlan([d("g", "web.1.2.3.4.sslip.io", true), d("w", "*.example.com"), d("o", "other.org"), d("x", "notexample.com")], zones);
    expect(plan.move).toEqual([]);
    expect(plan.stay.map((s) => [s.id, s.reason])).toEqual([
      ["g", "a generated address of the main server"],
      ["w", "a wildcard, which cannot go through a tunnel"],
      ["o", "not in a zone of this Cloudflare account"],
      ["x", "not in a zone of this Cloudflare account"],
    ]);
  });
});

describe("restorePlan", () => {
  const was = (over: Partial<import("@/server/services/closest-server").DomainBefore>) => ({
    record: "a" as const,
    tunnelId: null,
    proxied: false,
    https: true,
    forceHttps: true,
    certificateId: "cert1",
    wantsTunnel: false,
    ...over,
  });
  const main = { name: "hetzner", publicIp: "2.29.57.162", tunnelIds: ["t-own"] };

  it("puts each domain back as it was: its tunnel, its A record (now to the main server) or no record", () => {
    const r = restorePlan(
      [d("a", "a.example.com"), d("t", "t.example.com"), d("n", "n.example.com")],
      {
        loadBalance: true,
        domains: {
          a: was({ proxied: false }),
          t: was({ record: "tunnel", tunnelId: "t-own", https: false, forceHttps: false }),
          n: was({ record: "none" }),
        },
      },
      main,
    );
    expect(r.blockers).toEqual([]);
    expect(r.fallback).toEqual([]);
    expect(r.moves.map((m) => [m.id, m.kind, "ip" in m ? m.ip : "tunnelId" in m ? m.tunnelId : null, m.before.proxied])).toEqual([
      ["a", "a", "2.29.57.162", false],
      ["t", "tunnel", "t-own", false],
      ["n", "none", null, false],
    ]);
  });

  it("routes the usual way what has nothing to go back to: added later, or its tunnel is gone", () => {
    const r = restorePlan([d("new", "new.example.com"), d("t", "t.example.com")], { loadBalance: null, domains: { t: was({ record: "tunnel", tunnelId: "t-gone" }) } }, main);
    expect(r.moves).toEqual([]);
    expect(r.fallback).toEqual(["new", "t"]);
    // Shared tunnels from before the setup was kept: everything the usual way.
    expect(restorePlan([d("x", "x.example.com")], null, main).fallback).toEqual(["x"]);
  });

  it("refuses to bring back an A record when the main server has no public IP", () => {
    const r = restorePlan([d("a", "a.example.com")], { loadBalance: null, domains: { a: was({}) } }, { ...main, publicIp: null });
    expect(r.blockers[0]).toMatch(/a\.example\.com had an A record, and hetzner has no public IP/);
  });
});
