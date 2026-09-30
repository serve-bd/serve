import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { s3Download, s3Test } from "@/server/backups/s3";
import { engines } from "@/server/databases/engines";

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.includes("redirect")) {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end("dump");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const cfg = (endpoint: string, publicOnly: boolean, bucket = "b") => ({ endpoint, region: "auto", bucket, accessKeyId: "k", secretAccessKey: "s", publicOnly });

describe("S3 requests", () => {
  it("refuses a private endpoint for organizations other than Root", async () => {
    await expect(s3Test(cfg(`http://127.0.0.1:${port}`, true))).rejects.toThrow(/private network/);
    // A name is checked at connect time, on the address actually used.
    await expect(s3Test(cfg(`http://localhost:${port}`, true))).rejects.toThrow(/private network/);
  });

  it("does not follow redirects", async () => {
    await expect(s3Test(cfg(`http://127.0.0.1:${port}`, false, "redirect"))).rejects.toThrow(/S3 GET failed: 302/);
  });

  it("downloads an object", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "serve-s3-")), "dump");
    await s3Download(cfg(`http://127.0.0.1:${port}`, false), "x/dump", file);
    expect(fs.readFileSync(file, "utf8")).toBe("dump");
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe("ClickHouse backups", () => {
  it("dump rows, not only the schema", () => {
    const cmd = engines.clickhouse.backupCommand({ username: "u", password: "p'x", database: "app" });
    expect(cmd).toContain("FORMAT SQLInsert");
    expect(cmd).toContain("create_table_query");
    expect(cmd).toContain("set -e");
    expect(cmd).toContain(`--password 'p'\\''x'`);
  });
});
