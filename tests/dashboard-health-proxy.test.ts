import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));

import { healthThroughProxy } from "@/server/dashboard-connection";

/** A stand-in proxy: the health page answers only for the dashboard's domain. */
const proxy = createServer((req, res) => {
  res.statusCode = req.url === "/api/health" && req.headers.host === "server.example.com" ? 200 : 404;
  res.end();
});
let port = 0;
beforeAll(async () => {
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  port = (proxy.address() as AddressInfo).port;
});
afterAll(() => proxy.close());

const ctx = () => ({ proxyContainer: "serve-proxy.invalid", proxyHttpPort: port, proxyHttpsPort: port }) as never;

describe("healthThroughProxy", () => {
  it("asks the local proxy under the domain's name when the container name does not resolve", async () => {
    expect(await healthThroughProxy("server.example.com", false, ctx())).toBe(true);
  });

  it("fails for a domain the proxy does not serve", async () => {
    expect(await healthThroughProxy("other.example.com", false, ctx())).toBe(false);
  });
});
