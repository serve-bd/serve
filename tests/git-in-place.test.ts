import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {}, schema: {} }));

import { cloneRepository, staleEntries } from "@/server/deploy/git";
import { localFs } from "@/server/servers/fs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-git-"));
let server: http.Server;
let base = "";

// Asynchronous: the HTTP server below runs in this process and must keep answering.
const git = (cwd: string, ...args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );

/** Serves the bare repositories in `root` over smart HTTP (git's own CGI), like a git host. */
function gitHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const cgi = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      // Lets the test push (receive-pack needs an authenticated user).
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

beforeAll(async () => {
  server = http.createServer(gitHttp);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const name of ["origin", "sub"]) await git(root, "init", "--quiet", "--bare", `${name}.git`);
  const sub = path.join(root, "sub-src");
  await git(root, "init", "--quiet", sub);
  fs.writeFileSync(path.join(sub, "s.txt"), "sub\n");
  await git(sub, "add", ".");
  await git(sub, "commit", "--quiet", "-m", "sub");
  await git(sub, "push", "--quiet", `${base}/sub.git`, "HEAD:main");

  const src = path.join(root, "src");
  await git(root, "init", "--quiet", src);
  fs.writeFileSync(path.join(src, "a.txt"), "one\n");
  fs.writeFileSync(path.join(src, "gone.txt"), "removed later\n");
  // Turn into a file and into a directory in the second commit.
  fs.mkdirSync(path.join(src, "conf"));
  fs.writeFileSync(path.join(src, "conf", "inner.txt"), "dir\n");
  fs.writeFileSync(path.join(src, "sw"), "file\n");
  // A relative submodule URL: resolved against the superproject's origin.
  await git(src, "remote", "add", "origin", `${base}/origin.git`);
  await git(src, "submodule", "add", "--quiet", "-b", "main", "../sub.git", "lib/sub");
  await git(src, "add", ".");
  await git(src, "commit", "--quiet", "-m", "first");
  await git(src, "push", "--quiet", `${base}/origin.git`, "HEAD:main");
});

afterAll(() => {
  server?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("compose repositories updated in place", () => {
  it("keeps untracked data, removes files deleted from git and keeps git's files out of the work tree", async () => {
    const source = { type: "git" as const, repository: `${base}/origin.git`, branch: "main" };
    const dir = path.join(root, "service", "repo");
    // A checkout from before git's files moved next to the work tree.
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\tfsmonitor = touch pwned\n");

    const first = await cloneRepository(source, dir, () => {}, undefined, null, { inPlace: true });
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(fs.readFileSync(path.join(dir, "lib/sub/s.txt"), "utf8")).toBe("sub\n");
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(`${dir}.git/HEAD`)).toBe(true);

    // Written by a container through a relative bind mount, plus a planted submodule .git file.
    fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(path.join(dir, "data", "db.txt"), "keep me\n");
    fs.writeFileSync(path.join(dir, "lib/sub/.git"), `gitdir: ${path.join(root, "elsewhere")}\n`);
    // A remote server's copy: the same files plus its own data.
    const remote = path.join(root, "remote", "repo");
    fs.cpSync(dir, remote, { recursive: true });

    const src = path.join(root, "src");
    fs.writeFileSync(path.join(src, "a.txt"), "two\n");
    await git(src, "rm", "--quiet", "gone.txt");
    await git(src, "rm", "--quiet", "-r", "conf", "sw");
    fs.writeFileSync(path.join(src, "conf"), "file now\n");
    fs.mkdirSync(path.join(src, "sw"));
    fs.writeFileSync(path.join(src, "sw", "f"), "dir now\n");
    await git(src, "add", "conf", "sw");
    await git(src, "commit", "--quiet", "-am", "second");
    await git(src, "push", "--quiet", `${base}/origin.git`, "HEAD:main");

    const second = await cloneRepository(source, dir, () => {}, undefined, null, { inPlace: true });
    expect(second.commitSha).not.toBe(first.commitSha);
    expect(second.commitSha).toBe((await git(src, "rev-parse", "HEAD")).trim());
    expect(second.commitMessage).toBe("second");
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("two\n");
    expect(fs.existsSync(path.join(dir, "gone.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "data", "db.txt"), "utf8")).toBe("keep me\n");
    expect(fs.readFileSync(path.join(dir, "lib/sub/.git"), "utf8")).toContain("repo.git/modules/lib/sub");
    expect(fs.readFileSync(path.join(dir, "lib/sub/s.txt"), "utf8")).toBe("sub\n");
    expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "conf"), "utf8")).toBe("file now\n");
    expect(fs.readFileSync(path.join(dir, "sw", "f"), "utf8")).toBe("dir now\n");
    expect(first.files).toContain("lib/sub/s.txt");
    const stale = staleEntries(first.files ?? [], second.files ?? []);
    expect(new Set(stale)).toEqual(new Set(["gone.txt", "conf/inner.txt", "sw", "conf"]));

    // What deployCompose does for a remote server, with the tar extraction of the upload.
    await localFs.removeInside(remote, stale);
    await new Promise<void>((resolve, reject) =>
      execFile("sh", ["-c", 'tar -C "$1" -cf - . | tar -xf - -C "$2"', "sh", dir, remote], (error) => (error ? reject(error) : resolve())),
    );
    expect(fs.existsSync(path.join(remote, "gone.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(remote, "conf"), "utf8")).toBe("file now\n");
    expect(fs.readFileSync(path.join(remote, "sw", "f"), "utf8")).toBe("dir now\n");
    expect(fs.readFileSync(path.join(remote, "data", "db.txt"), "utf8")).toBe("keep me\n");

    // A deploy killed mid-way leaves a lock; a damaged git directory is started again.
    fs.writeFileSync(`${dir}.git/index.lock`, "");
    const lines: string[] = [];
    await cloneRepository(source, dir, (l) => lines.push(l), undefined, null, { inPlace: true });
    expect(lines.join("\n")).not.toContain("Git update failed");
    fs.writeFileSync(`${dir}.git/HEAD`, "garbage\n");
    const again = await cloneRepository(source, dir, (l) => lines.push(l), undefined, null, { inPlace: true });
    expect(lines.join("\n")).toContain("Git update failed");
    expect(again.commitSha).toBe(second.commitSha);
    expect(fs.readFileSync(path.join(dir, "data", "db.txt"), "utf8")).toBe("keep me\n");
    expect(fs.readFileSync(path.join(dir, "lib/sub/s.txt"), "utf8")).toBe("sub\n");

    // A compose rollback checks out the commit it ran, not the branch's latest; data stays.
    const back = await cloneRepository(source, dir, () => {}, undefined, null, { inPlace: true, commit: first.commitSha });
    expect(back.commitSha).toBe(first.commitSha);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(fs.readFileSync(path.join(dir, "gone.txt"), "utf8")).toBe("removed later\n");
    expect(fs.readFileSync(path.join(dir, "data", "db.txt"), "utf8")).toBe("keep me\n");
    await expect(cloneRepository(source, dir, () => {}, undefined, null, { inPlace: true, commit: "0".repeat(40) })).rejects.toThrow();
  });

  it("never deletes through a symlink planted in the remote copy", async () => {
    const remote = path.join(root, "planted");
    const outside = path.join(root, "outside");
    fs.mkdirSync(remote, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret"), "x");
    fs.symlinkSync(outside, path.join(remote, "link"));
    await localFs.removeInside(remote, ["link/secret", "../outside/secret"]);
    expect(fs.existsSync(path.join(outside, "secret"))).toBe(true);
  });
});
