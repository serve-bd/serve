import { describe, expect, it } from "vitest";
import { hostPortIssue, hostPortsIn, proxyStreamConfig, relayConfig, relayPlan } from "@/server/proxy/host-relay";

const file = (content: string) => [{ name: "a.conf", content }];

describe("machine ports in custom nginx files", () => {
  it("finds 127.0.0.1 and localhost ports in any directive, not in comments", () => {
    const f = file(`server {
  location / { proxy_pass http://127.0.0.1:81; }   # was 127.0.0.1:9999
  location /a { proxy_pass http://localhost:6001; }
  # proxy_pass http://127.0.0.1:7777;
}
upstream app { server 127.0.0.1:3000 max_fails=3; server localhost:3000; }
location ~ \\.php$ { fastcgi_pass 127.0.0.1:9000; }
proxy_pass http://10.127.0.0.1:1234; proxy_pass http://my-localhost:5555; proxy_pass http://app:8080;`);
    expect(hostPortsIn(f)).toEqual([81, 3000, 6001, 9000]);
  });

  it("refuses the proxy's own ports", () => {
    expect(hostPortIssue(file("proxy_pass http://127.0.0.1:80;"), false)).toMatch(/Port 80/);
    expect(hostPortIssue(file("proxy_pass http://127.0.0.1:81;"), false)).toBeNull();
    expect(hostPortIssue(file("proxy_pass http://127.0.0.1:81;"), true)).toMatch(/Port 81/);
    expect(hostPortIssue(file("proxy_pass http://app:80;"), false)).toBeNull();
  });

  it("writes a listener per port in the proxy, and a relay that lets only the proxy in", () => {
    const plan = relayPlan(file("proxy_pass http://127.0.0.1:2347; proxy_pass http://localhost:81;"), "10.0.0.1", false);
    expect(plan.routes).toEqual([
      { port: 81, relayPort: 61000 },
      { port: 2347, relayPort: 61001 },
    ]);
    const stream = proxyStreamConfig(plan)!;
    expect(stream).toContain("listen 127.0.0.1:2347;");
    expect(stream).toContain("proxy_pass 10.0.0.1:61001;");
    const relay = relayConfig(plan, ["10.5.0.3"]);
    expect(relay).toContain("listen 10.0.0.1:61001;");
    expect(relay).toContain("allow 10.5.0.3;");
    expect(relay).toContain("deny all;");
    expect(relay).toContain("proxy_pass 127.0.0.1:2347;");
    // Never on every address: the relay must not be reachable from the internet.
    expect(relay).not.toMatch(/listen (0\.0\.0\.0:)?\d+;/);
    // Without the proxy's address nothing gets in.
    expect(relayConfig(plan, [])).not.toContain("allow");
    expect(proxyStreamConfig(relayPlan(file("proxy_pass http://app:80;"), "10.0.0.1", false))).toBeNull();
  });
});
