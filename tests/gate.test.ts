import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-gate";
vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
import { signGate, verifyGate } from "@/server/gate";
import { serverBlocks } from "@/server/proxy/templates";
import { renderCaddySite } from "@/server/proxy/caddy";
import { renderTraefikSite } from "@/server/proxy/traefik";
import type { SiteModel } from "@/server/proxy/model";

describe("login wall tokens", () => {
  it("verifies its own tokens and refuses changed, mixed up or expired ones", () => {
    const pass = signGate({ k: "c", u: "u1", s: "s1" });
    expect(verifyGate(pass, "c")).toMatchObject({ u: "u1", s: "s1" });
    expect(verifyGate(pass, "t")).toBeNull();
    const [body, sig] = pass.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), u: "admin" })).toString("base64url");
    expect(verifyGate(`${forged}.${sig}`, "c")).toBeNull();
    expect(verifyGate(`${pass}.x`, "c")).toBeNull();
    expect(verifyGate("", "c")).toBeNull();
    vi.useFakeTimers({ now: Date.now() + 61_000 });
    expect(verifyGate(signGate({ k: "c", u: "u", s: "s" }), "c")).not.toBeNull();
    vi.useRealTimers();
    const ticket = signGate({ k: "t", u: "u", s: "s", h: "a.example.com", p: "/", x: true });
    vi.useFakeTimers({ now: Date.now() + 61_000 });
    expect(verifyGate(ticket, "t")).toBeNull();
    vi.useRealTimers();
  });
});

describe("login wall in the proxies", () => {
  const gate = { upstream: "serve_gate_svc1", host: "serve.example.com", tls: true, serviceId: "svc1" };
  it("nginx checks every app request and keeps the 502 page", () => {
    const out = serverBlocks({ hostname: "app.example.com", upstream: "up", forceHttps: false, options: { gate } });
    expect(out).toContain("auth_request /__serve_gate_check;");
    expect(out).toContain("proxy_pass https://serve_gate_svc1/api/gate/check?s=svc1&r=401;");
    expect(out).toContain("location = /__serve/gate {");
    expect(out).toContain("proxy_ssl_verify on;");
    expect(out).toContain("error_page 502 503 504 /__serve_unavailable.html;");
    // The wall's error_page is at server level: inside the location it would replace the 502 page.
    const loc = out.slice(out.indexOf("location / {"), out.indexOf("location @serve_gate"));
    expect(loc).not.toMatch(/location \/ \{[^}]*error_page/);
  });
  const site: SiteModel = {
    name: "svc-svc1",
    title: "t",
    serviceId: "svc1",
    stopped: false,
    upstreams: [{ key: "app-80", targets: ["c1:80"] }],
    hosts: [{ hostname: "app.example.com", upstream: "app-80", redirectTo: null, https: true, forceHttps: true, tunnel: false, tls: null }],
    options: { login: true },
    gate: { upstream: "http://serve:3000" },
  };
  it("caddy swaps the ticket before forward_auth", () => {
    const out = renderCaddySite(site);
    expect(out.indexOf("handle /__serve/gate")).toBeLessThan(out.indexOf("forward_auth http://serve:3000"));
    expect(out).toContain("uri /api/gate/check?s=svc1");
  });
  it("traefik names the host and routes the ticket swap to Serve", () => {
    const out = renderTraefikSite(site, { resolver: true, trusted: [] });
    expect(out).toContain("address: http://serve:3000/api/gate/check?s=svc1&h=app.example.com");
    expect(out).toMatch(/svc-svc1-0-secure-gate:\n\s+rule: Host\(`app.example.com`\) && Path\(`\/__serve\/gate`\)/);
    expect(out).toContain("svc-svc1-0-gate");
  });
});
