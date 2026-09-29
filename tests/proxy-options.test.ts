import { describe, expect, it } from "vitest";
import { apr1, buildProxyConfig, isCidr, proxyInputSchema } from "@/server/services/proxy-config";
import { serverBlocks } from "@/server/proxy/templates";

const parse = (input: unknown) => proxyInputSchema.safeParse(input);

describe("proxy options validation", () => {
  it("accepts IPs and CIDRs, rejects junk", () => {
    expect(isCidr("203.0.113.0/24")).toBe(true);
    expect(isCidr("2001:db8::/32")).toBe(true);
    expect(isCidr("10.0.0.1")).toBe(true);
    expect(isCidr("10.0.0.0/33")).toBe(false);
    expect(isCidr("10.0.0.0/8; deny all")).toBe(false);
    expect(isCidr("example.com")).toBe(false);
  });
  it("rejects header values that could break out of the directive", () => {
    expect(parse({ headers: [{ name: "X-A", value: "ok value" }] }).success).toBe(true);
    for (const value of ['a" always; include /etc/passwd', "a\nb", "$host", "a\\b"]) {
      expect(parse({ headers: [{ name: "X-A", value }] }).success).toBe(false);
    }
    expect(parse({ headers: [{ name: "X A;", value: "x" }] }).success).toBe(false);
    expect(parse({ headers: [{ name: "Content-Length", value: "1" }] }).success).toBe(false);
  });
  it("validates sizes, origins and custom directives", () => {
    expect(parse({ maxBodySize: "512m" }).success).toBe(true);
    expect(parse({ maxBodySize: "10m; gzip off" }).success).toBe(false);
    expect(parse({ corsOrigins: ["https://app.example.com", "*"] }).success).toBe(true);
    expect(parse({ corsOrigins: ["javascript:alert(1)"] }).success).toBe(false);
    expect(parse({ customDirectives: "} server { listen 1;" }).success).toBe(false);
    expect(parse({ customDirectives: "if ($x) { return 403; }" }).success).toBe(true);
  });
  it("keeps the saved password when none is sent", () => {
    const first = buildProxyConfig(proxyInputSchema.parse({ basicAuth: { enabled: true, username: "a", password: "secret123" } }), null);
    const again = buildProxyConfig(proxyInputSchema.parse({ basicAuth: { enabled: true, username: "a" } }), first);
    expect(again.basicAuth?.passwordHash).toBe(first.basicAuth?.passwordHash);
    expect(() => buildProxyConfig(proxyInputSchema.parse({ basicAuth: { enabled: true, username: "b" } }), first)).toThrow(/password/);
  });
  it("hashes like htpasswd -m", () => {
    expect(apr1("secret123", "abcdefgh")).toBe("$apr1$abcdefgh$aQ26yFH6V5G5PJBY/utXg/");
  });
});

describe("proxy options rendering", () => {
  const base = { hostname: "app.example.com", upstream: "up", forceHttps: false };
  it("puts auth in the app location, not on the ACME challenge", () => {
    const out = serverBlocks({ ...base, options: { authFile: "/etc/nginx/serve/sites/auth/x.htpasswd" } });
    const acme = out.slice(out.indexOf("acme-challenge"), out.indexOf("location / {"));
    expect(acme).not.toContain("auth_basic");
    expect(out).toContain("auth_basic_user_file /etc/nginx/serve/sites/auth/x.htpasswd;");
  });
  it("orders deny before allow and keeps ACME reachable", () => {
    const out = serverBlocks({ ...base, options: { deny: ["198.51.100.0/24"], allow: ["10.0.0.0/8"] } });
    expect(out.indexOf("deny 198.51.100.0/24;")).toBeLessThan(out.indexOf("allow 10.0.0.0/8;"));
    expect(out).toContain("deny all;");
    expect(out).toMatch(/acme-challenge\/ \{\n\s+allow all;/);
  });
  it("emits HSTS once per TLS block", () => {
    const tls = { cert: "/c.pem", key: "/k.pem" };
    for (const options of [null, { headers: [{ name: "X-A", value: "1" }] }]) {
      const out = serverBlocks({ ...base, tls, options });
      const httpsBlock = out.slice(out.indexOf("listen 443"));
      expect(httpsBlock.match(/Strict-Transport-Security/g)?.length).toBe(1);
    }
  });
  it("renders timeouts, buffering, body size and plain params", () => {
    const out = serverBlocks({ ...base, options: { readTimeout: 600, buffering: false, maxBodySize: "1g", websockets: false } });
    expect(out).toContain("proxy_read_timeout 600s;");
    expect(out).toContain("proxy_buffering off;");
    expect(out).toContain("client_max_body_size 1g;");
    expect(out).toContain("/etc/nginx/serve/sites/params/plain.conf");
  });
  it("escapes CORS origins in the match", () => {
    const out = serverBlocks({ ...base, options: { corsOrigins: ["https://a.example.com"] } });
    expect(out).toContain('"^(https://a\\.example\\.com)$"');
  });
});
