import { afterEach, describe, expect, it, vi } from "vitest";
import { domainDnsStatus } from "@/server/dns";

/** Public DNS answers these A records. */
const answer = (ips: string[]) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ Answer: ips.map((data) => ({ type: 1, data })) }))),
  );

afterEach(() => vi.unstubAllGlobals());

describe("domain DNS status", () => {
  const others = [{ name: "hetzner", ip: "203.0.113.20" }];

  it("is ok at the main server", async () => {
    answer(["203.0.113.10"]);
    expect((await domainDnsStatus("app.example.com", "203.0.113.10", { others })).status).toBe("ok");
  });

  it("names another server the app runs on", async () => {
    answer(["203.0.113.20"]);
    expect(await domainDnsStatus("app.example.com", "203.0.113.10", { others })).toMatchObject({ status: "other", server: "hetzner" });
  });

  it("is wrong anywhere else", async () => {
    answer(["198.51.100.7"]);
    expect((await domainDnsStatus("app.example.com", "203.0.113.10", { others })).status).toBe("wrong");
  });
});
