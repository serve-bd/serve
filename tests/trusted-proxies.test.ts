import { describe, expect, it } from "vitest";
import { clientIpFrom, inRanges, normalizeTrustedRange, normalizeTrustedRanges, trustedProxiesSchema, type VisitorIp } from "@/lib/trusted-proxies";
import { realIpConfig, serverBlocks, tunnelRealIp } from "@/server/proxy/templates";
import { caddyMainConfig, renderCaddySite } from "@/server/proxy/caddy";
import { renderTraefikSite, traefikStaticArgs } from "@/server/proxy/traefik";
import type { SiteModel } from "@/server/proxy/model";

const TUNNEL = "172.30.0.0/24";
const off: VisitorIp = { tunnel: [TUNNEL], ranges: [], header: null };
const on = (header: VisitorIp["header"], ranges = ["203.0.113.0/24"]): VisitorIp => ({ tunnel: [TUNNEL], ranges, header });

describe("trusted proxy ranges", () => {
  it("normalizes addresses and ranges", () => {
    expect(normalizeTrustedRange("10.0.0.5")).toEqual({ range: "10.0.0.5/32" });
    expect(normalizeTrustedRange(" 10.1.2.3/8 ")).toEqual({ range: "10.0.0.0/8" });
    expect(normalizeTrustedRange("2001:DB8::1")).toEqual({ range: "2001:db8::1/128" });
    expect(normalizeTrustedRange("2001:db8:0:0:1::/64")).toEqual({ range: "2001:db8::/64" });
    expect(normalizeTrustedRange("2606:4700::/32")).toEqual({ range: "2606:4700::/32" });
    expect(normalizeTrustedRange("::ffff:192.0.2.1")).toEqual({ range: "::ffff:c000:201/128" });
  });

  it("refuses junk and ranges wide enough to fake any visitor", () => {
    for (const bad of ["example.com", "10.0.0.0/8; deny all", "1.2.3.256", "010.0.0.1", "10.0.0.0/33", "2001:db8::/129", "1::2::3", "10.0.0.1/", ""]) {
      expect(normalizeTrustedRange(bad)).toHaveProperty("error");
    }
    for (const wide of ["0.0.0.0/0", "::/0", "1.0.0.0/7", "2000::/15"]) {
      const r = normalizeTrustedRange(wide);
      expect(r).toHaveProperty("error");
      expect((r as { error: string }).error).toContain("Visitors could fake their IP");
    }
    expect(normalizeTrustedRange("10.0.0.0/8")).toEqual({ range: "10.0.0.0/8" });
    expect(normalizeTrustedRange("2001::/16")).toEqual({ range: "2001::/16" });
  });

  it("de-duplicates, skips blank lines and caps the list", () => {
    expect(normalizeTrustedRanges(["10.0.0.5", "", "10.0.0.5/32", "192.168.1.0/24"])).toEqual({ ranges: ["10.0.0.5/32", "192.168.1.0/24"] });
    const many = Array.from({ length: 101 }, (_, i) => `10.0.${i}.0/24`);
    expect(normalizeTrustedRanges(many)).toHaveProperty("error");
  });

  it("validates the saved setting", () => {
    expect(trustedProxiesSchema.parse({ ranges: ["10.0.0.5"], header: "x-forwarded-for", cloudflare: false })).toEqual({
      ranges: ["10.0.0.5/32"],
      header: "x-forwarded-for",
      cloudflare: false,
    });
    expect(trustedProxiesSchema.safeParse({ ranges: [], header: "x-forwarded-for", cloudflare: true }).success).toBe(true);
    expect(trustedProxiesSchema.safeParse({ ranges: [], header: "x-forwarded-for", cloudflare: false }).success).toBe(false);
    expect(trustedProxiesSchema.safeParse({ ranges: ["0.0.0.0/0"], header: "x-forwarded-for", cloudflare: false }).success).toBe(false);
    expect(trustedProxiesSchema.safeParse({ ranges: ["10.0.0.5"], header: "forwarded", cloudflare: false }).success).toBe(false);
  });

  it("matches addresses against ranges", () => {
    expect(inRanges("203.0.113.9", ["203.0.113.0/24"])).toBe(true);
    expect(inRanges("203.0.114.9", ["203.0.113.0/24"])).toBe(false);
    expect(inRanges("::ffff:203.0.113.9", ["203.0.113.0/24"])).toBe(true);
    expect(inRanges("2606:4700::1", ["2606:4700::/32"])).toBe(true);
    expect(inRanges("203.0.113.9", ["2606:4700::/32"])).toBe(false);
  });

  it("finds the visitor in X-Forwarded-For right to left", () => {
    const trusted = [TUNNEL, "10.0.0.0/8", "173.245.48.0/20"];
    // Direct visitor with a forged header: the proxy appended the real address.
    expect(clientIpFrom("1.1.1.1, 198.51.100.7", trusted)).toBe("198.51.100.7");
    // CDN → load balancer → proxy: both hops trusted, the visitor is left of them.
    expect(clientIpFrom("6.6.6.6, 198.51.100.7, 173.245.48.10, 10.0.0.5", trusted)).toBe("198.51.100.7");
    expect(clientIpFrom("198.51.100.7, 172.30.0.3", trusted)).toBe("198.51.100.7");
    expect(clientIpFrom("[2001:db8::7]:443, 10.0.0.5", trusted)).toBe("2001:db8::7");
    // Everything trusted: the left-most is the best guess.
    expect(clientIpFrom("10.0.0.9, 10.0.0.5", trusted)).toBe("10.0.0.9");
    // Garbage from the visitor stops the walk at the last hop that wrote a real address.
    expect(clientIpFrom("junk, 10.0.0.5", trusted)).toBe("10.0.0.5");
    expect(clientIpFrom("", trusted)).toBeNull();
  });
});

describe("nginx visitor IP config", () => {
  it("keeps the tunnel-only config byte for byte when off", () => {
    expect(realIpConfig(off)).toBe(`# Managed by Serve — visitor IPs for Cloudflare Tunnel traffic (only cloudflared shares this network with the proxy).
set_real_ip_from ${TUNNEL};
real_ip_header CF-Connecting-IP;
`);
    expect(realIpConfig({ tunnel: [], ranges: [], header: null })).toBeNull();
    expect(tunnelRealIp(off)).toBeNull();
  });

  it("trusts the ranges and reads X-Forwarded-For recursively when on", () => {
    const conf = realIpConfig(on("x-forwarded-for", ["203.0.113.0/24", "2606:4700::/32"]))!;
    expect(conf).toContain(`set_real_ip_from ${TUNNEL};\nset_real_ip_from 203.0.113.0/24;\nset_real_ip_from 2606:4700::/32;\n`);
    expect(conf).toContain("real_ip_header X-Forwarded-For;\nreal_ip_recursive on;\n");
    const realIp = realIpConfig(on("x-real-ip"))!;
    expect(realIp).toContain("real_ip_header X-Real-IP;");
    expect(realIp).not.toContain("real_ip_recursive");
  });

  it("keeps tunnel hosts on cloudflared's CF-Connecting-IP alone", () => {
    const override = tunnelRealIp(on("x-real-ip"))!;
    expect(override).toBe(`    set_real_ip_from ${TUNNEL};\n    real_ip_header CF-Connecting-IP;\n    real_ip_recursive off;`);
    const conf = serverBlocks({ hostname: "t.example.com", upstream: "u", forceHttps: false, realIp: override });
    expect(conf).toMatch(/listen 80;\n {4}server_name t\.example\.com;\n\n {4}set_real_ip_from 172\.30\.0\.0\/24;/);
    expect(serverBlocks({ hostname: "a.example.com", upstream: "u", forceHttps: false })).not.toContain("real_ip");
  });
});

describe("Caddy and Traefik visitor IP config", () => {
  const caddy = (visitor: VisitorIp) => caddyMainConfig({}, { email: null, staging: false, visitor });
  const site: SiteModel = {
    name: "svc-a",
    title: "a",
    serviceId: "a",
    stopped: false,
    upstreams: [{ key: "app-80", targets: ["app-1:80"] }],
    hosts: [{ hostname: "a.example.com", upstream: "app-80", redirectTo: null, https: false, forceHttps: false, tunnel: false, tls: null, allow: ["198.51.100.0/24"] }],
    options: null,
  };

  it("keeps today's Caddy options when off", () => {
    expect(caddy(off)).toContain(`trusted_proxies static ${TUNNEL}\n\t\tclient_ip_headers CF-Connecting-IP X-Forwarded-For\n`);
    expect(caddy({ tunnel: [], ranges: [], header: null })).not.toContain("trusted_proxies");
    expect(renderCaddySite(site)).not.toContain("X-Real-IP");
  });

  it("trusts the ranges in Caddy with the chosen header", () => {
    const xff = caddy(on("x-forwarded-for"));
    expect(xff).toContain(`trusted_proxies static ${TUNNEL} 203.0.113.0/24`);
    expect(xff).toContain("client_ip_headers X-Forwarded-For\n\t\ttrusted_proxies_strict");
    expect(caddy(on("cf-connecting-ip"))).toContain(`trusted_proxies static ${TUNNEL} 203.0.113.0/24\n\t\tclient_ip_headers CF-Connecting-IP\n`);
    // A visitor can send X-Real-IP through Cloudflare: the tunnel is not trusted for it.
    const realIp = caddy(on("x-real-ip"));
    expect(realIp).toContain("trusted_proxies static 203.0.113.0/24\n\t\tclient_ip_headers X-Real-IP\n");
    expect(realIp).not.toContain("trusted_proxies_strict");
    expect(renderCaddySite(site, undefined, true)).toContain("header_up X-Real-IP {client_ip}");
  });

  it("passes every trusted range to Traefik", () => {
    const args = traefikStaticArgs({}, { email: null, staging: false, trusted: [TUNNEL, "203.0.113.0/24"], hasDnsToken: false });
    expect(args).toContain(`--entrypoints.web.forwardedHeaders.trustedIPs=${TUNNEL},203.0.113.0/24`);
    expect(args).toContain(`--entrypoints.websecure.forwardedHeaders.trustedIPs=${TUNNEL},203.0.113.0/24`);
    const yml = renderTraefikSite(site, { resolver: false, trusted: [TUNNEL, "203.0.113.0/24"] });
    expect(yml).toMatch(/excludedIPs:\n\s+- 172\.30\.0\.0\/24\n\s+- 203\.0\.113\.0\/24/);
  });
});
