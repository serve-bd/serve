import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { s3Delete, s3Download, s3Test, s3Upload } from "@/server/backups/s3";
import { engines } from "@/server/databases/engines";

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.includes("missing")) {
      res.writeHead(404, { "content-type": "application/xml" });
      return res.end("<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>");
    }
    if (req.url?.includes("redirect")) {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }
    if (req.url?.includes("cutoff")) {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "100" });
      res.write("du");
      return setTimeout(() => res.destroy(), 20);
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

  it("fails an upload the storage answers with 404, but not a delete", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-s3-"));
    fs.writeFileSync(path.join(dir, "dump"), "dump");
    await expect(s3Upload(cfg(`http://127.0.0.1:${port}`, false, "missing"), "x/dump", path.join(dir, "dump"))).rejects.toThrow(/S3 PUT failed: 404 NoSuchBucket/);
    await expect(s3Delete(cfg(`http://127.0.0.1:${port}`, false, "missing"), "x/dump")).resolves.toBeUndefined();
    await expect(s3Download(cfg(`http://127.0.0.1:${port}`, false, "missing"), "x/dump", path.join(dir, "out"))).rejects.toThrow(/not found/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("downloads an object", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "serve-s3-")), "dump");
    await s3Download(cfg(`http://127.0.0.1:${port}`, false), "x/dump", file);
    expect(fs.readFileSync(file, "utf8")).toBe("dump");
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("leaves no file behind when a download is cut off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-s3-"));
    await expect(s3Download(cfg(`http://127.0.0.1:${port}`, false, "cutoff"), "x/dump", path.join(dir, "dump"))).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("ClickHouse backups", () => {
  it("dump rows, not only the schema", () => {
    const cmd = engines.clickhouse.backupCommand({ username: "u", password: "p'x", database: "app" });
    expect(cmd).toContain("FORMAT SQLInsert");
    expect(cmd).toContain("create_table_query");
    expect(cmd).toContain("set -e");
    expect(cmd).toContain(`CLICKHOUSE_PASSWORD='p'\\''x'`);
  });
});
