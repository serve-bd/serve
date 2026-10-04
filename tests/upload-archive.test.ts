import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { parsePax, readArchive, safeEntryPath, symlinkEscapes, symlinkInside } from "@/server/deploy/upload-archive";
import { noRoomMessage, uploadsToRemove } from "@/server/deploy/uploads";

type Entry = { name: string; type?: "0" | "1" | "2" | "3" | "5" | "x" | "L"; body?: string | Buffer; link?: string; mode?: number; prefix?: string };

function header(e: Entry, size: number) {
  const h = Buffer.alloc(512);
  h.write(e.name.slice(0, 100), 0, "utf8");
  h.write(`${(e.mode ?? (e.type === "5" ? 0o755 : 0o644)).toString(8).padStart(7, "0")}\0`, 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(e.type ?? "0", 156);
  h.write(e.link ?? "", 157);
  h.write("ustar\0", 257);
  h.write("00", 263);
  if (e.prefix) h.write(e.prefix, 345);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

function tar(entries: Entry[]) {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    parts.push(header(e, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

function pax(records: Record<string, string>) {
  return Object.entries(records)
    .map(([k, v]) => {
      const rest = ` ${k}=${v}\n`;
      let len = rest.length + 1;
      while (`${len}${rest}`.length !== len) len += 1;
      return `${len}${rest}`;
    })
    .join("");
}

const dirs: string[] = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "serve-upload-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const check = (entries: Entry[]) => readArchive(Readable.from([tar(entries)]));
const extract = (entries: Entry[], into: string) => readArchive(Readable.from([tar(entries)]), { into });

describe("upload paths", () => {
  it("keeps paths inside the folder", () => {
    expect(safeEntryPath("./src/index.js")).toBe("src/index.js");
    expect(safeEntryPath("src//a/./b")).toBe("src/a/b");
    expect(safeEntryPath("./")).toBe("");
    expect(() => safeEntryPath("/etc/passwd")).toThrow(/absolute/);
    expect(() => safeEntryPath("C:/x")).toThrow(/absolute/);
    expect(() => safeEntryPath("a/../../x")).toThrow(/outside/);
    expect(() => safeEntryPath("..")).toThrow(/outside/);
    expect(() => safeEntryPath("a\\b")).toThrow();
  });

  it("allows symlinks that stay inside", () => {
    expect(symlinkInside("a/link", "../b")).toBe(true);
    expect(symlinkInside("link", "dist/index.html")).toBe(true);
    expect(symlinkInside("link", "..")).toBe(false);
    expect(symlinkInside("a/link", "../../b")).toBe(false);
    expect(symlinkInside("link", "/etc/passwd")).toBe(false);
    expect(symlinkInside("link", "")).toBe(false);
  });

  it("refuses a target that climbs out of another symlink", () => {
    expect(
      symlinkEscapes(
        new Map([
          ["a", "."],
          ["b", "a/../etc"],
        ]),
      ),
    ).toEqual(["b"]);
    expect(
      symlinkEscapes(
        new Map([
          ["a", "."],
          ["b", "a/a/a/.."],
        ]),
      ),
    ).toEqual(["b"]);
    expect(
      symlinkEscapes(
        new Map([
          ["a", "sub"],
          ["b", "a/x"],
          ["sub/c", "../d"],
        ]),
      ),
    ).toEqual([]);
  });

  it("reads PAX records", () => {
    expect(parsePax(Buffer.from(pax({ path: "a/very/long/name.txt", linkpath: "x" })))).toEqual({ path: "a/very/long/name.txt", linkpath: "x" });
  });
});

describe("checking an uploaded archive", () => {
  it("counts files and bytes of a normal folder", async () => {
    const r = await check([
      { name: "./", type: "5" },
      { name: "./package.json", body: '{"name":"x"}' },
      { name: "./src/", type: "5" },
      { name: "./src/index.js", body: "console.log(1)" },
      { name: "./current", type: "2", link: "src" },
    ]);
    expect(r).toEqual({ files: 2, bytes: 26 });
  });

  it("refuses paths outside the folder", async () => {
    await expect(check([{ name: "../evil", body: "x" }])).rejects.toThrow(/outside the folder/);
    await expect(check([{ name: "/etc/cron.d/x", body: "x" }])).rejects.toThrow(/absolute/);
    await expect(
      check([
        { name: "x", type: "x", body: pax({ path: "../../evil" }) },
        { name: "x", body: "1" },
      ]),
    ).rejects.toThrow(/outside the folder/);
  });

  it("refuses symlinks that lead outside", async () => {
    await expect(check([{ name: "link", type: "2", link: "/etc" }])).rejects.toThrow(/symlink that points outside/);
    await expect(check([{ name: "a/link", type: "2", link: "../../.." }])).rejects.toThrow(/symlink that points outside/);
    await expect(
      check([
        { name: "a", type: "2", link: "." },
        { name: "b", type: "2", link: "a/../etc" },
      ]),
    ).rejects.toThrow(/symlink that points outside/);
  });

  it("refuses writing through a symlink", async () => {
    await expect(
      check([
        { name: "dir", type: "2", link: "sub" },
        { name: "dir/file", body: "x" },
      ]),
    ).rejects.toThrow(/through a symlink/);
  });

  it("refuses devices and hard links to files it does not hold", async () => {
    await expect(check([{ name: "tty", type: "3" }])).rejects.toThrow(/special file/);
    await expect(check([{ name: "h", type: "1", link: "/etc/shadow" }])).rejects.toThrow(/absolute/);
    await expect(check([{ name: "h", type: "1", link: "missing" }])).rejects.toThrow(/does not hold/);
  });

  it("refuses what is not a .tar.gz", async () => {
    await expect(readArchive(Readable.from([Buffer.from("not gzip at all")]))).rejects.toThrow(/not a valid/);
    const broken = zlib.gzipSync(Buffer.alloc(512, 7));
    await expect(readArchive(Readable.from([broken]))).rejects.toThrow(/not a valid tar/);
    const cut = zlib.gzipSync(Buffer.concat([header({ name: "big" }, 4096), Buffer.alloc(100)]));
    await expect(readArchive(Readable.from([cut]))).rejects.toThrow(/middle of a file/);
  });
});

describe("unpacking an uploaded archive", () => {
  it("writes files, folders, modes, links and long names", async () => {
    const dir = tmp();
    const long = `deep/${"n".repeat(120)}.txt`;
    const r = await extract(
      [
        { name: "./", type: "5" },
        { name: "Dockerfile", body: "FROM nginx:alpine\n" },
        { name: "bin/run.sh", body: "#!/bin/sh\necho hi\n", mode: 0o4755 },
        { name: "PaxHeader", type: "x", body: pax({ path: long }) },
        { name: "placeholder", body: "long" },
        { name: "LongLink", type: "L", body: "other/" + "m".repeat(110) },
        { name: "ignored", body: "gnu" },
        { name: "index.html", prefix: "public", body: "<h1>hi</h1>" },
        { name: "copy.sh", type: "1", link: "bin/run.sh" },
        { name: "link", type: "2", link: "public/index.html" },
      ],
      dir,
    );
    expect(r.files).toBe(6);
    expect(fs.readFileSync(path.join(dir, "Dockerfile"), "utf8")).toBe("FROM nginx:alpine\n");
    expect(fs.statSync(path.join(dir, "bin/run.sh")).mode & 0o7777).toBe(0o755);
    expect(fs.readFileSync(path.join(dir, long), "utf8")).toBe("long");
    expect(fs.readFileSync(path.join(dir, "other", "m".repeat(110)), "utf8")).toBe("gnu");
    expect(fs.readFileSync(path.join(dir, "public/index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(fs.readFileSync(path.join(dir, "copy.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(fs.readlinkSync(path.join(dir, "link"))).toBe("public/index.html");
  });

  it("writes nothing outside the folder", async () => {
    const parent = tmp();
    const dir = path.join(parent, "work");
    fs.mkdirSync(dir);
    await expect(
      extract(
        [
          { name: "out", type: "2", link: ".." },
          { name: "out/pwned", body: "x" },
        ],
        dir,
      ),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(parent, "pwned"))).toBe(false);
  });

  it("never writes a file through a symlink at its own path", async () => {
    const parent = tmp();
    const dir = path.join(parent, "work");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(parent, "victim"), "safe");
    await expect(
      extract(
        [
          { name: "f", type: "2", link: "x" },
          { name: "f", body: "overwrite" },
        ],
        dir,
      ),
    ).rejects.toThrow(/through a symlink/);
    expect(fs.readFileSync(path.join(parent, "victim"), "utf8")).toBe("safe");
  });
});

describe("pruning uploads", () => {
  it("removes files that no kept deployment uses", () => {
    expect(uploadsToRemove(["a.tar.gz", "b.tar.gz", "c.tar.gz.part"], new Set(["a.tar.gz"]))).toEqual(["b.tar.gz", "c.tar.gz.part"]);
  });
});

describe("disk room for uploads", () => {
  const GB = 1024 ** 3;
  it("accepts an upload that leaves the reserve free", () => {
    expect(noRoomMessage(10 * GB, GB)).toBeNull();
    expect(noRoomMessage(null, GB)).toBeNull();
  });
  it("refuses with how much is free", () => {
    expect(noRoomMessage(GB, GB)).toBe("Not enough disk space on the Serve server: 1 GB free, the upload is 1 GB and 256 MB must stay free.");
    expect(noRoomMessage(100 * 1024 ** 2, 0)).toMatch(/^Not enough disk space on the Serve server: 100 MB free and 256 MB must stay free\.$/);
  });
});
