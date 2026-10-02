import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
vi.mock("@/server/settings", () => ({ getSetting: async () => "root-org" }));
// git.example.com stands for a public git server: it is pinned to the test server below.
vi.mock("@/server/net/public-host", () => ({ publicAddress: async (h: string) => (h === "git.example.com" ? "127.0.0.1" : null) }));
// The public-only request reaches the same test server, without its own address check.
vi.mock("@/server/net/public-fetch", async () => {
  const http = await import("node:http");
  return {
    publicRequest: (raw: string, opts: { headers?: Record<string, string> }) =>
      new Promise((resolve, reject) => {
        const url = new URL(raw);
        url.hostname = "127.0.0.1";
        http
          .get(url, { headers: opts.headers }, (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: "" }));
          })
          .on("error", reject);
      }),
  };
});

const { cloneRepository } = await import("@/server/deploy/git");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-gitsub-"));
let server: http.Server;
let port = 0;
let local = "";
let pub = "";

const git = (cwd: string, ...args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], { cwd }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );

/** Smart HTTP through git's CGI, plus two moved repositories: one on the same server, one elsewhere. */
function serve(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/moved.git/")) return res.writeHead(301, { location: url.pathname.replace("/moved.git/", "/main.git/") + url.search }).end();
  if (url.pathname.startsWith("/away.git/")) return res.writeHead(301, { location: `${local}${url.pathname.replace("/away.git/", "/main.git/")}${url.search}` }).end();
  const cgi = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: "test",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
    },
  });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0);
  let sent = false;
  cgi.stdout.on("data", (chunk: Buffer) => {
    if (sent) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    let status = 200;
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const [name, ...rest] = line.split(":");
      if (name.toLowerCase() === "status") status = Number.parseInt(rest.join(":"), 10);
      else res.setHeader(name, rest.join(":").trim());
    }
    res.writeHead(status);
    res.write(head.subarray(end + 4));
    sent = true;
  });
  cgi.stdout.on("end", () => res.end());
}

/** A repository with one submodule at `url`, pushed as `<name>.git`. */
async function withSubmodule(name: string, url: string) {
  await git(root, "init", "--quiet", "--bare", `${name}.git`);
  const src = path.join(root, `${name}-src`);
  await git(root, "init", "--quiet", src);
  fs.writeFileSync(path.join(src, "a.txt"), "one\n");
  await git(src, "remote", "add", "origin", `${local}/${name}.git`);
  await git(src, "submodule", "add", "--quiet", "-b", "main", url, "lib/sub");
  await git(src, "add", ".");
  await git(src, "commit", "--quiet", "-m", "first");
  await git(src, "push", "--quiet", `${local}/${name}.git`, "HEAD:main");
}

beforeAll(async () => {
  server = http.createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  local = `http://127.0.0.1:${port}`;
  pub = `http://git.example.com:${port}`;

  await git(root, "init", "--quiet", "--bare", "sub.git");
  const sub = path.join(root, "sub-src");
  await git(root, "init", "--quiet", sub);
  fs.writeFileSync(path.join(sub, "s.txt"), "sub\n");
  await git(sub, "add", ".");
  await git(sub, "commit", "--quiet", "-m", "sub");
  await git(sub, "push", "--quiet", `${local}/sub.git`, "HEAD:main");

  // Relative: resolves to the repository's own (public) server.
  await withSubmodule("main", "../sub.git");
  // Absolute, on a private address the organization must not reach.
  await withSubmodule("private", `${local}/sub.git`);
});

afterAll(() => {
  server?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const source = (repository: string) => ({ type: "git" as const, repository, branch: "main" });

describe("git for organizations other than Root", () => {
  it("checks out submodules on public servers", async () => {
    const dir = path.join(root, "out", "ok");
    await cloneRepository(source(`${pub}/main.git`), dir, () => {}, undefined, "org-1");
    expect(fs.readFileSync(path.join(dir, "lib/sub/s.txt"), "utf8")).toBe("sub\n");
  });

  it("refuses a submodule on a private address, in fresh clones and in-place updates", async () => {
    await expect(cloneRepository(source(`${pub}/private.git`), path.join(root, "out", "bad"), () => {}, undefined, "org-1")).rejects.toThrow(
      /Submodule lib\/sub: .*private network/,
    );
    await expect(cloneRepository(source(`${pub}/private.git`), path.join(root, "out", "bad-inplace"), () => {}, undefined, "org-1", { inPlace: true })).rejects.toThrow(
      /Submodule lib\/sub: .*private network/,
    );
    expect(fs.existsSync(path.join(root, "out", "bad", "lib/sub/s.txt"))).toBe(false);
  });

  it("follows a move on the same server, but no redirect to another host", async () => {
    const dir = path.join(root, "out", "moved");
    await cloneRepository(source(`${pub}/moved.git`), dir, () => {}, undefined, "org-1", { submodules: false });
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one\n");
    const lines: string[] = [];
    await expect(cloneRepository(source(`${pub}/away.git`), path.join(root, "out", "away"), (l) => lines.push(l), undefined, "org-1", { submodules: false })).rejects.toThrow();
    expect(lines.join("\n")).toMatch(/returned error: 301/);
  });
});
