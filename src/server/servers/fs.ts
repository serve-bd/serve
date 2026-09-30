import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { SFTPWrapper } from "ssh2";
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
};

export const localFs: ServerFs = {
  readFile: (file) => fs.readFile(file, "utf8"),
  readBuffer: (file) => fs.readFile(file),
  async writeFile(file, content, mode) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, content, mode ? { mode } : undefined);
    await fs.rename(tmp, file);
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
  const self: ServerFs = {
    readFile: async (file) => (await readBuffer(file)).toString("utf8"),
    readBuffer,
    async writeFile(file, content, mode) {
      const s: SFTPWrapper = await session();
      await self.mkdir(path.posix.dirname(file));
      const tmp = `${file}.serve.tmp`;
      await sftpCall<void>((cb) => s.writeFile(tmp, content, mode ? { mode } : {}, cb));
      // posix-rename@openssh.com replaces the target atomically.
      await sftpCall<void>((cb) => s.ext_openssh_rename(tmp, file, cb)).catch(() => run(`mv -f ${sh(tmp)} ${sh(file)}`));
    },
    async writeIfChanged(file, content) {
      const current = await self.readFile(file).catch(() => null);
      if (current === content) return false;
      await self.writeFile(file, content);
      return true;
    },
    async exists(file) {
      return (await self.stat(file)) !== null;
    },
    async stat(file) {
      const s = await session();
      const st = await sftpCall<import("ssh2").Stats>((cb) => s.stat(file, cb)).catch(() => null);
      return st ? { size: st.size, mtime: new Date(st.mtime * 1000), isDirectory: st.isDirectory() } : null;
    },
    async readdir(dir) {
      const s = await session();
      const list = await sftpCall<{ filename: string }[]>((cb) => s.readdir(dir, cb)).catch(() => []);
      return list.map((e) => e.filename);
    },
    mkdir: async (dir) => void (await run(`mkdir -p ${sh(dir)}`)),
    rm: async (target) => void (await run(`rm -rf ${sh(target)}`)),
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
