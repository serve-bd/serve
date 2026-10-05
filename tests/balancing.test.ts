import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { upstreamBlock } from "@/server/proxy/templates";
import { renderCaddySite } from "@/server/proxy/caddy";
import { renderTraefikSite } from "@/server/proxy/traefik";
import type { SiteModel } from "@/server/proxy/model";
import { type Balancing, balancingOf, buildProxyConfig, proxyInputSchema } from "@/server/services/proxy-config";
import { localTargets, nextMain } from "@/server/services/balance-rules";

const site = (balancing: Balancing, targets = ["app-1:3000", "app-2:3000"]): SiteModel => ({
  name: "svc-abc",
  title: "app",
  serviceId: "abc",
  stopped: false,
  upstreams: [{ key: "u", targets }],
  hosts: [{ hostname: "app.test", upstream: "u", redirectTo: null, https: false, forceHttps: false, tunnel: false, tls: null }],
  options: { ...buildProxyConfig(proxyInputSchema.parse({ balancing }), null) },
});

describe("balancing strategy", () => {
  it("is round robin unless asked for", () => {
    expect(buildProxyConfig(proxyInputSchema.parse({}), null).balancing).toBe("round-robin");
  });

  it("reads configs saved with the old sticky flag", () => {
    expect(balancingOf({ sticky: true })).toBe("sticky");
    expect(balancingOf({ sticky: false })).toBe("round-robin");
    expect(balancingOf(null)).toBe("round-robin");
    expect(balancingOf({ sticky: true, balancing: "least-busy" })).toBe("least-busy");
  });

  it("takes the old sticky flag from API callers, and keeps the saved strategy when neither is sent", () => {
    expect(buildProxyConfig(proxyInputSchema.parse({ sticky: true }), null).balancing).toBe("sticky");
    expect(buildProxyConfig(proxyInputSchema.parse({ sticky: false }), { balancing: "least-busy" }).balancing).toBe("round-robin");
    expect(buildProxyConfig(proxyInputSchema.parse({}), { balancing: "least-busy" }).balancing).toBe("least-busy");
    expect(buildProxyConfig(proxyInputSchema.parse({}), { sticky: true }).balancing).toBe("sticky");
    expect(() => proxyInputSchema.parse({ balancing: "random" })).toThrow();
  });

  it("nginx: hash for sticky, least_conn for least busy, only with more than one replica", () => {
    expect(upstreamBlock({ name: "u", servers: ["a:1", "b:1"], balancing: "sticky" })).toContain("hash $remote_addr consistent;");
    expect(upstreamBlock({ name: "u", servers: ["a:1", "b:1"], balancing: "least-busy" })).toContain("least_conn;");
    expect(upstreamBlock({ name: "u", servers: ["a:1", "b:1"] })).not.toMatch(/hash|least_conn/);
    expect(upstreamBlock({ name: "u", servers: ["a:1"], balancing: "sticky" })).not.toContain("hash");
    expect(upstreamBlock({ name: "u", servers: ["a:1"], balancing: "least-busy" })).not.toContain("least_conn");
  });

  it("Caddy: client IP hash, least_conn or round robin", () => {
    expect(renderCaddySite(site("sticky"))).toContain("lb_policy client_ip_hash");
    expect(renderCaddySite(site("least-busy"))).toContain("lb_policy least_conn");
    expect(renderCaddySite(site("round-robin"))).toContain("lb_policy round_robin");
    expect(renderCaddySite(site("main-first"))).toContain("lb_policy round_robin");
    expect(renderCaddySite(site("sticky", ["app-1:3000"]))).toContain("lb_policy round_robin");
  });

  it("Traefik: a cookie for sticky, p2c for least busy", () => {
    const lb = (s: SiteModel) => YAML.parse(renderTraefikSite(s, { resolver: false, trusted: [] })).http.services["svc-abc-u"].loadBalancer;
    expect(lb(site("sticky")).sticky).toEqual({ cookie: { name: "serve_svc_abc", httpOnly: true, sameSite: "lax" } });
    expect(lb(site("round-robin")).sticky).toBeUndefined();
    expect(lb(site("least-busy")).strategy).toBe("p2c");
    expect(lb(site("least-busy")).sticky).toBeUndefined();
    expect(lb(site("round-robin")).strategy).toBeUndefined();
    expect(lb(site("least-busy", ["app-1:3000"])).strategy).toBeUndefined();
  });
});

describe("main server first", () => {
  const svc = (balancing: Balancing, mainOk?: boolean) => ({
    proxy: { balancing },
    balance: mainOk === undefined ? null : { copies: {}, main: { ok: mainOk, since: "", error: null } },
  });

  it("keeps the main server's replicas while they answer", () => {
    expect(localTargets(svc("main-first"), ["a", "b"], 0)).toEqual(["a", "b"]);
    expect(localTargets(svc("main-first", true), ["a", "b"], 2)).toEqual(["a", "b"]);
  });

  it("drops them for the other servers when none answers", () => {
    expect(localTargets(svc("main-first", false), ["a", "b"], 2)).toEqual([]);
  });

  it("keeps them when there is nothing else to send visitors to", () => {
    expect(localTargets(svc("main-first", false), ["a", "b"], 0)).toEqual(["a", "b"]);
  });

  it("other strategies never drop them", () => {
    expect(localTargets(svc("round-robin", false), ["a"], 2)).toEqual(["a"]);
  });

  it("saves only changes of the main server's health", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(nextMain(null, true, null, now)).toBeNull();
    const down = nextMain({ copies: { "s:1": { ok: true, since: "", error: null } } }, false, "/ answered 500.", now);
    expect(down).toEqual({ copies: { "s:1": { ok: true, since: "", error: null } }, main: { ok: false, since: now.toISOString(), error: "/ answered 500." } });
    expect(nextMain(down, false, "other", now)).toBeNull();
    expect(nextMain(down, true, null, now)?.main).toEqual({ ok: true, since: now.toISOString(), error: null });
  });
});
