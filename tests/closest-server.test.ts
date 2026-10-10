import { describe, expect, it } from "vitest";
import { closestServerPlan } from "@/server/services/closest-server";

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
