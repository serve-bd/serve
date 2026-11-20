import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { renderTraefikSite, traefikBaseDynamic } from "@/server/proxy/traefik";
import type { ProxyDefaults } from "@/server/proxy/config";
import type { SiteModel } from "@/server/proxy/model";
import { maintenanceOf } from "@/server/services/maintenance";

const site = (more: Partial<SiteModel> = {}): SiteModel => ({
  name: "svc-abc",
  title: "app",
  serviceId: "abc",
  stopped: false,
  upstreams: [{ key: "u", targets: ["app-1:3000"] }],
  hosts: [{ hostname: "app.example.com", upstream: "u", redirectTo: null, https: false, forceHttps: false, tunnel: false, tls: null }],
  options: null,
  ...more,
});

type Router = { rule: string; middlewares?: string[]; priority?: number };
const pageOn: Required<ProxyDefaults> = { catchAll: true, unknownRedirect: null, unavailablePage: true, httpsRedirect: true };
const routersOf = (s: SiteModel, opts: { trusted?: string[]; defaults?: Required<ProxyDefaults> } = {}) =>
  YAML.parse(renderTraefikSite(s, { resolver: false, trusted: opts.trusted ?? [], defaults: opts.defaults })).http.routers as Record<string, Router>;
const host = "Host(`app.example.com`)";
const html = "HeaderRegexp(`Accept`, `(?i)text/html`)";

describe("Traefik unavailable page", () => {
  it("covers the codes Traefik answers with when it cannot reach an app", () => {
    const base = YAML.parse(traefikBaseDynamic({ pagesUrl: "http://pages", resolver: false, dashboard: undefined, defaults: pageOn }));
    expect(base.http.middlewares["serve-errors"].errors.status).toEqual(["502-504"]);
  });

  it("goes to browsers only, so other clients get the app's own errors", () => {
    const routers = routersOf(site());
    expect(routers["svc-abc-0-web"]).toEqual({ rule: `${host} && !${html}`, entryPoints: ["web"], service: "svc-abc-u", middlewares: ["svc-abc-compress"], priority: host.length });
    expect(routers["svc-abc-0-web-html"]).toEqual({
      rule: `${host} && ${html}`,
      entryPoints: ["web"],
      service: "svc-abc-u",
      middlewares: ["serve-errors", "svc-abc-compress"],
      priority: host.length,
    });
  });

  it("leaves the router as it was when the page is off", () => {
    const routers = routersOf(site(), { defaults: { ...pageOn, unavailablePage: false } });
    expect(routers).toEqual({ "svc-abc-0-web": { rule: host, entryPoints: ["web"], service: "svc-abc-u", middlewares: ["svc-abc-compress"] } });
  });

  it("keeps the rank of each plain rule", () => {
    const dashboard = routersOf(site({ name: "_dashboard" }));
    expect(dashboard["_dashboard-0-web"].priority).toBe(100_000 + host.length);
    expect(dashboard["_dashboard-0-web-html"].priority).toBe(100_000 + host.length);

    const cached = routersOf(site({ options: { cacheStatic: true } }));
    const staticRule = cached["svc-abc-0-web-static"].rule.replace(` && !${html}`, "");
    expect(staticRule.length).toBeGreaterThan(host.length);
    expect(cached["svc-abc-0-web-static"].priority).toBe(staticRule.length);
    expect(cached["svc-abc-0-web-static-html"].priority).toBe(staticRule.length);

    const maintenance = maintenanceOf("abc", { enabled: true, title: "Down", message: "Soon", allow: ["203.0.113.7"], retryAfterMinutes: 5 });
    const down = routersOf(site({ maintenance }));
    const allowRule = `${host} && (ClientIP(\`203.0.113.7\`))`;
    expect(down["svc-abc-0-web-allowed"]).toMatchObject({ rule: `${allowRule} && !${html}`, priority: allowRule.length });
    expect(down["svc-abc-0-web-allowed-html"]).toMatchObject({ rule: `${allowRule} && ${html}`, priority: allowRule.length });
    expect(down["svc-abc-0-web"]).toEqual({ rule: host, entryPoints: ["web"], service: "serve-pages", middlewares: ["svc-abc-maintenance-headers", "svc-abc-maintenance"] });
  });

  it("splits by visitor too behind trusted proxies", () => {
    const routers = routersOf(site({ options: { allow: ["198.51.100.0/24"] } }), { trusted: ["10.0.0.0/8"] });
    expect(Object.keys(routers).sort()).toEqual(["svc-abc-0-web", "svc-abc-0-web-html", "svc-abc-0-web-html-proxied", "svc-abc-0-web-proxied"]);
    expect(routers["svc-abc-0-web"].middlewares).toEqual(["svc-abc-allow-direct", "svc-abc-compress"]);
    expect(routers["svc-abc-0-web-proxied"].middlewares).toEqual(["svc-abc-allow", "svc-abc-compress"]);
    expect(routers["svc-abc-0-web-html"].middlewares).toEqual(["serve-errors", "svc-abc-allow-direct", "svc-abc-compress"]);
    expect(routers["svc-abc-0-web-html-proxied"].middlewares).toEqual(["serve-errors", "svc-abc-allow", "svc-abc-compress"]);
    for (const r of Object.values(routers)) expect(r.priority).toBe(host.length);
  });

  it("keeps one router with extra middlewares, which count per router", () => {
    const routers = routersOf(site({ options: { traefikMiddlewares: "rl:\n  rateLimit:\n    average: 10\n" } }));
    expect(Object.keys(routers)).toEqual(["svc-abc-0-web"]);
    expect(routers["svc-abc-0-web"].middlewares).toEqual(["serve-errors", "svc-abc-compress", "svc-abc-x-rl"]);
  });

});
