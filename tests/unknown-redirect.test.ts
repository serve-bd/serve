import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { redirectUrlError, safeRedirectUrl } from "@/lib/unknown-redirect";
import { defaultsOf, nginxSettingsSchema, proxyDefaultsSchema } from "@/server/proxy/config";
import { mainConfig } from "@/server/proxy/templates";
import { caddyMainConfig } from "@/server/proxy/caddy";
import { traefikBaseDynamic } from "@/server/proxy/traefik";

const TARGET = "https://www.example.com/landing?from=serve#top";
const on = (unknownRedirect: string | null, catchAll = true) => ({ catchAll, unknownRedirect, unavailablePage: true, httpsRedirect: true });
const visitor = { header: null, ranges: [], tunnel: [] } as never;

describe("unknown host redirect URL", () => {
  it("accepts absolute http(s) URLs", () => {
    for (const v of ["https://example.com", "http://example.com:8080/a/b?c=d&e=f", TARGET, "https://[2001:db8::1]/", "https://example.com/%20x"]) {
      expect(redirectUrlError(v), v).toBeNull();
    }
  });
  it("rejects relative, other schemes, credentials and characters that could break config", () => {
    for (const v of [
      "",
      "example.com",
      "/path",
      "ftp://example.com",
      "javascript:alert(1)",
      "http:///example.com",
      "https://user:pass@example.com",
      'https://example.com/"; return 200 "x',
      "https://example.com/$host",
      "https://example.com/;",
      "https://example.com/{path}",
      "https://example.com/\\",
      "https://example.com/'",
      "https://example.com/a b",
      "https://example.com/\n",
      "https://example.com/\u0000",
      "https://example.com/`",
      `https://example.com/${"a".repeat(2048)}`,
    ]) {
      expect(redirectUrlError(v), JSON.stringify(v)).not.toBeNull();
    }
    expect(safeRedirectUrl("https://example.com/$x")).toBeNull();
  });
  it("schema trims, stores empty as null and reports errors", () => {
    expect(proxyDefaultsSchema.parse({ catchAll: true, unknownRedirect: "  https://example.com  " }).unknownRedirect).toBe("https://example.com");
    expect(proxyDefaultsSchema.parse({ catchAll: true, unknownRedirect: "" }).unknownRedirect).toBeNull();
    expect(proxyDefaultsSchema.parse({ catchAll: true }).unknownRedirect).toBeUndefined();
    expect(proxyDefaultsSchema.safeParse({ unknownRedirect: "https://x.com/$host" }).success).toBe(false);
    expect(nginxSettingsSchema.safeParse({ defaults: { unknownRedirect: "not a url" } }).success).toBe(false);
  });
  it("stored configs without the field keep today's behaviour", () => {
    expect(defaultsOf(undefined)).toEqual(on(null));
    expect(defaultsOf({ catchAll: false })).toEqual(on(null, false));
    expect(defaultsOf({ unknownRedirect: "https://x.com/$bad" }).unknownRedirect).toBeNull();
  });
});

describe("nginx default server", () => {
  const base = { maxBodySize: "100m" };
  it("returns 302 to the TARGET and keeps ACME and the health check", () => {
    const conf = mainConfig({ ...base, catchAll: true, unknownRedirect: TARGET });
    expect(conf).toContain(`return 302 "${TARGET}";`);
    expect(conf).not.toMatch(/location \/ \{\s*return 404;/);
    expect(conf).toContain("location ^~ /.well-known/acme-challenge/");
    expect(conf).toMatch(/location = \/__serve\/health \{\s*access_log off;\s*return 200 "ok";/);
    expect(conf).toContain("ssl_reject_handshake on;");
  });
  it("is unchanged without a TARGET or with the catch-all off", () => {
    expect(mainConfig({ ...base, catchAll: true, unknownRedirect: null })).toBe(mainConfig({ ...base, catchAll: true }));
    expect(mainConfig({ ...base, catchAll: true })).toMatch(/location \/ \{\s*return 404;/);
    expect(mainConfig({ ...base, catchAll: false, unknownRedirect: TARGET })).not.toContain("return 302");
  });
  it("never writes an unsafe TARGET", () => {
    expect(mainConfig({ ...base, catchAll: true, unknownRedirect: 'https://x.com/"; include /etc/passwd; "' })).not.toContain("passwd");
  });
});

describe("Caddy catch-all", () => {
  it("redirects unknown hosts and keeps the health check", () => {
    const conf = caddyMainConfig({}, { email: null, staging: false, visitor, defaults: on(TARGET) });
    expect(conf).toContain(`redir "${TARGET}" 302`);
    expect(conf).toMatch(/handle \/__serve\/health \{\s*respond "ok" 200/);
    expect(conf).not.toMatch(/handle \{\s*error 404/);
  });
  it("is unchanged without a TARGET", () => {
    expect(caddyMainConfig({}, { email: null, staging: false, visitor, defaults: on(null) })).toMatch(/handle \{\s*error 404/);
    expect(caddyMainConfig({}, { email: null, staging: false, visitor, defaults: on(TARGET, false) })).not.toContain("redir");
    expect(caddyMainConfig({}, { email: null, staging: false, visitor, defaults: on("https://x.com/{env.X}") })).not.toContain("redir");
  });
});

describe("Traefik catch-all", () => {
  const dyn = (d: ReturnType<typeof on>) =>
    YAML.parse(traefikBaseDynamic({ pagesUrl: "http://pages:80", resolver: false, dashboard: null, defaults: d })).http as {
      routers?: Record<string, { service: string; middlewares?: string[]; priority?: number }>;
      middlewares: Record<string, { redirectRegex?: { regex: string; replacement: string; permanent: boolean } }>;
    };
  it("routes unknown hosts through a 302 redirect middleware", () => {
    const http = dyn(on(TARGET));
    for (const r of ["serve-catchall-web", "serve-catchall-secure"]) {
      expect(http.routers?.[r]).toMatchObject({ service: "noop@internal", middlewares: ["serve-unknown-redirect"], priority: 1 });
    }
    expect(http.middlewares["serve-unknown-redirect"].redirectRegex).toEqual({ regex: "^.*$", replacement: TARGET, permanent: false });
  });
  it("is unchanged without a TARGET or with the catch-all off", () => {
    const page = dyn(on(null));
    expect(page.routers?.["serve-catchall-web"]).toEqual({ rule: "PathPrefix(`/`)", priority: 1, entryPoints: ["web"], service: "serve-pages" });
    expect(page.middlewares["serve-unknown-redirect"]).toBeUndefined();
    const off = dyn(on(TARGET, false));
    expect(off.routers).toBeUndefined();
    expect(off.middlewares["serve-unknown-redirect"]).toBeUndefined();
  });
});
