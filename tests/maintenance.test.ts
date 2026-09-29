import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { maintenanceHtml, maintenanceOf } from "@/server/services/maintenance";
import { maintenanceGeo, maintenanceVar, pagesServerConfig, serverBlocks } from "@/server/proxy/templates";
import { renderCaddySite } from "@/server/proxy/caddy";
import { renderTraefikSite } from "@/server/proxy/traefik";
import type { SiteModel } from "@/server/proxy/model";

const on = (allow: string[] = []) => ({ enabled: true, title: "Down", message: "Soon", allow, retryAfterMinutes: 5 });

function site(allow: string[] = []): SiteModel {
  return {
    name: "svc-abc",
    title: "service",
    serviceId: "abc",
    stopped: false,
    upstreams: [{ key: "app-3000", targets: ["web-1:3000"] }],
    hosts: [{ hostname: "app.example.com", upstream: "app-3000", redirectTo: null, https: true, forceHttps: true, tunnel: false, tls: null }],
    options: null,
    maintenance: maintenanceOf("abc", on(allow)),
  };
}

describe("maintenance mode", () => {
  it("is off without an enabled config and clamps Retry-After", () => {
    expect(maintenanceOf("abc", null)).toBeNull();
    expect(maintenanceOf("abc", { ...on(), enabled: false })).toBeNull();
    expect(maintenanceOf("abc", on(["10.0.0.0/8", "nope; deny all"]))).toEqual({ page: "maintenance-abc.html", retryAfter: 300, allow: ["10.0.0.0/8"] });
  });

  it("escapes the page text", () => {
    const html = maintenanceHtml({ title: "<script>x</script>", message: "Line one\n\nA & B" });
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<p>A &amp; B</p>");
  });

  it("nginx answers 503 with the page and Retry-After", () => {
    const conf = serverBlocks({ hostname: "app.example.com", upstream: "up", forceHttps: false, maintenance: maintenanceOf("abc", on()) });
    expect(conf).toContain("return 503;");
    expect(conf).toContain("error_page 503 /__serve_maintenance.html;");
    expect(conf).toContain("add_header Retry-After 300 always;");
    expect(conf).toContain("try_files /maintenance-abc.html =503;");
    expect(conf).not.toContain("proxy_pass");
  });

  it("nginx lets the allow list through with a geo variable", () => {
    const m = maintenanceOf("abc", on(["203.0.113.7"]))!;
    const variable = maintenanceVar("abc");
    const conf = serverBlocks({ hostname: "app.example.com", upstream: "up", forceHttps: false, maintenance: { ...m, geoVar: variable } });
    expect(conf).toContain(`if ($${variable} = 0) {`);
    expect(conf).toContain("proxy_pass http://up;");
    expect(maintenanceGeo(variable, m.allow)).toBe(`geo $${variable} {\n    default 0;\n    203.0.113.7 1;\n}\n`);
  });

  it("nginx keeps redirects", () => {
    const conf = serverBlocks({ hostname: "www.example.com", upstream: null, redirectTo: "https://example.com", forceHttps: false, maintenance: maintenanceOf("abc", on()) });
    expect(conf).toContain("return 308 https://example.com$request_uri;");
    expect(conf).not.toContain("__serve_maintenance");
  });

  it("Caddy serves the page with a 503 before proxying", () => {
    const conf = renderCaddySite(site(["203.0.113.7"]));
    expect(conf).toContain("@serve_maintenance not client_ip 203.0.113.7");
    expect(conf).toContain("rewrite * /maintenance-abc.html");
    expect(conf).toContain("status 503");
    expect(conf).toContain('header Retry-After "300"');
    expect(conf.indexOf("handle @serve_maintenance")).toBeLessThan(conf.indexOf("reverse_proxy"));
    expect(renderCaddySite(site())).toContain("@serve_maintenance path *");
  });

  it("Traefik routes to the pages server, and the allow list to the app", () => {
    const doc = YAML.parse(
      renderTraefikSite(site(["203.0.113.7"]), { resolver: true, trusted: [] })
        .split("\n")
        .slice(1)
        .join("\n"),
    );
    const routers = doc.http.routers as Record<string, { rule: string; service: string; middlewares?: string[] }>;
    expect(routers["svc-abc-0-secure"].service).toBe("serve-pages");
    expect(routers["svc-abc-0-secure"].middlewares).toContain("svc-abc-maintenance");
    expect(doc.http.middlewares["svc-abc-maintenance"].replacePath.path).toBe("/__maintenance/abc");
    expect(doc.http.middlewares["svc-abc-maintenance-headers"].headers.customResponseHeaders["Retry-After"]).toBe("300");
    expect(routers["svc-abc-0-secure-allowed"].service).toBe("svc-abc-app-3000");
    expect(routers["svc-abc-0-secure-allowed"].rule).toContain("ClientIP(`203.0.113.7`)");
    expect(pagesServerConfig).toContain('location ~ "^/__maintenance/([A-Za-z0-9_-]+)$"');
  });
});
