import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { upstreamBlock } from "@/server/proxy/templates";
import { renderCaddySite } from "@/server/proxy/caddy";
import { renderTraefikSite } from "@/server/proxy/traefik";
import type { SiteModel } from "@/server/proxy/model";
import { buildProxyConfig, proxyInputSchema } from "@/server/services/proxy-config";

const site = (sticky: boolean, targets = ["app-1:3000", "app-2:3000"]): SiteModel => ({
  name: "svc-abc",
  title: "app",
  serviceId: "abc",
  stopped: false,
  upstreams: [{ key: "u", targets }],
  hosts: [{ hostname: "app.test", upstream: "u", redirectTo: null, https: false, forceHttps: false, tunnel: false, tls: null }],
  options: { ...buildProxyConfig(proxyInputSchema.parse({ sticky }), null) },
});

describe("sticky sessions", () => {
  it("is off unless asked for", () => {
    expect(buildProxyConfig(proxyInputSchema.parse({}), null).sticky).toBe(false);
  });

  it("nginx hashes the client IP only with more than one replica", () => {
    expect(upstreamBlock({ name: "u", servers: ["a:1", "b:1"], sticky: true })).toContain("hash $remote_addr consistent;");
    expect(upstreamBlock({ name: "u", servers: ["a:1", "b:1"] })).not.toContain("hash");
    expect(upstreamBlock({ name: "u", servers: ["a:1"], sticky: true })).not.toContain("hash");
  });

  it("Caddy uses the client IP hash", () => {
    expect(renderCaddySite(site(true))).toContain("lb_policy client_ip_hash");
    expect(renderCaddySite(site(false))).toContain("lb_policy round_robin");
    expect(renderCaddySite(site(true, ["app-1:3000"]))).toContain("lb_policy round_robin");
  });

  it("Traefik pins visitors with a cookie", () => {
    const lb = (s: SiteModel) => YAML.parse(renderTraefikSite(s, { resolver: false, trusted: [] })).http.services["svc-abc-u"].loadBalancer;
    expect(lb(site(true)).sticky).toEqual({ cookie: { name: "serve_svc_abc", httpOnly: true, sameSite: "lax" } });
    expect(lb(site(false)).sticky).toBeUndefined();
  });
});
