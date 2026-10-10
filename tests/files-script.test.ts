import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseListing } from "@/server/files";
import { FILES_SCRIPT } from "@/server/files/script";

// The file manager's shell script, run against a folder standing in for a container's root: paths
// resolve like a chroot (links cannot lead out), and each operation does what the dashboard asks.

let root: string;
const run = (args: string[], input?: string | Buffer) => {
  const r = spawnSync("sh", ["-c", FILES_SCRIPT, "files", root, ...args], { input });
  return { code: r.status, out: r.stdout, err: r.stderr.toString().trim() };
};
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-files-"));
  fs.mkdirSync(path.join(root, "etc"));
  fs.writeFileSync(path.join(root, "etc/passwd"), `root:x:0:0::/root:/bin/sh\napp:x:${process.getuid?.() ?? 1000}:1000::/app:/bin/sh\n`);
  fs.writeFileSync(path.join(root, "etc/group"), "root:x:0:\n");
  fs.mkdirSync(path.join(root, "app/data"), { recursive: true });
  fs.writeFileSync(path.join(root, "app/config.yml"), "a: 1\n");
  fs.writeFileSync(path.join(root, "app/line\nbreak"), "x");
  fs.symlinkSync("/etc/passwd", path.join(root, "app/abs-link"));
  fs.symlinkSync("../../../../../..", path.join(root, "app/up-link"));
  fs.symlinkSync("data", path.join(root, "app/rel-link"));
  fs.symlinkSync("/nowhere", path.join(root, "app/dangling"));
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("files script", () => {
  it("lists a folder with types, owners and where links point, staying inside the root", () => {
    const r = run(["list", "/app"]);
    expect(r.code).toBe(0);
    const l = parseListing(r.out);
    expect(l.path).toBe("/app");
    const by = Object.fromEntries(l.entries.map((e) => [e.name, e]));
    expect(by.data.type).toBe("dir");
    expect(by["config.yml"]).toMatchObject({ type: "file", size: 5, mode: "rw-r--r--", owner: "app" });
    expect(by["line\nbreak"]?.type).toBe("file");
    expect(by["abs-link"].link).toEqual({ target: "/etc/passwd", kind: "file" });
    expect(by["rel-link"].link).toEqual({ target: "data", kind: "dir" });
    expect(by.dangling.link?.kind).toBe("missing");
    // Folders (and links to folders) first.
    expect(l.entries.slice(0, 3).map((e) => e.name)).toEqual(["data", "rel-link", "up-link"]);
  });

  it("resolves links like a chroot: an absolute link and a run of .. both stay in the root", () => {
    expect(run(["read", "/app/abs-link"]).out.toString()).toContain("root:x:0:0");
    expect(parseListing(run(["list", "/app/up-link"]).out).path).toBe("/");
    expect(parseListing(run(["list", "/../../app/../etc"]).out).path).toBe("/etc");
  });

  it("reports missing paths and files that are not folders", () => {
    expect(run(["list", "/nope"])).toMatchObject({ code: 2, err: "No such folder" });
    expect(run(["list", "/app/config.yml"]).code).toBe(5);
    expect(run(["read", "/app/data"]).code).toBe(5);
  });

  it("writes new files, refuses to overwrite them, and saves only over the version read", () => {
    expect(run(["write", "/app/new.txt", "new"], "one").code).toBe(0);
    expect(run(["write", "/app/new.txt", "new"], "two")).toMatchObject({ code: 6 });
    const hash = run(["hash", "/app/new.txt"]).out.toString().trim();
    expect(run(["write", "/app/new.txt", "0".repeat(64)], "three")).toMatchObject({ code: 7, err: "The file changed since you opened it" });
    expect(run(["write", "/app/new.txt", hash], "four").code).toBe(0);
    expect(read("app/new.txt")).toBe("four");
    expect(run(["write", "/app/new.txt", "-"], "five").code).toBe(0);
    expect(read("app/new.txt")).toBe("five");
    // No temporary file is left.
    expect(fs.readdirSync(path.join(root, "app")).filter((n) => n.includes(".serve-"))).toEqual([]);
  });

  it("keeps a replaced file's mode", () => {
    fs.chmodSync(path.join(root, "app/new.txt"), 0o600);
    run(["write", "/app/new.txt", "-"], "six");
    expect(fs.statSync(path.join(root, "app/new.txt")).mode & 0o777).toBe(0o600);
  });

  it("creates folders, moves, and deletes without following the last link", () => {
    expect(run(["mkdir", "/app/made"]).code).toBe(0);
    expect(run(["mkdir", "/app/made"]).code).toBe(6);
    expect(run(["move", "/app/made", "/app/made/inside"]).code).toBe(5);
    expect(run(["move", "/app/made", "/app/renamed"]).out.toString()).toBe("/app/renamed");
    // Deleting a link removes the link, not the folder it points to.
    expect(run(["delete", "/app/rel-link"]).code).toBe(0);
    expect(fs.existsSync(path.join(root, "app/data"))).toBe(true);
    expect(run(["delete", "/"]).code).toBe(5);
    expect(run(["delete", "/app/../.."]).code).toBe(5);
  });

  it("packs a folder and unpacks one, refusing what exists unless merging", () => {
    fs.writeFileSync(path.join(root, "app/data/x.txt"), "x");
    const tgz = run(["archive", "/app/data"]).out;
    expect(execFileSync("tar", ["-tzf", "-"], { input: tgz }).toString().split("\n")).toContain("data/x.txt");
    fs.mkdirSync(path.join(root, "dest"));
    expect(run(["extract", "/dest"], tgz).code).toBe(0);
    expect(read("dest/data/x.txt")).toBe("x");
    expect(run(["extract", "/dest"], tgz)).toMatchObject({ code: 6, err: "/dest/data already exists" });
    fs.writeFileSync(path.join(root, "dest/data/keep.txt"), "k");
    fs.writeFileSync(path.join(root, "dest/data/x.txt"), "changed");
    expect(run(["extract", "/dest", "replace"], tgz).code).toBe(0);
    expect(read("dest/data/x.txt")).toBe("x");
    expect(read("dest/data/keep.txt")).toBe("k");
    // A broken archive leaves nothing behind.
    expect(run(["extract", "/dest"], "not a tarball").code).toBe(5);
    expect(fs.readdirSync(path.join(root, "dest"))).toEqual(["data"]);
  });
});

describe("files script, several entries", () => {
  it("packs picked entries of a folder, refusing names that are paths", () => {
    const dir = path.join(root, "pick");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "-dash"), "d");
    fs.writeFileSync(path.join(dir, "b.txt"), "b");
    fs.writeFileSync(path.join(dir, "skip.txt"), "s");
    const r = run(["archive", "/pick", "-dash", "sub", "b.txt"]);
    expect(r.code).toBe(0);
    const names = execFileSync("tar", ["-tzf", "-"], { input: r.out }).toString().split("\n").filter(Boolean).sort();
    expect(names).toEqual(["./-dash", "./b.txt", "./sub/"]);
    expect(run(["archive", "/pick", "../etc"]).code).toBe(5);
    expect(run(["archive", "/pick", "gone"]).code).toBe(2);
  });
});
