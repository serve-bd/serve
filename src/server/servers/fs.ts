import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { sftp, sh, sshExec, type SshTarget } from "./ssh";

/** File access on a server's disk: the local filesystem or SFTP. */
export type ServerFs = {
  readFile(file: string): Promise<string>;
  readBuffer(file: string): Promise<Buffer>;
  /** Writes atomically (temp file + rename). */
  writeFile(file: string, content: string | Buffer, mode?: number): Promise<void>;
  /** Writes only when the content differs. Returns true when the file changed. */
  writeIfChanged(file: string, content: string): Promise<boolean>;
  exists(file: string): Promise<boolean>;
  stat(file: string): Promise<{ size: number; mtime: Date; isDirectory: boolean } | null>;
  readdir(dir: string): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
  rm(target: string): Promise<void>;
  /**
   * Copies a local directory into `remoteDir`, replacing the files it contains. Other files in
   * `remoteDir` stay (data of relative bind mounts).
   */
  uploadDir(localDir: string, remoteDir: string): Promise<void>;
  /**
   * Deletes paths (relative to `root`) inside `root`. A path whose parent directory resolves
   * outside `root` (a symlink a container planted) is skipped.
   */
  removeInside(root: string, relPaths: string[]): Promise<void>;
  /** Reads bytes from `offset` (for tailing logs). */
  readFrom(file: string, offset: number, maxBytes: number): Promise<Buffer>;
  /**
   * Looks up these paths and the entries of these directories in one go, so the stat, exists,
   * mkdir, readdir and writeIfChanged calls that follow need no trip to the server. Optional:
   * nothing to gain on the local disk.
   */
  prefetch?(paths: string[], dirs?: string[]): Promise<void>;
};

export const localFs: ServerFs = {
  readFile: (file) => fs.readFile(file, "utf8"),
  readBuffer: (file) => fs.readFile(file),
  async writeFile(file, content, mode) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // A random name: two writes of the same file at once would otherwise share one temp file.
    const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, content, mode ? { mode } : undefined);
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  },
  async writeIfChanged(file, content) {
    try {
      if ((await fs.readFile(file, "utf8")) === content) return false;
    } catch {
      // missing
    }
    await localFs.writeFile(file, content);
    return true;
  },
  exists: (file) =>
    fs.access(file).then(
      () => true,
      () => false,
    ),
  async stat(file) {
    const s = await fs.stat(file).catch(() => null);
    return s ? { size: s.size, mtime: s.mtime, isDirectory: s.isDirectory() } : null;
  },
  readdir: (dir) => fs.readdir(dir).catch(() => []),
  mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
  rm: (target) => fs.rm(target, { recursive: true, force: true }),
  async uploadDir(localDir, remoteDir) {
    if (path.resolve(localDir) === path.resolve(remoteDir)) return;
    await fs.mkdir(remoteDir, { recursive: true });
    await fs.cp(localDir, remoteDir, { recursive: true, force: true });
  },
  async removeInside(root, relPaths) {
    const realRoot = await fs.realpath(root).catch(() => null);
    if (!realRoot) return;
    for (const rel of relPaths) {
      const parent = await fs.realpath(path.join(root, path.dirname(rel))).catch(() => null);
      if (!parent || (parent !== realRoot && !parent.startsWith(realRoot + path.sep))) continue;
      await fs.rm(path.join(parent, path.basename(rel)), { recursive: true, force: true });
    }
  },
  async readFrom(file, offset, maxBytes) {
    const handle = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

function sftpCall<T>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value as T))));
}

export function remoteFs(target: SshTarget): ServerFs {
  const session = () => sftp(target);
  const run = async (command: string) => {
    const r = await sshExec(target, command, { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `Command failed: ${command}`);
    return r.stdout;
  };
  const readBuffer = async (file: string) => {
    const s = await session();
    return sftpCall<Buffer>((cb) => s.readFile(file, cb));
  };
  /*
   * Every call is a few round trips to the server (hundreds of milliseconds far away). What this
   * client wrote and made is remembered, so an unchanged file costs one stat instead of a read,
   * and a directory it made is not made again.
   */
  const written = new Map<string, { size: number; mtime: number; hash: string }>();
  const made = new Set<string>();
  /*
   * A short-lived picture of paths looked up together by prefetch (null: missing), and of the
   * directories listed with them. This client's own writes and removals keep it current; it is
   * dropped after a few seconds, so changes made by others are seen again.
   */
  type Seen = { dir: boolean; size: number; mtime: number; hash: string | null } | null;
  let seen = new Map<string, Seen>();
  let listed = new Map<string, Set<string>>();
  let seenAt = 0;
  const SEEN_MS = 15_000;
  const fresh = () => Date.now() - seenAt < SEEN_MS;
  const unsee = (target: string) => {
    for (const key of [...seen.keys()]) if (key === target || key.startsWith(`${target}/`)) seen.set(key, null);
    for (const key of [...listed.keys()]) if (key === target || key.startsWith(`${target}/`)) listed.delete(key);
    listed.get(path.posix.dirname(target))?.delete(path.posix.basename(target));
  };
  // A folder (and its parents) now exists: remembered, and shown as such to a fresh lookup.
  const madeDirs = (dir: string) => {
    for (let d = dir; d && d !== "/" && d !== "."; d = path.posix.dirname(d)) {
      made.add(d);
      if (seen.has(d)) seen.set(d, { dir: true, size: 0, mtime: 0, hash: null });
      listed.get(path.posix.dirname(d))?.add(path.posix.basename(d));
    }
  };
  const forget = (target: string) => {
    for (const key of [...written.keys(), ...made]) if (key === target || key.startsWith(`${target}/`)) written.delete(key), made.delete(key);
    unsee(target);
  };
  const sha = (content: string | Buffer) => crypto.createHash("sha256").update(content).digest("hex");
  /*
   * One command writes a file: its folder, a temp file from stdin, then an atomic rename. It
   * prints the new size and time, which writeIfChanged remembers. (SFTP would be four or five
   * round trips.)
   */
  const put = async (file: string, content: string | Buffer, mode?: number) => {
    const dir = path.posix.dirname(file);
    const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.serve.tmp`;
    const write = mode ? `(umask 077 && cat > ${sh(tmp)}) && chmod ${mode.toString(8)} ${sh(tmp)}` : `cat > ${sh(tmp)}`;
    const command = `mkdir -p ${sh(dir)} && ${write} && mv -f ${sh(tmp)} ${sh(file)} && stat -c '%s %Y' -- ${sh(file)} || { rm -f ${sh(tmp)}; exit 1; }`;
    seen.delete(file);
    written.delete(file);
    const r = await sshExec(target, command, { timeoutMs: 120_000, stdin: typeof content === "string" ? content : () => Readable.from([content]) });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `Could not write ${file}`);
    madeDirs(dir);
    listed.get(dir)?.add(path.posix.basename(file));
    const [size, mtime] = r.stdout.trim().split(/\s+/).map(Number);
    return { size, mtime: mtime * 1000 };
  };
  const self: ServerFs = {
    readFile: async (file) => (await readBuffer(file)).toString("utf8"),
    readBuffer,
    async writeFile(file, content, mode) {
      await put(file, content, mode);
    },
    async writeIfChanged(file, content) {
      const hash = sha(content);
      const pre = fresh() ? seen.get(file) : undefined;
      if (pre && !pre.dir) {
        if (pre.hash === hash) {
          written.set(file, { size: pre.size, mtime: pre.mtime, hash });
          return false;
        }
        written.set(file, { ...(await put(file, content)), hash });
        return true;
      }
      const st = await self.stat(file);
      const known = written.get(file);
      if (st && known && known.size === st.size && known.mtime === st.mtime.getTime()) {
        if (known.hash === hash) return false;
      } else if (st && st.size === Buffer.byteLength(content) && !st.isDirectory) {
        // Not written by this client (or changed since): compare on the server, not by downloading it.
        const remote = (await run(`sha256sum -- ${sh(file)}`).catch(() => "")).split(/\s/)[0];
        if (remote === hash) {
          written.set(file, { size: st.size, mtime: st.mtime.getTime(), hash });
          return false;
        }
      }
      written.set(file, { ...(await put(file, content)), hash });
      return true;
    },
    async exists(file) {
      return (await self.stat(file)) !== null;
    },
    async stat(file) {
      const pre = fresh() ? seen.get(file) : undefined;
      if (pre !== undefined) return pre ? { size: pre.size, mtime: new Date(pre.mtime), isDirectory: pre.dir } : null;
      // Not among the entries of a directory just listed: it does not exist.
      if (fresh() && listed.get(path.posix.dirname(file))?.has(path.posix.basename(file)) === false) return null;
      const s = await session();
      const st = await sftpCall<import("ssh2").Stats>((cb) => s.stat(file, cb)).catch(() => null);
      return st ? { size: st.size, mtime: new Date(st.mtime * 1000), isDirectory: st.isDirectory() } : null;
    },
    async readdir(dir) {
      const pre = fresh() ? listed.get(dir) : undefined;
      if (pre) return [...pre];
      const s = await session();
      const list = await sftpCall<{ filename: string }[]>((cb) => s.readdir(dir, cb)).catch(() => []);
      return list.map((e) => e.filename);
    },
    async mkdir(dir) {
      if (made.has(dir)) return;
      if (fresh() && seen.get(dir)?.dir) {
        made.add(dir);
        return;
      }
      await run(`mkdir -p ${sh(dir)}`);
      madeDirs(dir);
    },
    async rm(target) {
      forget(target);
      await run(`rm -rf ${sh(target)}`);
    },
    async uploadDir(localDir, remoteDir) {
      // Stream a tarball over SSH; much faster than per-file SFTP for repositories.
      let tarError = "";
      const pack = () => {
        const tar = spawn("tar", ["-C", localDir, "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"] });
        tar.stderr.on("data", (d) => (tarError += d));
        return tar.stdout;
      };
      // Extracted over the existing copy: tar replaces files (and symlinks) it has entries for.
      const r = await sshExec(target, `mkdir -p ${sh(remoteDir)} && tar -xf - -C ${sh(remoteDir)}`, {
        stdin: pack,
        timeoutMs: 15 * 60_000,
      });
      if (r.code !== 0) throw new Error(`Upload to the server failed: ${(r.stderr || tarError).trim()}`);
    },
    async removeInside(root, relPaths) {
      // In batches, to keep each command well under the argument length limit.
      for (let i = 0; i < relPaths.length; i += 200) {
        const list = relPaths
          .slice(i, i + 200)
          .map(sh)
          .join(" ");
        await run(
          `root=$(realpath -e -- ${sh(root)} 2>/dev/null) || exit 0; for p in ${list}; do ` +
            `parent=$(realpath -e -- "$root/$(dirname -- "$p")" 2>/dev/null) || continue; ` +
            `case "$parent/" in "$root"/*) rm -rf -- "$parent/$(basename -- "$p")" ;; esac; done`,
        );
      }
    },
    async prefetch(paths, dirs = []) {
      // Each line: kind, size, mtime (seconds), sha256 (files) and the path; L lines name a directory's entries.
      const script =
        'one() { if [ -d "$1" ]; then printf "D\\t0\\t0\\t-\\t%s\\n" "$1"; ' +
        'elif [ -f "$1" ]; then printf "F\\t%s\\t%s\\t%s\\t%s\\n" "$(stat -c %s -- "$1")" "$(stat -c %Y -- "$1")" "$(sha256sum < "$1" | cut -d" " -f1)" "$1"; ' +
        'else printf "N\\t0\\t0\\t-\\t%s\\n" "$1"; fi; }; ' +
        'list=0; for a in "$@"; do if [ "$a" = "::list::" ]; then list=1; continue; fi; ' +
        'if [ $list = 1 ]; then one "$a"; [ -d "$a" ] || continue; printf "L\\t0\\t0\\t-\\t%s\\n" "$a"; ' +
        'for e in "$a"/* "$a"/.[!.]*; do [ -e "$e" ] || continue; printf "E\\t0\\t0\\t-\\t%s\\n" "$e"; one "$e"; done; else one "$a"; fi; done';
      const out = await run(`sh -c ${sh(script)} sh ${[...paths, "::list::", ...dirs].map(sh).join(" ")}`);
      const nextSeen = new Map<string, Seen>();
      const nextListed = new Map<string, Set<string>>();
      for (const line of out.split("\n")) {
        const [kind, size, mtime, hash, ...rest] = line.split("\t");
        const file = rest.join("\t");
        if (!file) continue;
        if (kind === "N") nextSeen.set(file, null);
        else if (kind === "D") nextSeen.set(file, { dir: true, size: 0, mtime: 0, hash: null });
        else if (kind === "F") nextSeen.set(file, { dir: false, size: Number(size), mtime: Number(mtime) * 1000, hash });
        else if (kind === "L") nextListed.set(file, new Set());
        else if (kind === "E") nextListed.get(path.posix.dirname(file))?.add(path.posix.basename(file));
      }
      seen = nextSeen;
      listed = nextListed;
      seenAt = Date.now();
    },
    async readFrom(file, offset, maxBytes) {
      const s = await session();
      const handle = await sftpCall<Buffer>((cb) => s.open(file, "r", cb));
      try {
        const buf = Buffer.alloc(maxBytes);
        const bytesRead = await new Promise<number>((resolve, reject) => s.read(handle, buf, 0, maxBytes, offset, (err, n) => (err ? reject(err) : resolve(n))));
        return buf.subarray(0, bytesRead);
      } finally {
        await sftpCall<void>((cb) => s.close(handle, cb)).catch(() => {});
      }
    },
  };
  return self;
}
