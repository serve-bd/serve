import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.SERVE_ENCRYPTION_KEY ??= "test-key-for-tailscale";

/** What the code wrote to the database (the API is the part under test). */
const writes: Record<string, unknown>[] = [];

vi.mock("@/server/db", async () => {
  const schema = await import("@/server/db/schema");
  const chain = {
    set: (values: Record<string, unknown>) => ({
      where: () => {
        writes.push(values);
        return Object.assign(Promise.resolve([{ id: "s1" }]), { returning: async () => [{ id: "s1" }] });
      },
    }),
  };
  return { db: { update: () => chain, select: () => ({ from: () => ({ where: async () => [] }) }) }, schema };
});

import { encrypt } from "@/server/crypto";
import { authKeyRequest, deviceOnline, oauthToken, TAILSCALE_API, TailscaleError, tailnetHostname, tailnetIpv4, tailscaleClient } from "@/server/tailscale/api";
import { clientFor, tailnetRoute, type TailnetRow } from "@/server/tailscale";
import { JoinRefused, prepareKey } from "@/server/tailscale/join";
import { joinScript, parseProbe, PROBE_SCRIPT, RESUME_SCRIPT, realNodeKey, upScript } from "@/server/tailscale/script";
import { agentConfig, linked, peerEndpoint, type PlanServer, privatelyConnected } from "@/server/mesh/plan";
import { MESH_MTU, MESH_TAILNET_MTU } from "@/lib/mesh";

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a list, and records every request. */
function fakeFetch(answers: (call: Call) => Response) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answers(call);
  });
  return { f: f as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const device = (over: Record<string, unknown> = {}) => ({
  id: "dev1",
  name: "serve-web.tail1234.ts.net",
  hostname: "serve-web",
  addresses: ["100.101.102.103", "fd7a:115c:a1e0::1"],
  nodeKey: "nodekey:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  lastSeen: "2026-10-04T10:00:00Z",
  connectedToControl: true,
  ...over,
});

const tailnetRow = (over: Partial<TailnetRow> = {}): TailnetRow => ({
  id: "t1",
  name: "Home",
  tailnet: "-",
  authType: "oauth",
  clientId: "client-1",
  secret: encrypt("tskey-client-secret"),
  accessToken: encrypt("cached-token"),
  tokenExpiresAt: new Date(Date.now() + 30 * 60_000),
  tag: "tag:serve",
  dnsSuffix: null,
  error: null,
  checkedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  writes.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Tailscale API", () => {
  it("asks for a single-use, pre-authorized key with the tag", async () => {
    const { f, calls } = fakeFetch(() => json({ id: "k1", key: "tskey-auth-k1", expires: "2026-10-04T11:00:00Z" }));
    const client = tailscaleClient({ tailnet: "example.com", renewable: false, token: async () => "tok", fetch: f });
    const key = await client.createAuthKey({ tags: ["tag:serve"], description: "Serve web/1 (prod)!", expirySeconds: 3600 });
    expect(key.key).toBe("tskey-auth-k1");
    expect(calls[0].url).toBe(`${TAILSCALE_API}/tailnet/example.com/keys`);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: ["tag:serve"] } } },
      expirySeconds: 3600,
      description: "Serve web-1 -prod-",
    });
  });

  it("keeps key descriptions to what Tailscale accepts", () => {
    expect(authKeyRequest({ tags: [], description: "x".repeat(80), expirySeconds: 60 }).description).toHaveLength(50);
    expect(authKeyRequest({ tags: [], description: "???", expirySeconds: 60 }).description).toBe("-");
    expect(authKeyRequest({ tags: [], description: "", expirySeconds: 60 }).description).toBe("Serve");
  });

  it("gets a new OAuth access token when the cached one is refused, and tries once more", async () => {
    let n = 0;
    const { f, calls } = fakeFetch(() => (n++ === 0 ? json({ message: "invalid token" }, 401) : json({ devices: [device()] })));
    const token = vi.fn(async (renew: boolean) => (renew ? "fresh" : "stale"));
    const client = tailscaleClient({ tailnet: "-", renewable: true, token, fetch: f });
    const devices = await client.devices();
    expect(devices).toHaveLength(1);
    expect(token.mock.calls).toEqual([[false], [true]]);
    expect(calls.map((c) => (c.init.headers as Record<string, string>).authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(calls[0].url).toBe(`${TAILSCALE_API}/tailnet/-/devices?fields=all`);
  });

  it("does not retry an API key, and says it expired or was revoked", async () => {
    const { f, calls } = fakeFetch(() => json({ message: "API token invalid" }, 401));
    const client = tailscaleClient({ tailnet: "-", renewable: false, token: async () => "tskey-api-x", fetch: f });
    const error = await client.devices().catch((e) => e);
    expect(error).toBeInstanceOf(TailscaleError);
    expect(error.status).toBe(401);
    expect(error.message).toContain("API token invalid");
    expect(error.message).toContain("expired or was revoked");
    expect(calls).toHaveLength(1);
  });

  it("shows Tailscale's own reason for a refused key, with a hint about scopes", async () => {
    const { f } = fakeFetch(() => json({ message: "requested tags [tag:serve] are invalid or not permitted" }, 403));
    const client = tailscaleClient({ tailnet: "-", renewable: true, token: async () => "t", fetch: f });
    const error = await client.createAuthKey({ tags: ["tag:serve"], description: "x", expirySeconds: 60 }).catch((e) => e);
    expect(error.message).toContain("requested tags [tag:serve] are invalid or not permitted");
    expect(error.message).toContain("auth_keys and devices:core");
  });

  it("treats a missing device or key as gone", async () => {
    const { f } = fakeFetch(() => json({ message: "not found" }, 404));
    const client = tailscaleClient({ tailnet: "-", renewable: false, token: async () => "t", fetch: f });
    expect(await client.device("x")).toBeNull();
    await expect(client.deleteKey("k")).resolves.toBeUndefined();
    await expect(client.deleteDevice("d")).resolves.toBeUndefined();
  });

  it("signs an OAuth client in with client credentials", async () => {
    const { f, calls } = fakeFetch(() => json({ access_token: "at", token_type: "Bearer", expires_in: 3600 }));
    const before = Date.now();
    const t = await oauthToken("cid", "csecret", f);
    expect(t.token).toBe("at");
    expect(t.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3599_000);
    expect(calls[0].url).toBe(`${TAILSCALE_API}/oauth/token`);
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("csecret");
    expect(body.get("grant_type")).toBe("client_credentials");
  });

  it("explains a refused OAuth client", async () => {
    const { f } = fakeFetch(() => json({ message: "invalid client credentials" }, 401));
    const error = await oauthToken("cid", "bad", f).catch((e) => e);
    expect(error.message).toContain("invalid client credentials");
    expect(error.message).toContain("Check the client id and secret");
  });

  it("reads addresses and online state of a device", () => {
    expect(tailnetIpv4(device())).toBe("100.101.102.103");
    expect(tailnetIpv4({ addresses: ["10.0.0.1", "fd7a::1"] })).toBeNull();
    expect(deviceOnline({ connectedToControl: false, lastSeen: new Date().toISOString() })).toBe(false);
    expect(deviceOnline({ lastSeen: new Date(Date.now() - 60_000).toISOString() })).toBe(true);
    expect(deviceOnline({ lastSeen: new Date(Date.now() - 3600_000).toISOString() })).toBe(false);
  });

  it("picks a free host name in the tailnet", () => {
    expect(tailnetHostname("Web 1", [])).toBe("serve-web-1");
    const taken = [device({ hostname: "serve-web-1", name: "serve-web-1.tail.ts.net", nodeKey: "nodekey:other" })];
    expect(tailnetHostname("Web 1", taken)).toBe("serve-web-1-2");
    // The machine's own device does not count as a clash (the command runs again).
    expect(tailnetHostname("Web 1", taken, "nodekey:other")).toBe("serve-web-1");
  });
});

describe("OAuth access token", () => {
  it("uses the cached token while it is valid", async () => {
    const { f, calls } = fakeFetch(() => json({ devices: [] }));
    await clientFor(tailnetRow(), f).devices();
    expect(calls.map((c) => c.url)).toEqual([`${TAILSCALE_API}/tailnet/-/devices?fields=all`]);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer cached-token");
  });

  it("fetches and stores (encrypted) a new one when it ran out", async () => {
    const { f, calls } = fakeFetch((c) => (c.url.endsWith("/oauth/token") ? json({ access_token: "new-token", expires_in: 3600 }) : json({ devices: [] })));
    await clientFor(tailnetRow({ tokenExpiresAt: new Date(Date.now() - 1000) }), f).devices();
    expect(calls.map((c) => c.url.replace(TAILSCALE_API, ""))).toEqual(["/oauth/token", "/tailnet/-/devices?fields=all"]);
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer new-token");
    const saved = writes.find((w) => "accessToken" in w)!;
    expect(String(saved.accessToken)).toMatch(/^v1:/);
    expect(saved.accessToken).not.toContain("new-token");
  });

  it("an API key is sent as it is", async () => {
    const { f, calls } = fakeFetch(() => json({ devices: [] }));
    await clientFor(tailnetRow({ authType: "apikey", clientId: null, secret: encrypt("tskey-api-abc"), accessToken: null }), f).devices();
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tskey-api-abc");
  });
});

describe("joining", () => {
  const row = { id: "s1", name: "Web", tailscale: null };

  it("makes a key with the tag and a free host name", async () => {
    const { f, calls } = fakeFetch((c) =>
      c.url.endsWith("/keys") ? json({ id: "k9", key: "tskey-auth-9" }) : json({ devices: [device({ hostname: "serve-web", nodeKey: "nodekey:bbbbbbbbbbbbbbbbbbbb" })] }),
    );
    vi.stubGlobal("fetch", f);
    const plan = await prepareKey(row, tailnetRow({ tag: "tag:edge" }), { state: "NeedsLogin", nodeKey: null, suffix: null }, false);
    expect(plan).toEqual({ already: false, hostname: "serve-web-2", authKey: "tskey-auth-9", reauth: false });
    const keyCall = calls.find((c) => c.url.endsWith("/keys"))!;
    expect(JSON.parse(String(keyCall.init.body)).capabilities.devices.create.tags).toEqual(["tag:edge"]);
  });

  it("needs no key for a machine already in the tailnet (the command ran twice)", async () => {
    const { f, calls } = fakeFetch(() => json({ devices: [device()] }));
    vi.stubGlobal("fetch", f);
    const plan = await prepareKey(row, tailnetRow(), { state: "Running", nodeKey: "nodekey:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", suffix: "tail1234.ts.net" }, false);
    expect(plan).toEqual({ already: true, hostname: "serve-web" });
    expect(calls.some((c) => c.url.endsWith("/keys"))).toBe(false);
  });

  it("does not move a machine out of another tailnet unless asked", async () => {
    const { f } = fakeFetch((c) => (c.url.endsWith("/keys") ? json({ id: "k", key: "tskey-auth-k" }) : json({ devices: [device()] })));
    vi.stubGlobal("fetch", f);
    const probe = { state: "Running", nodeKey: "nodekey:cccccccccccccccccccccccc", suffix: "other.ts.net" };
    const refused = await prepareKey(row, tailnetRow(), probe, false).catch((e) => e);
    expect(refused).toBeInstanceOf(JoinRefused);
    expect(refused.message).toContain("already in another tailnet (other.ts.net)");
    expect(refused.message).toContain("SERVE_TAILSCALE_FORCE=1");
    const moved = await prepareKey(row, tailnetRow(), probe, true);
    expect(moved).toMatchObject({ already: false, reauth: true });
  });

  it("lets a machine whose device was removed join its own tailnet again without asking", async () => {
    const { f } = fakeFetch((c) => (c.url.endsWith("/keys") ? json({ id: "k", key: "tskey-auth-k" }) : json({ devices: [] })));
    vi.stubGlobal("fetch", f);
    // Still logged in locally to the same tailnet (its MagicDNS suffix, maybe with a trailing dot), but the device is gone.
    const probe = { state: "Running", nodeKey: "nodekey:dddddddddddddddddddddddd", suffix: "Tail1234.ts.net." };
    const plan = await prepareKey(row, tailnetRow({ dnsSuffix: "tail1234.ts.net" }), probe, false);
    expect(plan).toMatchObject({ already: false, reauth: true });
  });

  it("revokes the key of an earlier run that never joined", async () => {
    const { f, calls } = fakeFetch((c) => (c.url.endsWith("/keys") ? json({ id: "k2", key: "tskey-auth-2" }) : c.init.method === "DELETE" ? json({}) : json({ devices: [] })));
    vi.stubGlobal("fetch", f);
    await prepareKey({ ...row, tailscale: { authKeyId: "k1" } as never }, tailnetRow(), { state: "NeedsLogin", nodeKey: null, suffix: null }, false);
    expect(calls.some((c) => c.init.method === "DELETE" && c.url.endsWith("/tailnet/-/keys/k1"))).toBe(true);
  });

  it("reports a key Tailscale refuses as the join's error", async () => {
    const { f } = fakeFetch((c) => (c.url.endsWith("/keys") ? json({ message: "tailnet policy does not permit tag:serve" }, 400) : json({ devices: [] })));
    vi.stubGlobal("fetch", f);
    const error = await prepareKey(row, tailnetRow(), { state: null, nodeKey: null, suffix: null }, false).catch((e) => e);
    expect(error).toBeInstanceOf(JoinRefused);
    expect(error.message).toContain("tailnet policy does not permit tag:serve");
  });
});

describe("routing over the tailnet", () => {
  const ts = (over: Record<string, unknown>) => ({ only: false, tailnetId: "t1", address: "100.64.0.9", ...over }) as never;

  it("uses the Tailscale address while the server is in a connected tailnet", () => {
    expect(tailnetRoute({ name: "a", port: 2222, tailscale: ts({}) })).toEqual({ host: "100.64.0.9", port: 2222 });
    expect(tailnetRoute({ name: "a", port: 22, tailscale: null })).toBeNull();
  });

  it("falls back to the host or tunnel when it has one", () => {
    expect(tailnetRoute({ name: "a", port: 22, tailscale: ts({ tailnetId: null }) })).toBeNull();
    expect(tailnetRoute({ name: "a", port: 22, tailscale: ts({ address: null }) })).toBeNull();
  });

  it("says why a server reached only through Tailscale cannot be reached", () => {
    expect(() => tailnetRoute({ name: "a", port: 22, tailscale: ts({ only: true, tailnetId: null }) })).toThrow(/integration was removed/);
    expect(() => tailnetRoute({ name: "a", port: 22, tailscale: ts({ only: true, address: null }) })).toThrow(/not joined the tailnet yet/);
  });
});

describe("private network over Tailscale", () => {
  const s = (id: string, index: number, endpoint: string | null, tailnet: string | null): PlanServer => ({
    id,
    index,
    endpoint,
    port: 51820,
    publicKey: `pub-${id}`,
    networks: ["n1"],
    tailnet,
  });

  it("links two servers without a public address when both are in the tailnet", () => {
    expect(linked(s("a", 1, null, null), s("b", 2, null, null))).toBe(false);
    expect(linked(s("a", 1, null, "100.64.0.1"), s("b", 2, null, null))).toBe(false);
    expect(linked(s("a", 1, null, "100.64.0.1"), s("b", 2, null, "100.64.0.2"))).toBe(true);
  });

  it("keeps the public endpoint when there is one", () => {
    expect(peerEndpoint(s("a", 1, null, "100.64.0.1"), s("b", 2, "203.0.113.2", "100.64.0.2"))).toBe("203.0.113.2");
    expect(peerEndpoint(s("a", 1, "203.0.113.1", "100.64.0.1"), s("b", 2, null, "100.64.0.2"))).toBeNull();
    expect(peerEndpoint(s("a", 1, null, "100.64.0.1"), s("b", 2, null, "100.64.0.2"))).toBe("100.64.0.2");
  });

  it("writes the Tailscale endpoint and a smaller MTU only where it is used", () => {
    const a = s("a", 1, null, "100.64.0.1");
    const b = s("b", 2, null, "100.64.0.2");
    const c = s("c", 3, "203.0.113.3", null);
    const cfg = agentConfig({ ...a, privateKey: "k" }, [a, b, c], [], [], []);
    expect(cfg.peers.map((p) => [p.serverId, p.endpoint])).toEqual([
      ["b", "100.64.0.2:51820"],
      ["c", "203.0.113.3:51820"],
    ]);
    expect(cfg.mtu).toBe(MESH_TAILNET_MTU);
    expect(agentConfig({ ...c, privateKey: "k" }, [a, b, c], [], [], []).mtu).toBe(MESH_MTU);
  });

  it("counts both-in-the-tailnet as privately connected", () => {
    const members = new Map([
      ["a", { networks: ["n1"], nat: true, tailnet: "100.64.0.1" }],
      ["b", { networks: ["n1"], nat: true, tailnet: "100.64.0.2" }],
      ["c", { networks: ["n1"], nat: true, tailnet: null }],
    ]);
    expect(privatelyConnected(members, "a", "b")).toBe(true);
    expect(privatelyConnected(members, "a", "c")).toBe(false);
  });
});

describe("scripts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-ts-"));
  const check = (shell: string, name: string, text: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    const r = spawnSync(shell, ["-n", file], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  };
  const posix = ["dash", "sh"].find((s) => spawnSync("sh", ["-c", `command -v ${s}`]).status === 0) ?? "sh";

  it("the join command's script is valid bash and carries the URL and user quoted", () => {
    const text = joinScript({ joinUrl: "https://serve.example.com/api/servers/join/tailscale/abc", user: "deploy" });
    check("bash", "join.sh", text);
    expect(text).toContain("JOIN_URL='https://serve.example.com/api/servers/join/tailscale/abc'");
    expect(text).toContain("EXPECTED_USER='deploy'");
    expect(text).toContain("https://tailscale.com/install.sh");
    // Serve's key is in place before the machine reports that it joined (setup starts then).
    expect(text.indexOf("authorized_keys")).toBeLessThan(text.indexOf("step=done"));
  });

  it("the scripts run through sh are valid POSIX shell", () => {
    check(posix, "probe.sh", PROBE_SCRIPT);
    check(posix, "resume.sh", RESUME_SCRIPT);
    const up = upScript({ authKey: "tskey-auth-it's", hostname: "serve-web", reauth: true });
    check(posix, "up.sh", up);
    expect(up).toContain("--auth-key='tskey-auth-it'\\''s'");
    expect(up).toContain("--force-reauth");
    expect(upScript({ authKey: "k", hostname: "h", reauth: false })).not.toContain("--force-reauth");
  });

  it("reads the probe", () => {
    expect(parseProbe("TS_INSTALLED=0\n")).toMatchObject({ installed: false, state: null });
    const p = parseProbe("==> x\nTS_INSTALLED=1\nTS_STATE=Running\nTS_NODEKEY=nodekey:0123456789abcdef0123\nTS_SUFFIX=tail1.ts.net\nTS_IP=100.64.0.5\n");
    expect(p).toEqual({ os: "linux", installed: true, state: "Running", nodeKey: "nodekey:0123456789abcdef0123", suffix: "tail1.ts.net", ip: "100.64.0.5" });
    expect(parseProbe("TS_OS=unsupported").os).toBe("unsupported");
    expect(realNodeKey(`nodekey:${"0".repeat(64)}`)).toBeNull();
    expect(realNodeKey("nodekey:zz")).toBeNull();
  });

  it("the probe reads a real `tailscale status --json` shape", () => {
    // A fake tailscale on PATH answering like a logged-in node.
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "tailscale"),
      `#!/bin/sh
case "$1" in
  status) printf '%s' '{"Version":"1.80.0","BackendState": "Running","Self":{"ID":"n1","PublicKey":"nodekey:abcdef0123456789abcdef","HostName":"web"},"MagicDNSSuffix":"tail9.ts.net"}' ;;
  ip) echo 100.88.1.2 ;;
esac
`,
      { mode: 0o755 },
    );
    const r = spawnSync(posix, ["-c", PROBE_SCRIPT], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    if (process.platform !== "linux") return;
    expect(parseProbe(r.stdout)).toEqual({ os: "linux", installed: true, state: "Running", nodeKey: "nodekey:abcdef0123456789abcdef", suffix: "tail9.ts.net", ip: "100.88.1.2" });
  });
});
