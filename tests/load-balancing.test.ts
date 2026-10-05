import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { RULES_JQ } from "@/server/mesh/agent";
import {
  addressChanges,
  agentConfig,
  copyKey,
  environmentKey,
  linkName,
  neededAddresses,
  type PlanAddress,
  type PlanServer,
  type PlanService,
  parseCopyKey,
  serviceKey,
} from "@/server/mesh/plan";
import { balancedTargets, type Copy, copyProblem, decide, nextBalance, serverTraffic, step, targetsSignature } from "@/server/services/balance-rules";
import { upstreamBlock } from "@/server/proxy/templates";
import { renderCaddySite } from "@/server/proxy/caddy";
import { renderTraefikSite } from "@/server/proxy/traefik";
import type { SiteModel } from "@/server/proxy/model";
import { buildProxyConfig, proxyInputSchema } from "@/server/services/proxy-config";

/*
 * Load balancing across servers: the app's own server (a) sends traffic to its local containers and
 * to the app's copies on its extra servers (b, c), each reached at an address of its own in the
 * private network through a link container on a.
 */

const server = (id: string, index: number, endpoint: string | null = `10.0.0.${index}`, networks = ["n1"]): PlanServer => ({
  id,
  index,
  endpoint,
  port: 51820,
  publicKey: `pub-${id}`,
  networks,
});
const app = (patch: Partial<PlanService> = {}): PlanService => ({
  id: "web",
  environmentId: "env1",
  serverId: "a",
  extraServerIds: ["b", "c"],
  type: "app",
  slug: "web",
  hostname: null,
  composeServices: [],
  isolated: false,
  composeSubnet: null,
  currentDeploymentId: "dep2ab",
  replicas: 3,
  balance: true,
  switched: ["b", "c"],
  ...patch,
});

// a: the app's own server, behind NAT (no public address), like a home machine.
const A = server("a", 1, null);
const B = server("b", 2);
const C = server("c", 3);

/** Addresses as the network would hand them out for these needs. */
function addressesFor(needs: ReturnType<typeof neededAddresses>): PlanAddress[] {
  let svc = 0;
  return needs.map((n) => {
    const index = [A, B, C].find((s) => s.id === n.serverId)!.index;
    return { serverId: n.serverId, key: n.key, ip: n.key.startsWith("env:") ? `10.241.${index}.2` : `10.240.1.${++svc}` };
  });
}

describe("the private network carries the app's copies", () => {
  it("gives the app's copy on each extra server an address of its own there", () => {
    const needs = neededAddresses([A, B, C], [app()]);
    const keys = needs.map((n) => `${n.serverId} ${n.key}`).sort();
    // One per replica: the proxy keeps connections open, so each replica needs an address of its own.
    for (const x of ["b", "c"]) for (const slot of [1, 2, 3]) expect(keys).toContain(`${x} lb:web:${x}:${slot}`);
    expect(keys).not.toContain("b lb:web:b:4");
    // The own server keeps the app's usual address; no copy address there.
    expect(keys).toContain("a svc:web");
    expect(keys.some((k) => k.startsWith("a lb:"))).toBe(false);
  });

  it("gives no copy address to an extra server without a private network with the own server", () => {
    const lonely = server("c", 3, "10.0.0.3", ["n2"]);
    const keys = neededAddresses([A, B, lonely], [app()]).map((n) => n.key);
    expect(keys).toContain("lb:web:b:1");
    expect(keys.some((k) => k.startsWith("lb:web:c"))).toBe(false);
  });

  it("gives no copy addresses while load balancing is off", () => {
    expect(neededAddresses([A, B, C], [app({ balance: false })]).some((n) => n.key.startsWith("lb:"))).toBe(false);
    const addresses: PlanAddress[] = [{ serverId: "b", key: copyKey("web", "b", 1), ip: "10.240.1.2" }];
    expect(addressChanges(addresses, [app({ balance: false })]).remove.map((a) => a.ip)).toEqual(["10.240.1.2"]);
  });

  it("gives no copy addresses to databases or stacks, nor without extra servers", () => {
    expect(neededAddresses([A, B], [app({ extraServerIds: [] })]).some((n) => n.key.startsWith("lb:"))).toBe(false);
    expect(neededAddresses([A, B], [app({ type: "database", extraServerIds: ["b"] })]).some((n) => n.key.startsWith("lb:"))).toBe(false);
  });

  it("reads copy keys back, and never mistakes other keys for them", () => {
    expect(parseCopyKey(copyKey("web", "b", 2))).toEqual({ serviceId: "web", serverId: "b", slot: 2 });
    expect(parseCopyKey("lb:web:b")).toBeNull();
    expect(parseCopyKey("lb:web:b:0")).toBeNull();
    expect(parseCopyKey(serviceKey("web"))).toBeNull();
    expect(parseCopyKey(serviceKey("stack", "lb"))).toBeNull();
    expect(parseCopyKey(environmentKey("env1"))).toBeNull();
  });

  it("forgets a copy's address once the app leaves that server, and never moves it", () => {
    const addresses: PlanAddress[] = [
      { serverId: "b", key: copyKey("web", "b", 1), ip: "10.240.1.2" },
      { serverId: "c", key: copyKey("web", "c", 1), ip: "10.240.1.3" },
      { serverId: "c", key: copyKey("gone", "c", 1), ip: "10.240.1.4" },
      { serverId: "b", key: copyKey("web", "b", 4), ip: "10.240.1.5" },
      { serverId: "b", key: "lb:web:b", ip: "10.240.1.6" },
    ];
    const { remove, move } = addressChanges(addresses, [app({ extraServerIds: ["b"] })]);
    // Server c left, the app "gone" is deleted, replica 4 is more than the app runs now, and a key in an old format.
    expect(remove.map((a) => a.ip).sort()).toEqual(["10.240.1.3", "10.240.1.4", "10.240.1.5", "10.240.1.6"]);
    expect(move).toEqual([]);
    // The app moved its own server to b: the copy on b is no longer a copy.
    expect(addressChanges(addresses.slice(0, 1), [app({ serverId: "b", extraServerIds: ["c"] })]).remove.map((a) => a.ip)).toEqual(["10.240.1.2"]);
  });

  const services = [app()];
  const needs = neededAddresses([A, B, C], services);
  const addresses = addressesFor(needs);
  const ipOf = (serverId: string, key: string) => addresses.find((a) => a.serverId === serverId && a.key === key)!.ip;

  it("on an extra server: forwards each replica address to that replica, from the own server only", () => {
    const cfg = agentConfig({ ...B, privateKey: "k" }, [A, B, C], services, addresses, needs);
    const exposure = cfg.exposures.find((e) => e.ip === ipOf("b", copyKey("web", "b", 1)))!;
    // The current version once it runs there, else what runs (a failed deploy keeps the old one).
    expect(exposure).toMatchObject({ service: "web", deployment: "dep2ab", network: "serve-env-env1", slot: 1, prefer: true });
    expect(exposure.allow).toContain(ipOf("a", environmentKey("env1")));
    expect(cfg.localAddresses).toContain(exposure.ip);
  });

  it("on the own server: a link container per copy, and routes to the copies' addresses", () => {
    const cfg = agentConfig({ ...A, privateKey: "k" }, [A, B, C], services, addresses, needs);
    for (const x of ["b", "c"]) {
      const ip = ipOf(x, copyKey("web", x, 1));
      expect(cfg.imports).toContainEqual({ name: linkName(ip), ip, network: "serve-env-env1", aliases: [] });
      expect(cfg.peers.find((p) => p.serverId === x)!.allowedIps).toContain(`${ip}/32`);
    }
    // The app runs on a itself: no link to its own usual address.
    expect(cfg.imports.some((i) => i.ip === ipOf("a", serviceKey("web")))).toBe(false);
  });

  it("extra servers do not import each other's copies", () => {
    const cfg = agentConfig({ ...C, privateKey: "k" }, [A, B, C], services, addresses, needs);
    expect(cfg.imports.some((i) => i.ip === ipOf("b", copyKey("web", "b", 1)))).toBe(false);
  });

  it("firewall: each replica address leads to that replica on the server, old or new version, never a pre-deploy container", () => {
    const cfg = agentConfig({ ...B, privateKey: "k" }, [A, B, C], services, addresses, needs);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-lb-"));
    const write = (name: string, data: unknown) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
      return p;
    };
    const container = (name: string, ip: string, labels: Record<string, string>) => ({
      Names: [`/${name}`],
      Labels: { "serve.service": "web", "serve.kind": "app", ...labels },
      NetworkSettings: { Networks: { "serve-env-env1": { IPAddress: ip } } },
    });
    const out = execFileSync(
      "jq",
      [
        "-r",
        "--arg",
        "if",
        "serve-mesh",
        "--slurpfile",
        "c",
        write("c.json", [
          // A rolling deploy in progress: replica 1 of the new version next to replica 1 of the old one.
          container("web-dep2ab-1", "172.20.0.5", { "serve.deployment": "dep2ab" }),
          container("web-dep1cd-1", "172.20.0.6", { "serve.deployment": "dep1cd" }),
          container("web-dep2ab-2", "172.20.0.7", { "serve.deployment": "dep2ab" }),
          container("web-dep2ab-11", "172.20.0.8", { "serve.deployment": "dep2ab" }),
          container("web-dep2ab-1-predeploy", "172.20.0.9", { "serve.deployment": "dep2ab", "serve.kind": "predeploy" }),
        ]),
        "--slurpfile",
        "nets",
        write("nets.json", { "serve-env-env1": ["172.20.0.0/16"] }),
        "-f",
        write("rules.jq", RULES_JQ),
        write("config.json", cfg),
      ],
      { encoding: "utf8" },
    );
    const one = ipOf("b", copyKey("web", "b", 1));
    const two = ipOf("b", copyKey("web", "b", 2));
    const three = ipOf("b", copyKey("web", "b", 3));
    // Replica 1 of the new version runs: only it gets traffic, the old one drains unused.
    expect(out).toContain(`-d ${one}/32 -j DNAT --to-destination 172.20.0.5`);
    expect(out).not.toContain("172.20.0.6");
    expect(out).toContain(`-d ${two}/32 -j DNAT --to-destination 172.20.0.7`);
    // Replica 11 is not replica 1, and a pre-deploy container never takes traffic.
    expect(out).not.toContain("172.20.0.8");
    expect(out).not.toContain("172.20.0.9");
    // Replica 3 runs nowhere yet: no forwarding (the health check takes it out).
    expect(out).not.toContain(`-d ${three}/32 -j DNAT`);
    expect(out).toContain(`-s ${ipOf("a", environmentKey("env1"))}/32 -m conntrack --ctorigdst ${one}/32 -j ACCEPT`);
    // The deploy failed on this server: only the old version runs, and it keeps answering.
    const failed = execFileSync(
      "jq",
      [
        "-r",
        "--arg",
        "if",
        "serve-mesh",
        "--slurpfile",
        "c",
        write("c2.json", [container("web-dep1cd-1", "172.20.0.6", { "serve.deployment": "dep1cd" })]),
        "--slurpfile",
        "nets",
        write("nets2.json", { "serve-env-env1": ["172.20.0.0/16"] }),
        "-f",
        write("rules2.jq", RULES_JQ),
        write("config2.json", cfg),
      ],
      { encoding: "utf8" },
    );
    expect(failed).toContain(`-d ${one}/32 -j DNAT --to-destination 172.20.0.6`);
    // This server has not switched yet (its new containers still start): the old version keeps
    // every visitor, and the new one gets none until the deploy switches over.
    const waiting = agentConfig({ ...B, privateKey: "k" }, [A, B, C], [app({ switched: [] })], addresses, needs);
    expect(waiting.exposures.find((e) => e.ip === one)).toMatchObject({ slot: 1, avoid: true });
    const rolling = execFileSync(
      "jq",
      [
        "-r",
        "--arg",
        "if",
        "serve-mesh",
        "--slurpfile",
        "c",
        write("c3.json", [
          container("web-dep2ab-1", "172.20.0.5", { "serve.deployment": "dep2ab" }),
          container("web-dep1cd-1", "172.20.0.6", { "serve.deployment": "dep1cd" }),
          container("web-dep2ab-2", "172.20.0.7", { "serve.deployment": "dep2ab" }),
        ]),
        "--slurpfile",
        "nets",
        write("nets3.json", { "serve-env-env1": ["172.20.0.0/16"] }),
        "-f",
        write("rules3.jq", RULES_JQ),
        write("config3.json", waiting),
      ],
      { encoding: "utf8" },
    );
    expect(rolling).toContain(`-d ${one}/32 -j DNAT --to-destination 172.20.0.6`);
    expect(rolling).not.toContain("172.20.0.5");
    // Replica 2 has no old version: refused, so the health check takes it out until the switch.
    expect(rolling).not.toContain(`-d ${two}/32 -j DNAT`);
    expect(rolling).toContain(`-d ${two}/32 -p tcp -j REJECT --reject-with tcp-reset`);
  });
});

describe("which copies get traffic", () => {
  const copy = (serverId: string, patch: Partial<Copy> = {}): Copy => ({
    serverId,
    slot: 1,
    host: `serve-link-${serverId}`,
    deployed: true,
    linked: true,
    healthy: true,
    error: null,
    since: null,
    ...patch,
  });

  it("sends traffic to every replica on other servers that is linked, deployed and answers", () => {
    expect(balancedTargets(3, [copy("b"), copy("c")])).toEqual(["serve-link-b", "serve-link-c"]);
  });

  it("sums a server's replicas up: traffic while any replica takes it, else its worst problem", () => {
    expect(serverTraffic([copy("b"), copy("b", { slot: 2, healthy: false, error: "No answer." })])).toMatchObject({ problem: null, up: 1, total: 2, error: "No answer." });
    expect(serverTraffic([copy("b", { healthy: false }), copy("b", { slot: 2, healthy: false })])).toMatchObject({ problem: "down", up: 0, total: 2 });
    expect(serverTraffic([copy("b", { linked: false }), copy("b", { slot: 2, linked: false })]).problem).toBe("network");
    expect(serverTraffic([copy("b", { deployed: false })]).problem).toBe("deploy");
  });

  it("counts a copy not checked yet as up", () => {
    expect(balancedTargets(1, [copy("b", { healthy: null })])).toHaveLength(1);
  });

  it("leaves out copies that are down, not deployed, without an address or without a private network", () => {
    const list = [copy("b", { healthy: false }), copy("c", { deployed: false }), copy("d", { host: null }), copy("e", { linked: false }), copy("f")];
    expect(balancedTargets(2, list)).toEqual(["serve-link-f"]);
    expect(list.map(copyProblem)).toEqual(["down", "deploy", "address", "network", null]);
  });

  it("tries every usable copy when nothing else is left (a health check can be wrong)", () => {
    const list = [copy("b", { healthy: false }), copy("c", { healthy: false }), copy("d", { deployed: false })];
    expect(balancedTargets(0, list)).toEqual(["serve-link-b", "serve-link-c"]);
    // With local containers the copies that are down stay out.
    expect(balancedTargets(2, list)).toEqual([]);
  });

  it("checks: down after two failures in a row, up again after two successes", () => {
    let s = step(undefined, false);
    expect(decide(true, s)).toBe(true);
    s = step(s, false);
    expect(decide(true, s)).toBe(false);
    s = step(s, true);
    expect(decide(false, s)).toBe(false);
    s = step(s, true);
    expect(decide(false, s)).toBe(true);
    // Never checked: one success is enough to know, one failure is not.
    expect(decide(null, step(undefined, true))).toBe(true);
    expect(decide(null, step(undefined, false))).toBeNull();
  });

  it("saves the health only when it changes (pages refresh on every saved change)", () => {
    const now = new Date("2026-10-05T10:00:00Z");
    const first = nextBalance(null, "b", false, "Nothing answers on port 3000.", now)!;
    expect(first.copies.b).toEqual({ ok: false, since: now.toISOString(), error: "Nothing answers on port 3000." });
    expect(nextBalance(first, "b", false, "Nothing answers on port 3000.", new Date())).toBeNull();
    // Still down with another message: nothing to save.
    expect(nextBalance(first, "b", false, "No answer on port 3000 within a few seconds.", new Date())).toBeNull();
    const up = nextBalance(first, "b", true, null, new Date("2026-10-05T10:05:00Z"))!;
    expect(up.copies.b).toEqual({ ok: true, since: "2026-10-05T10:05:00.000Z", error: null });
    expect(nextBalance(up, "b", true, null, new Date())).toBeNull();
  });

  it("syncs the proxy when the targets change, not on every check", () => {
    const base = [copy("b"), copy("c")];
    expect(targetsSignature(base)).toBe(targetsSignature([copy("c"), copy("b")]));
    expect(targetsSignature(base)).not.toBe(targetsSignature([copy("b"), copy("c", { healthy: false })]));
    expect(targetsSignature(base)).not.toBe(targetsSignature([copy("b"), copy("c"), copy("c", { slot: 2 })]));
    expect(targetsSignature(base)).toBe(targetsSignature([copy("b"), copy("c", { healthy: null })]));
  });
});

describe("the proxies balance over the copies", () => {
  it("nginx: local containers as before, copies weighted and skipped for a while after a failure", () => {
    const block = upstreamBlock({
      name: "svc_web_3000",
      servers: ["web-1:3000", "web-2:3000"],
      remote: [
        { server: "serve-link-10-240-1-2:3000", weight: 2 },
        { server: "serve-link-10-240-1-3:3000", weight: 1 },
      ],
    });
    expect(block).toContain("server web-1:3000 resolve max_fails=0;");
    expect(block).toContain("server serve-link-10-240-1-2:3000 resolve weight=2 max_fails=1 fail_timeout=10s;");
    expect(block).toContain("server serve-link-10-240-1-3:3000 resolve max_fails=1 fail_timeout=10s;");
    expect(block).not.toContain("127.0.0.1:1 down");
  });

  it("nginx: copies alone when the own server runs no container (it fails over to them)", () => {
    const block = upstreamBlock({ name: "u", servers: [], remote: [{ server: "serve-link-10-240-1-2:3000", weight: 1 }] });
    expect(block).toContain("serve-link-10-240-1-2:3000");
    expect(block).not.toContain("down;");
  });

  it("nginx: sticky visitors hash over local containers and copies alike", () => {
    expect(upstreamBlock({ name: "u", servers: ["web-1:3000"], sticky: true, remote: [{ server: "l:3000", weight: 1 }] })).toContain("hash $remote_addr consistent;");
  });

  const site = (sticky: boolean): SiteModel => ({
    name: "svc-web",
    title: "web",
    serviceId: "web",
    stopped: false,
    upstreams: [{ key: "app-3000", targets: ["web-1:3000", "serve-link-10-240-1-2:3000"], weights: [1, 3], remote: true }],
    hosts: [{ hostname: "web.test", upstream: "app-3000", redirectTo: null, https: false, forceHttps: false, tunnel: false, tls: null }],
    options: { ...buildProxyConfig(proxyInputSchema.parse({ sticky }), null), connectTimeout: 3 },
  });

  it("Caddy: weighted round robin, passive health for the copies, a short dial timeout", () => {
    const out = renderCaddySite(site(false));
    expect(out).toContain("lb_policy weighted_round_robin 1 3");
    expect(out).toContain("fail_duration 10s");
    expect(out).toContain("max_fails 1");
    expect(out).toContain("dial_timeout 3s");
    expect(out).toContain("reverse_proxy web-1:3000 serve-link-10-240-1-2:3000 {");
    // Sticky keeps the client IP hash (weights do not apply to it).
    expect(renderCaddySite(site(true))).toContain("lb_policy client_ip_hash");
  });

  it("Traefik: server weights, a retry on another copy, a short dial timeout", () => {
    const y = YAML.parse(renderTraefikSite(site(false), { resolver: false, trusted: [] }));
    expect(y.http.services["svc-web-app-3000"].loadBalancer.servers).toEqual([{ url: "http://web-1:3000" }, { url: "http://serve-link-10-240-1-2:3000", weight: 3 }]);
    // As many tries as replicas (at least 3, at most 10): Traefik may pick a dead one again.
    expect(y.http.middlewares["svc-web-retry"]).toEqual({ retry: { attempts: 3, initialInterval: "50ms" } });
    const many: SiteModel = { ...site(false), upstreams: [{ key: "app-3000", targets: Array.from({ length: 14 }, (_, i) => `t${i}:3000`), remote: true }] };
    expect(YAML.parse(renderTraefikSite(many, { resolver: false, trusted: [] })).http.middlewares["svc-web-retry"].retry.attempts).toBe(10);
    const router = Object.values(y.http.routers as Record<string, { middlewares?: string[] }>).find((r) => r.middlewares?.includes("svc-web-retry"));
    expect(router).toBeTruthy();
    expect(y.http.serversTransports["svc-web-transport"].forwardingTimeouts.dialTimeout).toBe("3s");
  });

  it("Traefik: no passive health check (it counts the app's own 5xx answers and took every replica out)", () => {
    const lb = YAML.parse(renderTraefikSite(site(false), { resolver: false, trusted: [] })).http.services["svc-web-app-3000"].loadBalancer;
    expect(lb.passiveHealthCheck).toBeUndefined();
  });

  it("without copies nothing changes", () => {
    const plain: SiteModel = { ...site(false), upstreams: [{ key: "app-3000", targets: ["web-1:3000"] }], options: buildProxyConfig(proxyInputSchema.parse({}), null) };
    expect(renderCaddySite(plain)).not.toContain("fail_duration");
    expect(renderCaddySite(plain)).toContain("lb_policy round_robin");
    expect(YAML.parse(renderTraefikSite(plain, { resolver: false, trusted: [] })).http.middlewares?.["svc-web-retry"]).toBeUndefined();
  });
});
