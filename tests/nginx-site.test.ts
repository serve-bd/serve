import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-nginx-site";

// The nginx site Serve writes for a service, rendered from its rows as the proxy sync does.

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ service: null as Row | null, certs: [] as Row[], containers: [] as Row[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => {
  const table = (name: string) => new Proxy({}, { get: (_t, col) => (col === "__table" ? name : `${name}.${String(col)}`) });
  const schema = new Proxy({}, { get: (_t, name) => table(String(name)) });
  // Certificates are the only rows these queries need; the server row (proxy kind, trusted proxies) is left out.
  const from = (tbl: { __table: string }) => {
    const rows = () => Promise.resolve(tbl.__table === "certificate" ? state.certs : []);
    const c = { innerJoin: () => c, where: rows };
    return c;
  };
  return { db: { select: () => ({ from }), query: { service: { findFirst: async () => state.service } } }, schema };
});

const { generatedSite } = await import("@/server/proxy/nginx");
const { proxyInputSchema, buildProxyConfig } = await import("@/server/services/proxy-config");
const { safeRedirectUrl } = await import("@/server/security");

const ctx = {
  id: "local",
  network: "serve",
  docker: {
    listContainers: async () => state.containers,
    getNetwork: () => ({ inspect: async () => Promise.reject(Object.assign(new Error("no network"), { statusCode: 404 })) }),
  },
} as never;

const domain = (hostname: string, patch: Row = {}) => ({
  id: `d-${hostname}`,
  serviceId: "svc1",
  hostname,
  port: null,
  composeService: null,
  https: true,
  forceHttps: true,
  redirectTo: null,
  certificateId: null,
  tunnelId: null,
  generated: false,
  primary: false,
  ...patch,
});
const container = (name: string, deployment = "dep1") => ({ Names: [`/${name}`], Labels: { "serve.service": "svc1", "serve.deployment": deployment, "serve.kind": "app" } });

function setService(patch: Row = {}) {
  state.service = {
    id: "svc1",
    name: "Web",
    slug: "web",
    type: "app",
    status: "running",
    serverId: "local",
    currentDeploymentId: "dep1",
    runtime: { port: 3000, replicas: 2 },
    distribution: null,
    proxy: null,
    maintenance: null,
    balance: null,
    project: { organizationId: "org1" },
    domains: [domain("app.example.com")],
    ...patch,
  };
}
const render = async () => (await generatedSite("nginx", "svc1", ctx))!;

/**
 * The config's top-level statements and every directive name, read like nginx does: quotes and
 * comments respected. A value that broke out of its directive shows up here as a new one.
 */
function parse(conf: string) {
  const top: string[] = [];
  const directives: string[] = [];
  let depth = 0;
  let word = "";
  let words: string[] = [];
  let quote: string | null = null;
  const end = () => {
    if (word) words.push(word);
    word = "";
  };
  for (let i = 0; i < conf.length; i++) {
    const ch = conf[i];
    if (quote) {
      if (ch === "\\") word += conf[++i];
      else if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && !word) while (i < conf.length && conf[i] !== "\n") i++;
    else if (/\s/.test(ch)) end();
    else if (ch === ";" || ch === "{" || ch === "}") {
      end();
      if (words.length) {
        directives.push(words[0]);
        if (depth === 0) top.push(words[0]);
      }
      words = [];
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (depth < 0) throw new Error("unbalanced }");
    } else word += ch;
  }
  if (depth !== 0 || quote) throw new Error("unclosed block or quote");
  return { top, directives };
}

beforeEach(() => {
  state.certs = [
    { id: "c1", status: "active", domains: ["*.example.com"], certPath: "/certs/c1/fullchain.pem", keyPath: "/certs/c1/privkey.pem", expiresAt: new Date("2030-01-01") },
  ];
  state.containers = [container("web-1"), container("web-2"), container("web-old", "dep0")];
  setService();
});

describe("a typical app", () => {
  it("balances over the running replicas of the current deployment", async () => {
    const conf = await render();
    expect(parse(conf).top).toEqual(["upstream", "server", "server"]);
    const upstream = conf.slice(conf.indexOf("upstream"), conf.indexOf("}") + 1);
    expect(upstream).toContain("server web-1:3000 resolve");
    expect(upstream).toContain("server web-2:3000 resolve");
    expect(upstream).not.toContain("web-old");
  });

  it("redirects HTTP to HTTPS and serves HTTPS with the covering certificate", async () => {
    const conf = await render();
    const [http, https] = conf.split(/^server \{/m).slice(1);
    expect(http).toMatch(/server_name app\.example\.com;/);
    expect(http).toContain("return 301 https://$host$request_uri;");
    expect(http).not.toContain("proxy_pass");
    expect(https).toContain("ssl_certificate /certs/c1/fullchain.pem;");
    expect(https).toContain("ssl_certificate_key /certs/c1/privkey.pem;");
    expect(https).toMatch(/proxy_pass http:\/\/svc_web_3000;/);
    expect(https).toContain("Strict-Transport-Security");
    expect(conf).toContain("# Certificate c1 valid until 2030-01-01");
  });

  it("keeps the ACME challenge on plain HTTP even with the redirect", async () => {
    const http = (await render()).split(/^server \{/m)[1];
    expect(http.indexOf("acme-challenge")).toBeLessThan(http.indexOf("return 301"));
  });

  it("serves plain HTTP when HTTPS is off or no certificate covers the name", async () => {
    setService({ domains: [domain("other.test", { https: true }), domain("plain.example.com", { https: false })] });
    const conf = await render();
    expect(parse(conf).top).toEqual(["upstream", "server", "server"]);
    expect(conf).not.toContain("ssl_certificate");
    expect(conf).not.toContain("return 301");
  });

  it("passes WebSocket upgrades unless turned off", async () => {
    expect(await render()).toContain("include /etc/nginx/serve/proxy_params.conf;");
    setService({ proxy: buildProxyConfig(proxyInputSchema.parse({ websockets: false }), null) });
    const conf = await render();
    expect(conf).not.toContain("include /etc/nginx/serve/proxy_params.conf;");
    expect(conf).toMatch(/include \S+\/params\/plain\.conf;/);
  });

  it("applies custom headers and access lists", async () => {
    setService({
      proxy: buildProxyConfig(proxyInputSchema.parse({ headers: [{ name: "X-Frame-Options", value: "DENY" }], deny: ["198.51.100.7"], allow: ["10.0.0.0/8"] }), null),
    });
    const conf = await render();
    expect(conf).toContain('add_header X-Frame-Options "DENY" always;');
    expect(conf).toContain("deny 198.51.100.7;");
    expect(conf).toContain("allow 10.0.0.0/8;");
    expect(conf).toContain("deny all;");
  });

  it("answers 503 with no upstream while the app is stopped", async () => {
    setService({ status: "stopped" });
    const conf = await render();
    expect(parse(conf).top).toEqual(["server", "server"]);
    expect(conf).not.toContain("proxy_pass");
    expect(conf).toContain("return 503;");
  });

  it("keeps nginx loadable with no running container", async () => {
    state.containers = [];
    expect(await render()).toContain("server 127.0.0.1:1 down;");
  });

  it("redirect domains redirect and get no upstream of their own", async () => {
    setService({ domains: [domain("old.example.com", { redirectTo: "https://app.example.com/", forceHttps: false })] });
    const conf = await render();
    expect(parse(conf).top).toEqual(["server", "server"]);
    expect(conf).toContain("return 308 https://app.example.com$request_uri;");
  });

  it("writes nothing for a service without domains, or a database", async () => {
    setService({ domains: [] });
    expect(await generatedSite("nginx", "svc1", ctx)).toBeNull();
    setService({ type: "database" });
    expect(await generatedSite("nginx", "svc1", ctx)).toBeNull();
  });
});

describe("user values cannot add directives", () => {
  const evil = ["x;\n}\nserver { listen 81; }", 'a" always; include /etc/passwd; #', "a{b}c", "$(id)", "x\r\ny"];

  it("slugs and compose service names stay inside upstream names", async () => {
    setService({ type: "compose", slug: "we;b {", domains: [domain("app.example.com", { composeService: "api; include /etc/passwd;", port: 8080 })] });
    const conf = await render();
    const { top, directives } = parse(conf);
    expect(top).toEqual(["upstream", "server", "server"]);
    expect(directives.filter((d) => d === "include")).toHaveLength(1);
    expect(conf).not.toContain("/etc/passwd;");
  });

  it("access lists and maintenance allow lists drop anything that is not an address", async () => {
    setService({
      proxy: { allow: ["10.0.0.1; include /etc/passwd", "10.0.0.2"], deny: ["1.2.3.4 } server {"] },
      maintenance: { enabled: true, allow: ["10.0.0.3;evil", "10.0.0.4"] },
    });
    const conf = await render();
    parse(conf);
    expect(conf).toContain("allow 10.0.0.2;");
    expect(conf).toContain("10.0.0.4 1;");
    expect(conf).not.toMatch(/passwd|evil|1\.2\.3\.4/);
  });

  it("header names and values that could break out are refused when saved", () => {
    for (const value of evil) expect(proxyInputSchema.safeParse({ headers: [{ name: "X-A", value }] }).success).toBe(false);
    for (const name of evil) expect(proxyInputSchema.safeParse({ headers: [{ name, value: "v" }] }).success).toBe(false);
  });

  it("sizes, origins and redirect targets that could break out are refused when saved", () => {
    for (const v of evil) {
      expect(proxyInputSchema.safeParse({ maxBodySize: v }).success).toBe(false);
      expect(proxyInputSchema.safeParse({ corsOrigins: [`https://a.com${v}`] }).success).toBe(false);
    }
    for (const url of ["https://a.com/;include /etc/passwd", "https://a.com/$host", "https://a.com/'x", "https://a.com/\nb", "javascript:alert(1)"]) {
      // Refused, or cleaned by the URL parser into something that cannot end the directive.
      let href: string | null = null;
      try {
        href = safeRedirectUrl(url);
      } catch {
        continue;
      }
      expect(href, url).not.toMatch(/[;\s{}$'"]/);
    }
  });

  it("saved options with every kind of value still render one clean site", async () => {
    setService({
      domains: [domain("app.example.com"), domain("www.app.example.com")],
      proxy: buildProxyConfig(
        proxyInputSchema.parse({
          headers: [{ name: "X-Test", value: "a b;c 'q' (x) #y" }],
          corsOrigins: ["https://a.example.com:8443"],
          maxBodySize: "20m",
          basicAuth: { enabled: true, username: "u", password: "secret123" },
          securityHeaders: true,
          cacheStatic: true,
          wwwRedirect: "to-apex",
          customDirectives: "if ($x) { return 403; }",
        }),
        null,
      ),
    });
    const conf = await render();
    // www.app.example.com has no certificate (*.example.com covers one level): plain HTTP only.
    expect(parse(conf).top).toEqual(["upstream", "server", "server", "server"]);
    expect(conf).toContain("add_header X-Test \"a b;c 'q' (x) #y\" always;");
    expect(conf).toContain("return 308 https://app.example.com$request_uri;");
  });
});
