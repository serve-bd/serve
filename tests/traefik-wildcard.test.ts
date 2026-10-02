import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { renderTraefikSite } from "@/server/proxy/traefik";
import type { SiteModel } from "@/server/proxy/model";

const site: SiteModel = {
  name: "svc-abc",
  title: "app",
  serviceId: "abc",
  stopped: false,
  upstreams: [{ key: "u", targets: ["app-1:3000"] }],
  hosts: [{ hostname: "*.apps.example.com", upstream: "u", redirectTo: null, https: false, forceHttps: false, tunnel: false, tls: null }],
  options: null,
};

describe("Traefik wildcard hosts", () => {
  it("match one label under the domain", () => {
    const rule: string = YAML.parse(renderTraefikSite(site, { resolver: false, trusted: [] })).http.routers["svc-abc-0-web"].rule;
    // Traefik's backtick strings are raw: the regular expression is what sits between them.
    const regex = new RegExp(/^HostRegexp\(`(.*)`\)$/.exec(rule)![1]);
    expect(regex.test("a.apps.example.com")).toBe(true);
    expect(regex.test("a.b.apps.example.com")).toBe(false);
    expect(regex.test("a.appsXexample.com")).toBe(false);
  });
});
