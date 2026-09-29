import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { certificateCovers } from "@/server/ssl/match";
import { parseEnv } from "@/lib/env";
import { explainCertError } from "@/lib/cert-errors";
import { isCloudflareIp } from "@/server/dns";
import { composeServiceNames, composeServicePorts, transformCompose } from "@/server/deploy/compose";
import { serverBlocks, upstreamBlock } from "@/server/proxy/templates";
import { slugify } from "@/server/id";
import { engines } from "@/server/databases/engines";

describe("certificateCovers", () => {
  it("matches exact names", () => {
    expect(certificateCovers(["example.com"], "example.com")).toBe(true);
    expect(certificateCovers(["example.com"], "www.example.com")).toBe(false);
  });
  it("matches one wildcard level only", () => {
    expect(certificateCovers(["*.example.com"], "app.example.com")).toBe(true);
    expect(certificateCovers(["*.example.com"], "a.b.example.com")).toBe(false);
    expect(certificateCovers(["*.example.com"], "example.com")).toBe(false);
  });
  it("is case insensitive", () => {
    expect(certificateCovers(["*.Example.COM"], "API.example.com")).toBe(true);
  });
});

describe("parseEnv", () => {
  it("parses quotes, comments and export", () => {
    const vars = parseEnv(`# comment
export A=1
B="hello world"
C='single $x'
D="line\\nbreak"
INVALID
E=`);
    expect(vars).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "hello world" },
      { key: "C", value: "single $x" },
      { key: "D", value: "line\nbreak" },
      { key: "E", value: "" },
    ]);
  });
});

describe("isCloudflareIp", () => {
  it("detects Cloudflare edge addresses", () => {
    expect(isCloudflareIp("104.16.1.1")).toBe(true);
    expect(isCloudflareIp("172.67.10.10")).toBe(true);
    expect(isCloudflareIp("8.8.8.8")).toBe(false);
  });
});

describe("compose", () => {
  const file = `services:
  web:
    image: nginx
    ports: ["8080:80"]
    networks: [front]
  db:
    image: postgres
    expose: ["5432"]
  host:
    image: busybox
    network_mode: host
networks:
  front: {}
`;
  it("lists services and ports", () => {
    expect(composeServiceNames(file)).toEqual(["web", "db", "host"]);
    expect(composeServicePorts(file)).toMatchObject({ web: [80], db: [5432] });
  });
  it("attaches services to the shared network with aliases and labels", () => {
    const out = YAML.parse(transformCompose(file, "shop-ab12cd", "svc1", "10.210.3.0/24"));
    expect(out.services.web.networks).toMatchObject({ front: null, serve: { aliases: ["shop-ab12cd-web"] } });
    expect(out.services.db.networks.serve.aliases).toEqual(["shop-ab12cd-db"]);
    expect(out.services.db.networks.default).toBeNull();
    expect(out.services.host.networks).toBeUndefined();
    expect(out.services.web.labels["serve.service"]).toBe("svc1");
    expect(out.networks.serve).toEqual({ external: true, name: "serve" });
    expect(out.networks.default.ipam.config[0].subnet).toBe("10.210.3.0/24");
  });
  it("rejects files without services", () => {
    expect(() => transformCompose("version: '3'", "x", "y")).toThrow();
  });
});

describe("nginx templates", () => {
  it("renders a placeholder upstream when nothing runs", () => {
    expect(upstreamBlock({ name: "u", servers: [] })).toContain("127.0.0.1:1 down");
    expect(upstreamBlock({ name: "u", servers: ["app-1:3000"] })).toContain("server app-1:3000 resolve");
  });
  it("redirects http to https when a certificate exists", () => {
    const conf = serverBlocks({ hostname: "a.com", upstream: "u", forceHttps: true, tls: { cert: "/c.pem", key: "/k.pem" } });
    expect(conf).toContain("return 301 https://$host$request_uri");
    expect(conf).toContain("listen 443 ssl");
    expect(conf).toContain("ssl_certificate /c.pem");
  });
  it("serves over http without a certificate and keeps acme challenges", () => {
    const conf = serverBlocks({ hostname: "a.com", upstream: "u", forceHttps: true, tls: null });
    expect(conf).not.toContain("listen 443");
    expect(conf).toContain("proxy_pass http://u");
    expect(conf).toContain("/.well-known/acme-challenge/");
  });
  it("returns 503 for services without a target", () => {
    expect(serverBlocks({ hostname: "a.com", upstream: null, forceHttps: false })).toContain("return 503");
  });
});

describe("helpers", () => {
  it("slugifies names for docker", () => {
    expect(slugify("My Cool App!")).toBe("my-cool-app");
    expect(slugify("---")).toBe("app");
  });
  it("builds database URLs with escaped credentials", () => {
    const url = engines.postgres.url({ username: "u", password: "p@ss/word", database: "db", host: "h", port: 5432 });
    expect(url).toBe("postgresql://u:p%40ss%2Fword@h:5432/db");
  });
});

import { composeSecurityIssues, containedPath, safeRedirectUrl } from "@/server/security";

describe("security", () => {
  it("rejects redirect URLs that could inject nginx config", () => {
    expect(safeRedirectUrl("https://www.example.com/path?x=1")).toBe("https://www.example.com/path?x=1");
    expect(() => safeRedirectUrl("https://a.com/x; } location /k { alias /etc/; }")).toThrow();
    expect(() => safeRedirectUrl("https://a.com/$host")).toThrow();
    expect(() => safeRedirectUrl("javascript:alert(1)")).toThrow();
  });
  it("keeps paths inside the base directory", () => {
    expect(containedPath("/repo", "docker/compose.yml")).toBe("/repo/docker/compose.yml");
    expect(containedPath("/repo", "/apps/web")).toBe("/repo/apps/web");
    expect(() => containedPath("/repo", "../../etc/passwd")).toThrow();
  });
  it("flags compose options that escape the sandbox", () => {
    const issues = composeSecurityIssues(`services:
  a:
    image: x
    privileged: true
    pid: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
      - named:/x
  b:
    image: y
    network_mode: "service:a"
`);
    expect(issues).toHaveLength(3);
    expect(issues.join()).toContain("privileged");
    expect(issues.join()).toContain("docker.sock");
  });
});

describe("compose build contexts", () => {
  it("rejects build contexts and env files outside the repository", () => {
    const issues = composeSecurityIssues(`services:
  a:
    build: ../../
    env_file: [../../.env]
  b:
    build: { context: ./api }
  c:
    build: https://github.com/org/repo.git
`);
    expect(issues).toHaveLength(2);
  });
});

describe("explainCertError", () => {
  it("explains missing DNS records with the server IP", () => {
    const r = explainCertError(
      "DNS problem: NXDOMAIN looking up A for local.serve.bd - check that a DNS record exists for this domain; DNS problem: NXDOMAIN looking up AAAA for local.serve.bd",
      { serverIp: "1.2.3.4", provider: "letsencrypt-http" },
    );
    expect(r.title).toBe("No DNS record for local.serve.bd");
    expect(r.hint).toContain("1.2.3.4");
  });
  it("detects rate limits and unreachable servers", () => {
    expect(explainCertError("too many certificates already issued", { provider: "letsencrypt-http" }).title).toMatch(/rate limit/);
    expect(explainCertError("Timeout during connect (likely firewall problem)", { provider: "letsencrypt-http" }).title).toMatch(/could not reach/);
  });
  it("falls back to a generic message", () => {
    expect(explainCertError("something odd", { provider: "custom" }).title).toBe("The certificate could not be issued");
  });
});
