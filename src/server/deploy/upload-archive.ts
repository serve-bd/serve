import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/*
 * The project folder the CLI uploads: a .tar.gz, read here without the tar program (the image
 * has only BusyBox, whose flags differ). Every entry is checked before anything is written: no
 * absolute paths, no "..", no devices, and links must stay inside the folder. Nothing is ever
 * written through a symlink the archive made, so a link cannot carry a later file outside.
 */

export class ArchiveError extends Error {}

export type TarEntryType = "file" | "dir" | "symlink" | "hardlink";

export type TarHeader = {
  name: string;
  mode: number;
  size: number;
  /** The raw type flag ("0", "5", "2", "x", ...). */
  flag: string;
  linkname: string;
};

export type ArchiveSummary = { files: number; bytes: number };

const BLOCK = 512;

function text(buf: Buffer, start: number, length: number) {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

/** A numeric header field: octal text, or base-256 when the high bit is set (sizes over 8 GB). */
function numeric(buf: Buffer, start: number, length: number) {
  const field = buf.subarray(start, start + length);
  if (field[0] & 0x80) {
    let value = field[0] & 0x7f;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i];
    return value;
  }
  const raw = text(buf, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new ArchiveError("The upload is not a valid tar archive.");
  return Number.parseInt(raw, 8);
}

/** One 512-byte header block, or null for the zero block that ends an archive. */
export function parseHeader(block: Buffer): TarHeader | null {
  if (block.length !== BLOCK) throw new ArchiveError("The upload ends in the middle of a file.");
  if (block.every((b) => b === 0)) return null;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  if (sum !== numeric(block, 148, 8)) throw new ArchiveError("The upload is not a valid tar archive.");
  const name = text(block, 0, 100);
  const magic = text(block, 257, 6);
  const prefix = magic.startsWith("ustar") ? text(block, 345, 155) : "";
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: numeric(block, 100, 8),
    size: numeric(block, 124, 12),
    flag: String.fromCharCode(block[156] || 48),
    linkname: text(block, 157, 100),
  };
}

/** Records of a PAX extended header: "<length> <key>=<value>\n" each. */
export function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(32, i);
    if (space === -1) break;
    const length = Number(data.subarray(i, space).toString());
    if (!Number.isInteger(length) || length <= 0 || i + length > data.length) break;
    const record = data.subarray(space + 1, i + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return out;
}

/**
 * The entry's path inside the folder ("src/index.js"), "" for the folder itself, or an error:
 * absolute paths, ".." and odd characters never get in.
 */
export function safeEntryPath(name: string): string {
  if (name.includes("\0")) throw new ArchiveError(`The upload has an invalid file name: ${JSON.stringify(name)}.`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\\")) throw new ArchiveError(`The upload has an absolute path: ${name}.`);
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new ArchiveError(`The upload has a path that leads outside the folder: ${name}.`);
  return parts.join("/");
}

/** Whether a symlink at `entry` pointing at `target` stays inside the folder, read as plain text. */
export function symlinkInside(entry: string, target: string): boolean {
  if (!target || target.startsWith("/") || target.includes("\0")) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), target));
  return resolved !== ".." && !resolved.startsWith("../");
}

/**
 * Symlinks whose target climbs ("..") out of another symlink of the archive: a -> "." with
 * b -> "a/../etc" reads as "etc" but leads outside. Such a target is refused, wherever it points.
 */
export function symlinkEscapes(links: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [entry, target] of links) {
    const stack = path.posix.dirname(entry) === "." ? [] : path.posix.dirname(entry).split("/");
    for (const part of target.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        const viaLink = stack.some((_, i) => links.has(stack.slice(0, i + 1).join("/")));
        if (viaLink || !stack.length) {
          out.push(entry);
          break;
        }
        stack.pop();
      } else stack.push(part);
    }
  }
  return out;
}

/** What an entry is, or an error for kinds a project folder never needs (devices, pipes). */
function entryType(flag: string, name: string): TarEntryType {
  if (flag === "0" || flag === "7") return "file";
  if (flag === "5") return "dir";
  if (flag === "2") return "symlink";
  if (flag === "1") return "hardlink";
  throw new ArchiveError(`The upload has a device or other special file, which is not allowed: ${name}.`);
}

/** Reads exact byte counts from a stream of chunks. */
class ChunkReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private done = false;
  constructor(private source: AsyncIterator<Buffer>) {}

  private async fill(n: number) {
    while (this.buffered < n && !this.done) {
      const { value, done } = await this.source.next();
      if (done) this.done = true;
      else if (value.length) {
        this.chunks.push(value);
        this.buffered += value.length;
      }
    }
  }

  /** Exactly n bytes, or fewer at the end of the stream. */
  async read(n: number): Promise<Buffer> {
    await this.fill(n);
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, Math.min(n, all.length));
    const rest = all.subarray(out.length);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }

  /** Up to `max` bytes as they arrive (at least one unless the stream ended). */
  async some(max: number): Promise<Buffer> {
    await this.fill(1);
    return this.read(Math.min(max, this.buffered));
  }
}

type ReadOptions = {
  /** Extract into this folder (it must exist and be empty). Without it the archive is only checked. */
  into?: string;
  /** Called with the bytes written so far, every 64 MB; throw to stop (a full disk). */
  onProgress?: (bytes: number) => Promise<void> | void;
};

/** Checks a .tar.gz stream entry by entry and, with `into`, writes it out. */
export async function readArchive(input: NodeJS.ReadableStream, opts: ReadOptions = {}): Promise<ArchiveSummary> {
  const gunzip = zlib.createGunzip();
  input.on("error", (e) => gunzip.destroy(e));
  input.pipe(gunzip);
  const reader = new ChunkReader(gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  const root = opts.into ? path.resolve(opts.into) : null;
  // Paths the archive made a symlink at: nothing may be written at or below them afterwards.
  const symlinks = new Map<string, string>();
  const files = new Set<string>();
  let count = 0;
  let bytes = 0;
  let reported = 0;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let longLink: string | null = null;

  const throughSymlink = (rel: string) => {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) if (symlinks.has(parts.slice(0, i).join("/"))) return true;
    return false;
  };
  const skip = async (size: number) => {
    let left = size + ((BLOCK - (size % BLOCK)) % BLOCK);
    while (left > 0) {
      const chunk = await reader.some(Math.min(left, 1 << 20));
      if (!chunk.length) throw new ArchiveError("The upload ends in the middle of a file.");
      left -= chunk.length;
    }
  };
  try {
    for (;;) {
      const block = await reader.read(BLOCK);
      if (!block.length) break;
      const header = parseHeader(block);
      if (!header) break;
      // Headers that describe the next entry: PAX (x), global PAX (g, ignored), GNU long names (L, K).
      if (header.flag === "x" || header.flag === "g") {
        const data = await readPadded(header.size);
        if (header.flag === "x") pax = parsePax(data);
        continue;
      }
      if (header.flag === "L" || header.flag === "K") {
        const value = text(await readPadded(header.size), 0, header.size);
        if (header.flag === "L") longName = value;
        else longLink = value;
        continue;
      }
      const name = pax.path ?? longName ?? header.name;
      const linkname = pax.linkpath ?? longLink ?? header.linkname;
      const size = pax.size !== undefined ? Number(pax.size) : header.size;
      pax = {};
      longName = null;
      longLink = null;
      if (!Number.isSafeInteger(size) || size < 0) throw new ArchiveError("The upload is not a valid tar archive.");

      const type = entryType(header.flag, name);
      const rel = safeEntryPath(name);
      if (rel && throughSymlink(rel)) throw new ArchiveError(`The upload writes through a symlink: ${name}.`);
      if (type === "symlink" && !symlinkInside(rel, linkname)) throw new ArchiveError(`The upload has a symlink that points outside the folder: ${name} -> ${linkname}.`);
      let hardTarget = "";
      if (type === "hardlink") {
        hardTarget = safeEntryPath(linkname);
        if (!files.has(hardTarget)) throw new ArchiveError(`The upload has a hard link to a file it does not hold: ${name} -> ${linkname}.`);
      }
      const dataSize = type === "file" ? size : 0;

      if (!rel) {
        // The folder itself ("./").
        await skip(dataSize);
        continue;
      }
      if (type === "file" || type === "hardlink") {
        count += 1;
        files.add(rel);
      }
      if (type === "symlink") {
        symlinks.set(rel, linkname);
        files.delete(rel);
      }
      if (type === "dir") files.delete(rel);

      if (!root) {
        bytes += dataSize;
        await skip(dataSize);
        continue;
      }
      const target = path.join(root, ...rel.split("/"));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      if (type === "dir") {
        await fs.promises.mkdir(target, { recursive: true });
        continue;
      }
      // A later entry for the same path replaces the earlier one (never follows it).
      await fs.promises.rm(target, { recursive: true, force: true });
      if (type === "symlink") {
        await fs.promises.symlink(linkname, target);
        continue;
      }
      if (type === "hardlink") {
        await fs.promises.copyFile(path.join(root, ...hardTarget.split("/")), target);
        continue;
      }
      const handle = await fs.promises.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, (header.mode & 0o777) | 0o600);
      try {
        let left = dataSize;
        while (left > 0) {
          const chunk = await reader.some(Math.min(left, 1 << 20));
          if (!chunk.length) throw new ArchiveError("The upload ends in the middle of a file.");
          await handle.write(chunk);
          left -= chunk.length;
          bytes += chunk.length;
          if (opts.onProgress && bytes - reported >= 64 << 20) {
            reported = bytes;
            await opts.onProgress(bytes);
          }
        }
      } finally {
        await handle.close();
      }
      await skipPadding(dataSize);
    }
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR" || code === "ERR_STREAM_PREMATURE_CLOSE") throw new ArchiveError("The upload is not a valid .tar.gz archive.");
    throw e;
  } finally {
    input.unpipe?.(gunzip);
    gunzip.destroy();
  }
  const escaping = symlinkEscapes(symlinks);
  if (escaping.length) throw new ArchiveError(`The upload has a symlink that points outside the folder: ${escaping[0]} -> ${symlinks.get(escaping[0])}.`);
  return { files: count, bytes };

  async function readPadded(size: number) {
    if (size > 1 << 20) throw new ArchiveError("The upload has an extended header that is too large.");
    const data = await reader.read(size);
    if (data.length < size) throw new ArchiveError("The upload ends in the middle of a file.");
    await skipPadding(size);
    return data;
  }
  async function skipPadding(size: number) {
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad && (await reader.read(pad)).length < pad) throw new ArchiveError("The upload ends in the middle of a file.");
  }
}

/** Checks an archive on disk: its file count and unpacked size, or an ArchiveError. */
export function checkArchive(file: string) {
  return readArchive(fs.createReadStream(file));
}

/** Unpacks a checked archive into an empty folder. */
export function extractArchive(file: string, into: string, onProgress?: ReadOptions["onProgress"]) {
  return readArchive(fs.createReadStream(file), { into, onProgress });
}
