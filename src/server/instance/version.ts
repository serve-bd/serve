import fs from "node:fs";
import path from "node:path";
import pkg from "../../../package.json";

/** Version of the running code: the image's release tag when built by CI, else package.json. */
export function currentVersion(): string {
  return (process.env.SERVE_BUILD_VERSION || pkg.version).replace(/^v/i, "");
}

let cachedCommit: string | null | undefined;

/** Git commit of the running code: baked into release images, read from .git in development. */
export function currentCommit(): string | null {
  if (cachedCommit !== undefined) return cachedCommit;
  cachedCommit = process.env.SERVE_COMMIT || readGitHead(process.cwd());
  return cachedCommit;
}

/** Development only (release images carry SERVE_COMMIT). The ignore comments keep the build from tracing the whole project. */
function readGitHead(dir: string): string | null {
  try {
    let gitDir = path.join(dir, ".git");
    // Worktrees and submodules keep a "gitdir: <path>" file instead of a directory.
    if (fs.statSync(/*turbopackIgnore: true*/ gitDir).isFile())
      gitDir = path.resolve(
        /*turbopackIgnore: true*/ dir,
        fs
          .readFileSync(/*turbopackIgnore: true*/ gitDir, "utf8")
          .replace(/^gitdir:\s*/, "")
          .trim(),
      );
    const head = fs.readFileSync(/*turbopackIgnore: true*/ path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head;
    const ref = head.slice(4).trim();
    // Worktrees keep branch refs in the shared git directory.
    const common = fs.existsSync(/*turbopackIgnore: true*/ path.join(gitDir, "commondir"))
      ? path.resolve(/*turbopackIgnore: true*/ gitDir, fs.readFileSync(/*turbopackIgnore: true*/ path.join(gitDir, "commondir"), "utf8").trim())
      : gitDir;
    for (const base of [gitDir, common]) {
      const loose = path.join(base, ref);
      if (fs.existsSync(/*turbopackIgnore: true*/ loose)) return fs.readFileSync(/*turbopackIgnore: true*/ loose, "utf8").trim();
    }
    const packed = fs.readFileSync(/*turbopackIgnore: true*/ path.join(common, "packed-refs"), "utf8");
    return (
      packed
        .split("\n")
        .find((l) => l.endsWith(` ${ref}`))
        ?.split(" ")[0] ?? null
    );
  } catch {
    return null;
  }
}

/** Repository whose GitHub releases announce updates. */
export function updateRepository() {
  return process.env.SERVE_UPDATE_REPO || "serve-bd/serve";
}
