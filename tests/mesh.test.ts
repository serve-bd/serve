import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handshakeAge, meshEndpoint, meshEndpointProblem } from "@/lib/mesh";
import { LINKS_JQ, RULES_JQ, WG_JQ } from "@/server/mesh/agent";
import { generateMeshKeys } from "@/server/mesh/keys";
import { type ImpactService, type ImpactVar, lostLinks, membersAfter } from "@/server/mesh/impact";
import {
  addressChanges,
  agentConfig,
  allocateAddress,
  environmentKey,
  linked,
  neededAddresses,
  type PlanAddress,
  privatelyConnected,
  reachesPrivately,
  type PlanServer,
  type PlanService,
  serviceKey,
} from "@/server/mesh/plan";

const server = (id: string, index: number, endpoint: string | null = `10.0.0.${index}`, networks = ["n1"]): PlanServer => ({
  id,
  index,
  endpoint,
  port: 51820,
  publicKey: `pub-${id}`,
  networks,
});
const svc = (id: string, patch: Partial<PlanService> = {}): PlanService => ({
  id,
  environmentId: "env1",
  serverId: "a",
  extraServerIds: [],
  type: "database",
  slug: id,
  hostname: null,
  composeServices: [],
  isolated: false,
  composeSubnet: null,
  currentDeploymentId: null,
  ...patch,
});

const A = server("a", 1);
const B = server("b", 2);
const C = server("c", 3);

/** Joined servers by id: their networks, and "nat" for the ones with no public address. */
const members = (list: Record<string, string[] | { networks: string[]; nat: boolean }>) =>
  new Map(Object.entries(list).map(([id, v]) => [id, Array.isArray(v) ? { networks: v, nat: false } : v]));

describe("several private networks", () => {
  // n1: a, b. n2: c, d. b is in both, so it talks to everyone; a and c never talk.
  const a = server("a", 1, "10.0.0.1", ["n1"]);
  const b = server("b", 2, "10.0.0.2", ["n1", "n2"]);
  const c = server("c", 3, "10.0.0.3", ["n2"]);
  const d = server("d", 4, "10.0.0.4", ["n2"]);
  const all = [a, b, c, d];

  it("links only servers that share a network", () => {
    expect(linked(a, b)).toBe(true);
    expect(linked(b, c)).toBe(true);
    expect(linked(a, c)).toBe(false);
    expect(linked(a, a)).toBe(false);
    expect(linked(server("x", 9, null, []), a)).toBe(false);
  });

  it("wires an environment only between servers sharing a network", () => {
    // a and c share nothing: the environment spans them but stays unwired.
    expect(neededAddresses(all, [svc("db"), svc("app", { type: "app", serverId: "c" })])).toEqual([]);
    // c and d share n2; a is left out.
    const needs = neededAddresses(all, [svc("db"), svc("app", { type: "app", serverId: "c" }), svc("cache", { serverId: "d" })]);
    expect(needs.map((n) => `${n.serverId} ${n.key}`).sort()).toEqual(["c env:env1", "c svc:app", "d env:env1", "d svc:cache"]);
  });

  it("peers, exposes and imports only across shared networks", () => {
    const services = [svc("db"), svc("api", { type: "app", serverId: "b" }), svc("web", { type: "app", serverId: "c" })];
    const addresses: PlanAddress[] = [
      { serverId: "a", key: serviceKey("db"), ip: "10.240.1.1" },
      { serverId: "b", key: serviceKey("api"), ip: "10.240.1.2" },
      { serverId: "c", key: serviceKey("web"), ip: "10.240.1.3" },
      { serverId: "a", key: environmentKey("env1"), ip: "10.241.1.2" },
      { serverId: "b", key: environmentKey("env1"), ip: "10.241.2.2" },
      { serverId: "c", key: environmentKey("env1"), ip: "10.241.3.2" },
    ];
    const needs = neededAddresses(all, services);
    expect(needs.map((n) => `${n.serverId} ${n.key}`).sort()).toEqual(["a env:env1", "a svc:db", "b env:env1", "b svc:api", "c env:env1", "c svc:web"]);

    const cfgA = agentConfig({ ...a, privateKey: "k" }, all, services, addresses, needs);
    expect(cfgA.peers.map((p) => p.serverId)).toEqual(["b"]);
    // Only b's environment address may reach the database; c's may not.
    expect(cfgA.exposures).toEqual([{ ip: "10.240.1.1", service: "db", kind: null, compose: null, deployment: null, network: "serve-env-env1", allow: ["10.241.2.2"] }]);
    expect(cfgA.imports.map((i) => i.ip)).toEqual(["10.240.1.2"]);

    const cfgC = agentConfig({ ...c, privateKey: "k" }, all, services, addresses, needs);
    expect(cfgC.peers.map((p) => p.serverId)).toEqual(["b", "d"]);
    // c uses b's api, but never a's database.
    expect(cfgC.imports.map((i) => i.ip)).toEqual(["10.240.1.2"]);
    expect(cfgC.peers.find((p) => p.serverId === "b")?.allowedIps).toEqual(["10.241.2.0/24", "10.240.1.2/32"]);
    expect(cfgC.peers.find((p) => p.serverId === "d")?.allowedIps).toEqual(["10.241.4.0/24"]);

    const cfgB = agentConfig({ ...b, privateKey: "k" }, all, services, addresses, needs);
    expect(cfgB.peers.map((p) => p.serverId)).toEqual(["a", "c", "d"]);
    expect(cfgB.exposures[0].allow).toEqual(["10.241.1.2", "10.241.3.2"]);
    expect(cfgB.imports.map((i) => i.ip).sort()).toEqual(["10.240.1.1", "10.240.1.3"]);
  });

  it("gives a server in no network no peers", () => {
    const lone = server("e", 5, "10.0.0.5", []);
    const cfg = agentConfig({ ...lone, privateKey: "k" }, [...all, lone], [svc("x", { serverId: "e" })], [], []);
    expect(cfg.peers).toEqual([]);
    expect(cfg.imports).toEqual([]);
  });

  it("says which servers reach each other's private names", () => {
    const m = members({ a: ["n1"], b: ["n1", "n2"], c: ["n2"], e: [] });
    expect(privatelyConnected(m, "a", "b")).toBe(true);
    expect(privatelyConnected(m, "a", "c")).toBe(false);
    expect(privatelyConnected(m, "e", "a")).toBe(false);
    expect(privatelyConnected(m, "e", "e")).toBe(true);
    expect(privatelyConnected(m, "a", "zzz")).toBe(false);
  });

  it("does not connect two servers that both have no public address", () => {
    const m = members({ home1: { networks: ["n1"], nat: true }, home2: { networks: ["n1"], nat: true }, vps: ["n1"] });
    expect(privatelyConnected(m, "home1", "home2")).toBe(false);
    expect(privatelyConnected(m, "home1", "vps")).toBe(true);
  });

  it("needs every server a service runs on to reach the other service", () => {
    const m = members({ c: ["n1"], p: ["n1"], x: ["n2"] });
    // web runs on c and on extra server x; postgres on p. x shares nothing with p.
    expect(reachesPrivately(m, ["c"], { serverId: "p", servers: ["p"] })).toBe(true);
    expect(reachesPrivately(m, ["c", "x"], { serverId: "p", servers: ["p"] })).toBe(false);
    // A replica of the provider on the consumer's server is reached there directly.
    expect(reachesPrivately(new Map(), ["x"], { serverId: "p", servers: ["p", "x"] })).toBe(true);
  });
});

describe("private network planning", () => {
  it("runs a database's replica on another server: each side reaches the other by name", () => {
    // pg on a, its pooler on a, replica 2 on b (as the plan lists them).
    const pg = svc("pg", { kind: "database" });
    const pooler = svc("pg~pooler", { slug: "pg-pooler", hostname: "pg-pooler", kind: "pooler", container: "pg" });
    const replica = svc("pg~replica-2", { serverId: "b", slug: "pg-replica-2", hostname: "pg-replica", kind: "replica-2", container: "pg" });
    const services = [pg, pooler, replica];
    const needs = neededAddresses([A, B], services);
    expect(needs.map((n) => `${n.serverId} ${n.key}`).sort()).toEqual(["a env:env1", "a svc:pg", "a svc:pg~pooler", "b env:env1", "b svc:pg~replica-2"]);
    const addresses: PlanAddress[] = [
      { serverId: "a", key: serviceKey("pg"), ip: "10.240.1.1" },
      { serverId: "a", key: serviceKey("pg~pooler"), ip: "10.240.1.2" },
      { serverId: "b", key: serviceKey("pg~replica-2"), ip: "10.240.1.3" },
      { serverId: "a", key: environmentKey("env1"), ip: "10.241.1.2" },
      { serverId: "b", key: environmentKey("env1"), ip: "10.241.2.2" },
    ];
    const cfgA = agentConfig({ ...A, privateKey: "k" }, [A, B], services, addresses, needs);
    // The database's address leads to the database container only, the pooler's to the pooler.
    expect(cfgA.exposures.map((e) => `${e.ip} ${e.service} ${e.kind}`)).toEqual(["10.240.1.1 pg database", "10.240.1.2 pg pooler"]);
    // Apps on a read from the replica on b by its own name and the shared read name.
    expect(cfgA.imports).toEqual([{ name: "serve-link-10-240-1-3", ip: "10.240.1.3", network: "serve-env-env1", aliases: ["pg-replica-2", "pg-replica"] }]);
    const cfgB = agentConfig({ ...B, privateKey: "k" }, [A, B], services, addresses, needs);
    expect(cfgB.exposures.map((e) => `${e.ip} ${e.service} ${e.kind}`)).toEqual(["10.240.1.3 pg replica-2"]);
    // The replica on b copies from the database by its name, and the pooler is there too.
    expect(cfgB.imports.map((i) => i.aliases)).toEqual([["pg"], ["pg-pooler"]]);
  });

  it("only wires environments that span two servers of the network", () => {
    expect(neededAddresses([A, B], [svc("db"), svc("app", { type: "app" })])).toEqual([]);
    // The app's server is not in the network: nothing to connect.
    expect(neededAddresses([A], [svc("db"), svc("app", { type: "app", serverId: "b" })])).toEqual([]);
    const needs = neededAddresses([A, B], [svc("db"), svc("app", { type: "app", serverId: "b" })]);
    expect(needs.map((n) => `${n.serverId} ${n.key}`).sort()).toEqual(["a env:env1", "a svc:db", "b env:env1", "b svc:app"]);
  });

  it("counts extra servers of an app and gives each compose service its own address", () => {
    const needs = neededAddresses(
      [A, B, C],
      [
        svc("app", { type: "app", extraServerIds: ["c"] }),
        svc("stack", { type: "compose", serverId: "b", composeServices: ["web", "worker"] }),
        svc("iso", { type: "compose", serverId: "b", composeServices: ["x"], isolated: true }),
      ],
    );
    const keys = needs.map((n) => `${n.serverId} ${n.key}`).sort();
    // The app's copy on its extra server gets an address of its own there (load balancing from a).
    expect(keys).toEqual(["a env:env1", "a svc:app", "b env:env1", "b svc:stack:web", "b svc:stack:worker", "c env:env1", "c lb:app:c"]);
  });

  it("keeps service addresses when they move and forgets only what is gone", () => {
    const addresses: PlanAddress[] = [
      { serverId: "a", key: serviceKey("db"), ip: "10.240.1.1" },
      { serverId: "a", key: serviceKey("moved"), ip: "10.240.1.2" },
      { serverId: "b", key: serviceKey("stack", "gone"), ip: "10.240.1.3" },
      { serverId: "b", key: serviceKey("stack", "web"), ip: "10.240.1.4" },
      { serverId: "a", key: serviceKey("deleted"), ip: "10.240.1.5" },
      { serverId: "a", key: environmentKey("env1"), ip: "10.241.1.2" },
    ];
    const services = [svc("db"), svc("moved", { serverId: "b" }), svc("stack", { type: "compose", serverId: "b", composeServices: ["web"] })];
    const { remove, move } = addressChanges(addresses, services);
    expect(remove.map((a) => a.ip)).toEqual(["10.240.1.3", "10.240.1.5"]);
    expect(move.map((m) => [m.address.ip, m.serverId])).toEqual([["10.240.1.2", "b"]]);
  });

  it("hands out service addresses from one pool and environment addresses per server", () => {
    expect(allocateAddress(7, "svc", new Set())).toBe("10.240.1.1");
    expect(allocateAddress(7, "svc", new Set(["10.240.1.1"]))).toBe("10.240.1.2");
    expect(allocateAddress(7, "svc", new Set(Array.from({ length: 254 }, (_, i) => `10.240.1.${i + 1}`)))).toBe("10.240.2.1");
    expect(allocateAddress(7, "env", new Set())).toBe("10.241.7.2");
    const full = new Set(Array.from({ length: 253 }, (_, i) => `10.241.7.${i + 2}`));
    expect(allocateAddress(7, "env", full)).toBeNull();
  });

  const services = [svc("db"), svc("app", { type: "app", serverId: "b", currentDeploymentId: "dep9" }), svc("other", { environmentId: "env2", serverId: "b" })];
  const addresses: PlanAddress[] = [
    { serverId: "a", key: serviceKey("db"), ip: "10.240.1.1" },
    { serverId: "a", key: environmentKey("env1"), ip: "10.241.1.2" },
    { serverId: "b", key: serviceKey("app"), ip: "10.240.1.2" },
    { serverId: "b", key: environmentKey("env1"), ip: "10.241.2.2" },
    // Kept from before, not needed now: not configured anywhere.
    { serverId: "b", key: serviceKey("other"), ip: "10.240.1.9" },
  ];

  it("lets only the same environment on other servers reach an exposed service", () => {
    const needs = neededAddresses([A, B], services);
    const cfg = agentConfig({ ...A, privateKey: "priv-a" }, [A, B], services, addresses, needs);
    expect(cfg.address).toBe("10.241.1.1");
    // Routes to B's own range and to the services of its environments there, nothing else.
    expect(cfg.peers).toEqual([{ serverId: "b", publicKey: "pub-b", endpoint: "10.0.0.2:51820", allowedIps: ["10.241.2.0/24", "10.240.1.2/32"] }]);
    expect(cfg.exposures).toEqual([{ ip: "10.240.1.1", service: "db", kind: null, compose: null, deployment: null, network: "serve-env-env1", allow: ["10.241.2.2"] }]);
    expect(cfg.sources).toEqual([{ ip: "10.241.1.2", networks: ["serve-env-env1"], subnets: [] }]);
    expect(cfg.localAddresses).toEqual(["10.240.1.1", "10.241.1.2"]);
    const cfgB = agentConfig({ ...B, privateKey: "priv-b" }, [A, B], services, addresses, needs);
    // Apps only forward to containers of their live deployment.
    expect(cfgB.exposures).toEqual([{ ip: "10.240.1.2", service: "app", kind: null, compose: null, deployment: "dep9", network: "serve-env-env1", allow: ["10.241.1.2"] }]);
    expect(cfgB.localAddresses).not.toContain("10.240.1.9");
    expect(cfgB.peers[0].allowedIps).toEqual(["10.241.1.0/24", "10.240.1.1/32"]);
  });

  it("changes the configuration hash only when something changes", () => {
    const needs = neededAddresses([A, B], services);
    const one = agentConfig({ ...A, privateKey: "k" }, [A, B], services, addresses, needs);
    const two = agentConfig({ ...A, privateKey: "k" }, [A, B], services, addresses, needs);
    expect(one.hash).toBe(two.hash);
    const moved = agentConfig({ ...A, privateKey: "k" }, [A, { ...B, endpoint: "198.51.100.4" }], services, addresses, needs);
    expect(moved.hash).not.toBe(one.hash);
    expect(moved.peers[0].endpoint).toBe("198.51.100.4:51820");
  });

  it("answers to the names of services on other servers with link containers", () => {
    const list = [
      svc("db", { hostname: "maindb" }),
      svc("app", { type: "app", serverId: "b" }),
      svc("stack", { type: "compose", serverId: "b", slug: "shop-ab12", composeServices: ["web"] }),
      svc("replicated", { type: "app", serverId: "b", extraServerIds: ["a"] }),
    ];
    const addrs: PlanAddress[] = [
      { serverId: "a", key: serviceKey("db"), ip: "10.240.1.2" },
      { serverId: "a", key: environmentKey("env1"), ip: "10.241.1.2" },
      { serverId: "b", key: serviceKey("app"), ip: "10.240.2.2" },
      { serverId: "b", key: serviceKey("stack", "web"), ip: "10.240.2.3" },
      { serverId: "b", key: serviceKey("replicated"), ip: "10.240.2.4" },
      { serverId: "b", key: environmentKey("env1"), ip: "10.241.2.2" },
    ];
    const needs = neededAddresses([A, B], list);
    const onA = agentConfig({ ...A, privateKey: "" }, [A, B], list, addrs, needs).imports;
    // "replicated" also runs on A, so A reaches it directly.
    expect(onA).toEqual([
      { name: "serve-link-10-240-2-2", ip: "10.240.2.2", network: "serve-env-env1", aliases: ["app"] },
      { name: "serve-link-10-240-2-3", ip: "10.240.2.3", network: "serve-env-env1", aliases: ["shop-ab12-web"] },
    ]);
    const onB = agentConfig({ ...B, privateKey: "" }, [A, B], list, addrs, needs).imports;
    expect(onB).toEqual([{ name: "serve-link-10-240-1-2", ip: "10.240.1.2", network: "serve-env-env1", aliases: ["db", "maindb"] }]);
  });
});

describe("private network helpers", () => {
  it("checks the address other servers use", () => {
    expect(meshEndpointProblem("203.0.113.10")).toBeNull();
    expect(meshEndpointProblem("node-1.example.com")).toBeNull();
    expect(meshEndpointProblem("2001:db8::1")).toBeNull();
    expect(meshEndpointProblem("")).toMatch(/Enter/);
    expect(meshEndpointProblem("127.0.0.1")).toMatch(/only works on the server/);
    expect(meshEndpointProblem("localhost")).toMatch(/only works on the server/);
    expect(meshEndpointProblem("1.2.3.4:51820")).toMatch(/without a port/);
    expect(meshEndpoint("2001:db8::1", 51820)).toBe("[2001:db8::1]:51820");
  });

  it("makes WireGuard keys", () => {
    const { publicKey, privateKey } = generateMeshKeys();
    expect(Buffer.from(publicKey, "base64")).toHaveLength(32);
    expect(Buffer.from(privateKey, "base64")).toHaveLength(32);
    // The public key belongs to the private key.
    const priv = createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: Buffer.from(privateKey, "base64").toString("base64url"), x: "" }, format: "jwk" });
    expect(Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x ?? "", "base64url").toString("base64")).toBe(publicKey);
  });

  it("describes handshake age", () => {
    expect(handshakeAge(0)).toBeNull();
    expect(handshakeAge(100, 112)).toBe("12s ago");
    expect(handshakeAge(100, 100 + 3 * 60)).toBe("3m ago");
  });
});

/** The agent's jq programs, run with the real jq (as the agent does). */
describe.runIf(!!process.env.PATH && fs.existsSync("/usr/bin/jq"))("private network agent rules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-mesh-test-"));
  const write = (name: string, value: unknown) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  const config = {
    privateKey: "cHJpdg==",
    listenPort: 51820,
    peers: [
      { publicKey: "pb", endpoint: "10.0.0.2:51820", allowedIps: ["10.240.2.0/24", "10.241.2.0/24"] },
      { publicKey: "pc", endpoint: null, allowedIps: ["10.240.3.0/24", "10.241.3.0/24"] },
    ],
    exposures: [
      { ip: "10.240.1.2", service: "app", compose: null, deployment: "new", network: "serve-env-e", allow: ["10.241.2.1", "10.241.3.1"] },
      { ip: "10.240.1.3", service: "stack", compose: "web", deployment: null, network: "serve-env-e", allow: ["10.241.2.1"] },
      { ip: "10.240.1.4", service: "gone", compose: null, deployment: null, network: "serve-env-e", allow: ["10.241.2.1"] },
    ],
    sources: [{ ip: "10.241.1.1", networks: ["serve-env-e"], subnets: ["10.210.4.0/24"] }],
  };
  const container = (service: string, ip: string, labels: Record<string, string> = {}) => ({
    Labels: { "serve.service": service, ...labels },
    NetworkSettings: { Networks: { "serve-env-e": { IPAddress: ip } } },
  });
  const containers = [
    container("app", "172.20.0.5", { "serve.deployment": "new" }),
    container("app", "172.20.0.6", { "serve.deployment": "new" }),
    container("app", "172.20.0.7", { "serve.deployment": "old" }),
    container("app", "172.20.0.8", { "serve.deployment": "new", "serve.kind": "predeploy" }),
    container("stack", "172.20.0.9", { "com.docker.compose.service": "web" }),
    container("stack", "172.20.0.10", { "com.docker.compose.service": "db" }),
  ];
  const cfg = write("config.json", config);
  const rules = write("rules.jq", RULES_JQ);
  const wg = write("wg.jq", WG_JQ);
  const run = (list: unknown) =>
    execFileSync(
      "jq",
      [
        "-r",
        "--arg",
        "if",
        "serve-mesh",
        "--slurpfile",
        "c",
        write("c.json", list),
        "--slurpfile",
        "nets",
        write("nets.json", { "serve-env-e": ["172.20.0.0/16"] }),
        "-f",
        rules,
        cfg,
      ],
      {
        encoding: "utf8",
      },
    );

  it("forwards to live containers only, spread across replicas", () => {
    const out = run(containers);
    expect(out).toContain("-A SERVE-MESH-PRE -i serve-mesh -d 10.240.1.2/32 -m statistic --mode random --probability 0.5 -j DNAT --to-destination 172.20.0.5");
    expect(out).toContain("-A SERVE-MESH-PRE -i serve-mesh -d 10.240.1.2/32 -j DNAT --to-destination 172.20.0.6");
    expect(out).not.toContain("172.20.0.7");
    expect(out).not.toContain("172.20.0.8");
    expect(out).toContain("-d 10.240.1.3/32 -j DNAT --to-destination 172.20.0.9");
    expect(out).not.toContain("172.20.0.10");
    expect(out).not.toContain("10.240.1.4/32 -j DNAT");
  });

  it("rewrites outgoing sources per environment and allows only listed sources in", () => {
    const out = run(containers);
    expect(out).toContain("-A SERVE-MESH-POST -o serve-mesh -s 172.20.0.0/16 -j SNAT --to-source 10.241.1.1");
    expect(out).toContain("-A SERVE-MESH-POST -o serve-mesh -s 10.210.4.0/24 -j SNAT --to-source 10.241.1.1");
    expect(out).toContain("-A SERVE-MESH-FWD -i serve-mesh -s 10.241.3.1/32 -m conntrack --ctorigdst 10.240.1.2/32 -j ACCEPT");
    expect(out).not.toContain("-s 10.241.3.1/32 -m conntrack --ctorigdst 10.240.1.3/32");
    const lines = out.split("\n");
    // The drop comes after every allow.
    expect(lines.indexOf("-A SERVE-MESH-FWD -i serve-mesh -j DROP")).toBeGreaterThan(lines.findLastIndex((l) => l.includes("--ctorigdst")));
    expect(out).toContain("-A SERVE-MESH-IN -p udp --dport 51820 -j ACCEPT");
    expect(out.match(/^COMMIT$/gm)).toHaveLength(3);
  });

  it("sends a database's address to the database only, and its pooler and replicas to theirs", () => {
    const withDb = write("db.json", {
      ...config,
      exposures: [
        { ip: "10.240.1.5", service: "pg", kind: "database", compose: null, deployment: null, network: "serve-env-e", allow: [] },
        { ip: "10.240.1.6", service: "pg", kind: "pooler", compose: null, deployment: null, network: "serve-env-e", allow: [] },
        { ip: "10.240.1.7", service: "pg", kind: "replica-2", compose: null, deployment: null, network: "serve-env-e", allow: [] },
      ],
    });
    const list = [
      container("pg", "172.20.0.20", { "serve.kind": "database" }),
      container("pg", "172.20.0.21", { "serve.kind": "pooler" }),
      container("pg", "172.20.0.22", { "serve.kind": "replica-2" }),
    ];
    const out = execFileSync(
      "jq",
      [
        "-r",
        "--arg",
        "if",
        "serve-mesh",
        "--slurpfile",
        "c",
        write("c2.json", list),
        "--slurpfile",
        "nets",
        write("n2.json", { "serve-env-e": ["172.20.0.0/16"] }),
        "-f",
        rules,
        withDb,
      ],
      { encoding: "utf8" },
    );
    expect(out).toContain("-d 10.240.1.5/32 -j DNAT --to-destination 172.20.0.20");
    expect(out).toContain("-d 10.240.1.6/32 -j DNAT --to-destination 172.20.0.21");
    expect(out).toContain("-d 10.240.1.7/32 -j DNAT --to-destination 172.20.0.22");
    expect(out.match(/-d 10\.240\.1\.5\/32/g)).toHaveLength(1);
  });

  it("falls back to every container of the service before its first deployment finished", () => {
    const out = run([container("app", "172.20.0.11", { "serve.deployment": "other" })]);
    expect(out).not.toContain("172.20.0.11");
    const noLabel = run([container("app", "172.20.0.12")]);
    expect(noLabel).toContain("--to-destination 172.20.0.12");
  });

  it("describes the link containers to run", () => {
    const withImports = write("imports.json", {
      ...config,
      imports: [{ name: "serve-link-10-240-1-2", ip: "10.240.1.2", network: "serve-env-e", aliases: ["db", "maindb"] }],
    });
    const out = execFileSync("jq", ["-c", "--arg", "img", "serve-mesh:abc", "-f", write("links.jq", LINKS_JQ), withImports], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("serve-link-10-240-1-2");
    expect(out[0].spec).toBe("10.240.1.2|serve-env-e|db,maindb|serve-mesh:abc");
    expect(out[0].body.Cmd).toEqual(["link", "10.240.1.2"]);
    expect(out[0].body.HostConfig.NetworkMode).toBe("serve-env-e");
    expect(out[0].body.NetworkingConfig.EndpointsConfig["serve-env-e"].Aliases).toEqual(["db", "maindb"]);
    expect(out[0].body.Labels["serve.mesh-link"]).toBe(out[0].spec);
  });

  it("writes the WireGuard configuration", () => {
    const out = execFileSync("jq", ["-r", "-f", wg, cfg], { encoding: "utf8" });
    expect(out).toContain("[Interface]\nPrivateKey = cHJpdg==\nListenPort = 51820");
    expect(out).toContain("[Peer]\nPublicKey = pb\nAllowedIPs = 10.240.2.0/24, 10.241.2.0/24\nEndpoint = 10.0.0.2:51820\nPersistentKeepalive = 25");
    expect(out).toContain("[Peer]\nPublicKey = pc\nAllowedIPs = 10.240.3.0/24, 10.241.3.0/24\nPersistentKeepalive = 25");
  });
});

describe("what a private network change breaks", () => {
  const before = members({ a: ["n1"], b: ["n1", "n2"], c: ["n2"] });
  const on = (id: string, name: string, slug: string, serverId: string, environmentId = "e1"): ImpactService => ({
    id,
    name,
    slug,
    serverId,
    servers: [serverId],
    environmentId,
    projectId: "p",
  });
  const services: ImpactService[] = [
    on("pg", "Postgres", "postgres-ab12", "a"),
    on("api", "api", "api-cd34", "b"),
    on("web", "web", "web-ef56", "c"),
    on("other", "Postgres", "postgres-zz99", "a", "e2"),
  ];
  const noShared = () => () => undefined;
  const vars: ImpactVar[] = [
    { serviceId: "api", key: "DATABASE_URL", value: "${{postgres.DATABASE_URL}}" },
    { serviceId: "api", key: "DB_HOST", value: "${{ postgres-ab12.HOST }}:${{postgres.PORT}}" },
    // Public values keep working without the private network.
    { serviceId: "api", key: "SITE", value: "${{postgres.SERVE_PUBLIC_URL}}" },
    { serviceId: "web", key: "API", value: "http://${{api.SERVE_PRIVATE_DOMAIN}}" },
  ];

  it("works out memberships after each kind of change", () => {
    expect(membersAfter(before, { kind: "remove", networkId: "n1", serverId: "b" }).get("b")?.networks).toEqual(["n2"]);
    expect(membersAfter(before, { kind: "delete", networkId: "n2" }).get("c")?.networks).toEqual([]);
    expect(membersAfter(before, { kind: "leave", serverId: "a" }).has("a")).toBe(false);
    // The original is left alone.
    expect(before.get("b")?.networks).toEqual(["n1", "n2"]);
  });

  it("lists services that use a private name across a link that goes away", () => {
    const after = membersAfter(before, { kind: "remove", networkId: "n1", serverId: "b" });
    expect(lostLinks(before, after, services, vars, noShared)).toEqual([{ consumerId: "api", providerId: "pg", variables: ["DATABASE_URL", "DB_HOST"] }]);
    const gone = membersAfter(before, { kind: "delete", networkId: "n2" });
    expect(lostLinks(before, gone, services, vars, noShared)).toEqual([{ consumerId: "web", providerId: "api", variables: ["API"] }]);
  });

  it("finds nothing when the servers still share another network or nothing uses the link", () => {
    const twice = members({ a: ["n1", "n3"], b: ["n1", "n3"] });
    expect(lostLinks(twice, membersAfter(twice, { kind: "delete", networkId: "n1" }), services, vars, noShared)).toEqual([]);
    // c leaving breaks nothing: nothing uses a service on c.
    expect(lostLinks(before, membersAfter(before, { kind: "leave", serverId: "c" }), services, vars.slice(0, 3), noShared)).toEqual([]);
    // Same server: never affected.
    const local: ImpactVar[] = [{ serviceId: "other", key: "X", value: "${{postgres.HOST}}" }];
    expect(lostLinks(before, membersAfter(before, { kind: "leave", serverId: "a" }), services, local, noShared)).toEqual([]);
  });

  it("follows references through the service's own and shared variables", () => {
    const after = membersAfter(before, { kind: "remove", networkId: "n1", serverId: "b" });
    const viaShared: ImpactVar[] = [{ serviceId: "api", key: "DB", value: "${{environment.DB_URL}}" }];
    const scope = () => (sc: string, key: string) => (sc === "environment" && key === "DB_URL" ? "${{postgres.DATABASE_URL}}" : undefined);
    expect(lostLinks(before, after, services, viaShared, scope)).toEqual([{ consumerId: "api", providerId: "pg", variables: ["DB"] }]);
    const viaOwn: ImpactVar[] = [
      { serviceId: "api", key: "RAW", value: "${{postgres.HOST}}" },
      { serviceId: "api", key: "URL", value: "pg://${{RAW}}" },
    ];
    expect(lostLinks(before, after, services, viaOwn, noShared)).toEqual([{ consumerId: "api", providerId: "pg", variables: ["RAW", "URL"] }]);
  });

  it("warns when switching to no public address cuts off another server without one", () => {
    const m = members({ home: { networks: ["n1"], nat: true }, pc: ["n1"] });
    const list = [on("pg", "postgres", "pg-1", "home"), on("app", "app", "app-1", "pc")];
    const vars: ImpactVar[] = [{ serviceId: "app", key: "DATABASE_URL", value: "${{postgres.DATABASE_URL}}" }];
    expect(lostLinks(m, membersAfter(m, { kind: "nat", serverId: "pc" }), list, vars, noShared)).toEqual([{ consumerId: "app", providerId: "pg", variables: ["DATABASE_URL"] }]);
    // A server with a public address in between keeps things working.
    const withVps = members({ home: { networks: ["n1"], nat: true }, pc: ["n1"], vps: ["n1"] });
    expect(lostLinks(withVps, membersAfter(withVps, { kind: "nat", serverId: "vps" }), list, vars, noShared)).toHaveLength(0);
  });

  it("follows ${{KEY}} to an environment shared variable when the service has no such variable", () => {
    const after = membersAfter(before, { kind: "remove", networkId: "n1", serverId: "b" });
    const vars: ImpactVar[] = [{ serviceId: "api", key: "DATABASE_URL", value: "${{DB}}" }];
    const scope = () => (sc: string, key: string) => (sc === "environment" && key === "DB" ? "${{postgres.DATABASE_URL}}" : undefined);
    expect(lostLinks(before, after, services, vars, scope)).toEqual([{ consumerId: "api", providerId: "pg", variables: ["DATABASE_URL"] }]);
  });

  it("does not take scope names for services", () => {
    const after = membersAfter(before, { kind: "remove", networkId: "n1", serverId: "b" });
    const list = [...services, on("sh", "shared", "shared-aa11", "a")];
    const vars: ImpactVar[] = [{ serviceId: "api", key: "X", value: "${{shared.HOST}}" }];
    expect(lostLinks(before, after, list, vars, noShared)).toEqual([]);
  });

  it("counts extra servers: losing the link from one of them breaks the use", () => {
    const m = members({ a: ["n1"], b: ["n1"], x: ["n2"], y: ["n2"] });
    const list = [on("pg", "postgres", "pg-1", "a"), { ...on("app", "app", "app-1", "b"), servers: ["b", "x"] }];
    const vars: ImpactVar[] = [{ serviceId: "app", key: "DATABASE_URL", value: "${{postgres.DATABASE_URL}}" }];
    // Today app on x cannot reach a anyway: nothing to lose.
    expect(lostLinks(m, membersAfter(m, { kind: "remove", networkId: "n1", serverId: "b" }), list, vars, noShared)).toEqual([]);
    const both = members({ a: ["n1", "n2"], b: ["n1"], x: ["n2"] });
    expect(lostLinks(both, membersAfter(both, { kind: "remove", networkId: "n2", serverId: "x" }), list, vars, noShared)).toEqual([
      { consumerId: "app", providerId: "pg", variables: ["DATABASE_URL"] },
    ]);
  });
});

describe("servers behind NAT", () => {
  it("links two servers only when one of them has a public address", async () => {
    const { linked } = await import("@/server/mesh/plan");
    const server = (id: string, endpoint: string | null) => ({ id, endpoint, networks: ["n1"] });
    expect(linked(server("a", null), server("b", null))).toBe(false);
    expect(linked(server("a", null), server("b", "203.0.113.5"))).toBe(true);
    expect(linked(server("a", "198.51.100.1"), server("b", "203.0.113.5"))).toBe(true);
  });
});
