import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { FilesError, type FilesPlace, runOp, runOpBuffer } from "./helper";

export { FilesError, filesStatus, type FilesPlace } from "./helper";

export type FileEntry = {
  name: string;
  type: "dir" | "file" | "link" | "other";
  size: number;
  /** Last change, in ms. */
  mtime: number;
  /** Like ls: rwxr-xr-x. */
  mode: string;
  owner: string;
  group: string;
  /** A symbolic link: where it points, and what is there (missing: nothing, or outside reach). */
  link?: { target: string; kind: "dir" | "file" | "missing" };
};

export type Listing = { path: string; entries: FileEntry[] };

/** Text files up to this size open in the editor; bigger ones are downloaded. */
export const EDIT_MAX = 2 * 1024 * 1024;

/** An absolute path inside the place, without NUL; "." and ".." are resolved by the helper. */
export function cleanPath(path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0") || path.length > 4096) throw new FilesError(5, "Use an absolute path, like /etc/hosts.");
  return path;
}

function modeString(mode: number) {
  const bits = "rwxrwxrwx";
  let out = "";
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : "-";
  return out;
}

const typeOf = (mode: number): FileEntry["type"] => {
  const t = mode & 0o170000;
  return t === 0o040000 ? "dir" : t === 0o100000 ? "file" : t === 0o120000 ? "link" : "other";
};

const idMap = (text: string) => new Map(text.split(" ").flatMap((p) => (p.includes(":") ? [[p.slice(p.lastIndexOf(":") + 1), p.slice(0, p.lastIndexOf(":"))] as const] : [])));

const RECORD = /^([0-9a-f]+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(.*)$/;

/** Parses the list operation's output (see script.ts). */
export function parseListing(out: Buffer): Listing {
  const parts = out.toString("utf8").split("\0");
  const [path, passwd = "", group = "", stats = "", ...links] = parts;
  const users = idMap(passwd.trim());
  const groups = idMap(group.trim());
  const entries: FileEntry[] = [];
  for (const line of stats.split("\n")) {
    const m = RECORD.exec(line);
    if (!m) {
      // A name with a line break continues on the next line.
      const last = entries[entries.length - 1];
      if (last && line) last.name += `\n${line}`;
      continue;
    }
    const mode = Number.parseInt(m[1], 16);
    entries.push({
      name: m[6].slice(m[6].lastIndexOf("/") + 1),
      type: typeOf(mode),
      size: Number(m[2]),
      mtime: Number(m[3]) * 1000,
      mode: modeString(mode),
      owner: users.get(m[4]) ?? m[4],
      group: groups.get(m[5]) ?? m[5],
    });
  }
  for (let i = 0; i + 2 < links.length; i += 3) {
    const e = entries.find((x) => x.name === links[i] && x.type === "link");
    if (e) e.link = { target: links[i + 1], kind: links[i + 2] === "d" ? "dir" : links[i + 2] === "f" ? "file" : "missing" };
  }
  entries.sort((a, b) => {
    const da = a.type === "dir" || a.link?.kind === "dir";
    const db = b.type === "dir" || b.link?.kind === "dir";
    return da === db ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : da ? -1 : 1;
  });
  return { path, entries };
}

export async function listDir(place: FilesPlace, path: string): Promise<Listing> {
  return parseListing(await runOpBuffer(place, ["list", cleanPath(path)], null, 64 * 1024 * 1024));
}

export async function statPath(place: FilesPlace, path: string) {
  const [p, rest = ""] = (await runOpBuffer(place, ["stat", cleanPath(path)])).toString().split("\0");
  const [mode, size, mtime] = rest
    .trim()
    .split("/")
    .map((x, i) => (i === 0 ? Number.parseInt(x, 16) : Number(x)));
  return { path: p, type: typeOf(mode), size, mtime: mtime * 1000, name: p.slice(p.lastIndexOf("/") + 1) || "root" };
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A text file for the editor, with its hash to save it back without overwriting a change made meanwhile. */
export async function readText(place: FilesPlace, path: string): Promise<{ path: string; content: string; hash: string }> {
  const s = await statPath(place, path);
  if (s.type !== "file") throw new FilesError(5, "Only files open in the editor.");
  if (s.size > EDIT_MAX) throw new FilesError(5, `This file is ${(s.size / 1024 / 1024).toFixed(1)} MB. Files up to 2 MB open in the editor; download it instead.`);
  const buf = await runOpBuffer(place, ["read", s.path], null, EDIT_MAX);
  if (buf.subarray(0, 8192).includes(0)) throw new FilesError(5, "This is not a text file. Download it instead.");
  const content = buf.toString("utf8");
  if (content.includes("�") && !Buffer.from(content, "utf8").equals(buf)) throw new FilesError(5, "This file is not UTF-8 text. Download it instead.");
  return { path: s.path, content, hash: sha256(buf) };
}

/** Saves editor text; `hash` is the one readText gave (null for a new file). */
export async function writeText(place: FilesPlace, path: string, content: string, hash: string | null) {
  const buf = Buffer.from(content, "utf8");
  await runOpBuffer(place, ["write", cleanPath(path), hash ?? "new"], Readable.from([buf]));
  return { hash: sha256(buf) };
}

/** Streams a file, or a folder as .tar.gz; with `names`, those entries of the folder as one .tar.gz. */
export async function download(place: FilesPlace, path: string, signal?: AbortSignal, names: string[] = []) {
  const s = await statPath(place, path);
  if (names.length) {
    if (s.type !== "dir") throw new FilesError(5, "Pick entries of a folder.");
    const run = await runOp(place, ["archive", s.path, ...names], null, signal);
    return { ...s, type: "dir" as const, stream: run.stdout, done: run.done, filename: `${s.path === "/" ? "files" : s.name}.tar.gz` };
  }
  if (s.type !== "file" && s.type !== "dir") throw new FilesError(5, "Only files and folders can be downloaded.");
  const run = await runOp(place, [s.type === "dir" ? "archive" : "read", s.path], null, signal);
  return { ...s, stream: run.stdout, done: run.done, filename: s.type === "dir" ? `${s.name}.tar.gz` : s.name };
}

/** Writes a stream to a file: "new" refuses an existing file, "replace" overwrites it. */
export async function upload(place: FilesPlace, path: string, body: Readable, mode: "new" | "replace", signal?: AbortSignal) {
  const run = await runOp(place, ["write", cleanPath(path), mode === "new" ? "new" : "-"], body, signal);
  run.stdout.resume();
  await run.done;
}

/** Unpacks a .tar.gz stream into a folder: "new" refuses entries that exist, "replace" merges into them. */
export async function extract(place: FilesPlace, dir: string, body: Readable, mode: "new" | "replace", signal?: AbortSignal) {
  const run = await runOp(place, ["extract", cleanPath(dir), mode === "replace" ? "replace" : "new"], body, signal);
  run.stdout.resume();
  await run.done;
}

export async function makeDir(place: FilesPlace, path: string) {
  return (await runOpBuffer(place, ["mkdir", cleanPath(path)])).toString();
}

export async function move(place: FilesPlace, from: string, to: string) {
  return (await runOpBuffer(place, ["move", cleanPath(from), cleanPath(to)])).toString();
}

export async function remove(place: FilesPlace, path: string) {
  await runOpBuffer(place, ["delete", cleanPath(path)]);
}
