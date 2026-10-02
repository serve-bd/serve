import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { run } from "@/server/process";
import type { GitSource } from "@/server/services/types";

export type CloneResult = {
  dir: string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  /** In-place updates: the tracked files of the checkout, submodules' included (see staleEntries). */
  files?: string[];
};

/**
 * Git config (through the environment) that sends a token to the repository's host only.
 * Kept out of the clone URL, so it never lands in .git/config or in an image built from the repo.
 * GitHub x-access-token, Bitbucket x-token-auth, GitLab/Gitea oauth2 (token as password).
 */
export function tokenConfig(url: string, provider: string, token: string): Record<string, string> {
  const user = provider === "github" ? "x-access-token" : provider === "bitbucket" ? "x-token-auth" : "oauth2";
  const basic = Buffer.from(`${user}:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${new URL(url).origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

export { repoUrlProblem } from "@/lib/repo-url";
import { repoUrlProblem } from "@/lib/repo-url";

export function normalizeRepoUrl(input: string) {
  const value = input.trim();
  // owner/repo shorthand → GitHub
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}.git`;
  return value;
}

/** Build the clone URL and git environment for a source. */
export async function gitAccess(source: GitSource, workDir: string, organizationId?: string | null) {
  const url = normalizeRepoUrl(source.repository);
  const problem = repoUrlProblem(url);
  if (problem) throw new Error(problem);
  const gitEnv: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    // Submodules and redirects included: only network transports, never local files or helpers.
    GIT_ALLOW_PROTOCOL: "http:https:ssh:git",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR",
  };
  const cloneUrl = url;
  const redact: string[] = [];

  if (source.credentialId) {
    const [cred] = await db
      .select()
      .from(schema.gitCredential)
      .where(
        organizationId
          ? and(eq(schema.gitCredential.id, source.credentialId), eq(schema.gitCredential.organizationId, organizationId))
          : eq(schema.gitCredential.id, source.credentialId),
      );
    if (!cred) throw new Error("The git credential for this service no longer exists.");
    if (cred.provider === "github-app") {
      const { installationToken } = await import("@/server/git/github-app");
      const token = await installationToken(cred);
      redact.push(token);
      const env = { ...gitEnv, ...tokenConfig(url, "github", token) };
      await pinPublicGitHost(url, organizationId, env);
      return { url, cloneUrl: url, gitEnv: env, redact };
    }
    // OAuth credentials hold a token set and refresh the access token when needed.
    const { credentialToken } = await import("@/server/git/oauth");
    const secret = await credentialToken(cred);
    redact.push(secret);
    if (cred.provider === "ssh" || url.startsWith("git@") || url.startsWith("ssh://")) {
      const keyFile = path.join(workDir, ".serve-ssh-key");
      await fs.mkdir(workDir, { recursive: true });
      await fs.writeFile(keyFile, secret.trim() + "\n", { mode: 0o600 });
      gitEnv.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
    } else {
      Object.assign(gitEnv, tokenConfig(url, cred.provider, secret));
    }
  }
  await pinPublicGitHost(url, organizationId, gitEnv);
  return { url, cloneUrl, gitEnv, redact };
}

/** Adds one `git -c key=value` through the environment, after any already set. */
function addGitConfig(env: Record<string, string>, key: string, value: string) {
  const n = Number(env.GIT_CONFIG_COUNT ?? 0);
  env[`GIT_CONFIG_KEY_${n}`] = key;
  env[`GIT_CONFIG_VALUE_${n}`] = value;
  env.GIT_CONFIG_COUNT = String(n + 1);
}

/**
 * Organizations other than Root reach public git servers only (the clone runs next to Serve).
 * Checked when connecting, not only when the URL was saved: DNS can change in between. Over
 * HTTP(S), git connects to the address checked here, so the name cannot resolve differently.
 */
async function pinPublicGitHost(url: string, organizationId: string | null | undefined, env: Record<string, string>) {
  if (!organizationId) return;
  const { getSetting } = await import("@/server/settings");
  if (organizationId === (await getSetting("rootOrganizationId"))) return;
  const scp = /^[\w.-]+@([\w.-]+):/.exec(url);
  const parsed = scp ? null : new URL(url);
  const host = (scp?.[1] ?? parsed?.hostname ?? "").replace(/^\[|\]$/g, "");
  const { publicAddress } = await import("@/server/net/public-host");
  const address = host ? await publicAddress(host) : null;
  if (!address) throw new Error("That git server is on a private network or does not resolve.");
  if (parsed && (parsed.protocol === "https:" || parsed.protocol === "http:")) {
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    addGitConfig(env, "http.curloptResolve", `${host}:${port}:${address.includes(":") ? `[${address}]` : address}`);
  }
}

export async function cloneRepository(
  source: GitSource,
  dir: string,
  log: (line: string) => void,
  signal?: AbortSignal,
  organizationId?: string | null,
  opts: { submodules?: boolean; inPlace?: boolean } = {},
): Promise<CloneResult> {
  if (opts.inPlace) return updateInPlace(source, dir, log, signal, organizationId, opts);
  await fs.rm(dir, { recursive: true, force: true });
  const parent = path.dirname(dir);
  await fs.mkdir(parent, { recursive: true });
  const access = await gitAccess(source, `${dir}.auth`, organizationId);

  try {
    log(`Cloning ${access.url} (branch ${source.branch})`);
    await run(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        source.branch,
        "--single-branch",
        ...(opts.submodules === false ? [] : ["--recurse-submodules", "--shallow-submodules"]),
        "--",
        access.cloneUrl,
        dir,
      ],
      { env: access.gitEnv, onLine: log, signal, redact: access.redact },
    );
  } finally {
    await fs.rm(`${dir}.auth`, { recursive: true, force: true });
  }

  const out = await run("git", ["-C", dir, "log", "-1", "--format=%H%x1f%an%x1f%s"]);
  return checkedOut(dir, out, log);
}

function checkedOut(dir: string, out: string, log: (line: string) => void): CloneResult {
  const [commitSha, commitAuthor, commitMessage] = out.trim().split("\x1f");
  log(`Checked out ${commitSha.slice(0, 7)} — ${commitMessage}`);
  return { dir, commitSha, commitAuthor, commitMessage };
}

/**
 * Brings `dir` to the branch's latest commit without deleting it, so files the
 * repository does not track (data of relative bind mounts) survive deploys.
 * Git's own files live next to it in `<dir>.git`: containers may write inside
 * `dir`, and git must never read a config or hooks they could plant there.
 */
async function updateInPlace(
  source: GitSource,
  dir: string,
  log: (line: string) => void,
  signal: AbortSignal | undefined,
  organizationId: string | null | undefined,
  opts: { submodules?: boolean },
): Promise<CloneResult> {
  const gitDir = `${dir}.git`;
  await fs.mkdir(dir, { recursive: true });
  // A checkout from before git's files moved out of the work tree.
  await fs.rm(path.join(dir, ".git"), { recursive: true, force: true });
  const git = (args: string[], options: Parameters<typeof run>[2] = {}) =>
    run("git", ["--git-dir", gitDir, "--work-tree", dir, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "safe.directory=*", ...args], {
      cwd: dir,
      ...options,
    });
  // Deploys of a service run one at a time: a lock file is left over from a killed deploy.
  for (const entry of await fs.readdir(gitDir, { recursive: true }).catch(() => [] as string[])) {
    if (entry.endsWith(".lock")) await fs.rm(path.join(gitDir, entry), { force: true });
  }
  const access = await gitAccess(source, `${dir}.auth`, organizationId);
  const options = { env: access.gitEnv, onLine: log, signal, redact: access.redact };
  const update = async () => {
    if (!(await fs.stat(path.join(gitDir, "HEAD")).catch(() => null))) await git(["init", "--quiet"]);
    // Relative submodule URLs resolve against origin. The URL holds no credentials; those come from the environment.
    await git(["config", "remote.origin.url", access.cloneUrl]);
    await git(["fetch", "--depth", "1", "--no-tags", "--", access.cloneUrl, source.branch], options);
    // Tracked files take the new commit's content and files removed from git go; untracked files stay.
    await git(["reset", "--quiet", "--hard", "FETCH_HEAD"], options);
    if (opts.submodules !== false) {
      // Checked out again from scratch, so git writes each submodule's .git file itself.
      const realDir = await fs.realpath(dir);
      for (const entry of (await git(["ls-files", "--stage", "-z"])).split("\0")) {
        const [meta, file] = entry.split("\t");
        if (!meta?.startsWith("160000 ") || !file) continue;
        const target = path.join(dir, file);
        const parent = await fs.realpath(path.dirname(target)).catch(() => null);
        if (!parent || (parent !== realDir && !parent.startsWith(realDir + path.sep))) throw new Error(`Submodule path ${file} leads outside the repository.`);
        await fs.rm(path.join(parent, path.basename(target)), { recursive: true, force: true });
      }
      await git(["submodule", "sync", "--quiet", "--recursive"], options);
      await git(["submodule", "update", "--init", "--recursive", "--depth", "1"], options);
    }
  };

  try {
    log(`Fetching ${access.url} (branch ${source.branch})`);
    try {
      await update();
    } catch (error) {
      // Unreachable repository or branch: a new git directory would not help.
      const output = `${(error as Error).message}\n${(error as { output?: string }).output ?? ""}`;
      if (signal?.aborted || /could not read|authentication failed|not found|couldn't find remote ref|could not resolve host|unable to access/i.test(output)) throw error;
      // A damaged git directory: start it again. Only git's own files, never the work tree and its data.
      log(`Git update failed (${(error as Error).message}); fetching again into a new git directory`);
      await fs.rm(gitDir, { recursive: true, force: true });
      await update();
    }
  } finally {
    await fs.rm(`${dir}.auth`, { recursive: true, force: true });
  }

  const files = (await git(["ls-files", "-z", ...(opts.submodules === false ? [] : ["--recurse-submodules"])])).split("\0").filter(Boolean);
  return { ...checkedOut(dir, await git(["log", "-1", "--format=%H%x1f%an%x1f%s"]), log), files };
}

/**
 * What a copy of an older checkout must delete before the new files are extracted over it:
 * files no longer tracked, and paths that were directories and are now files (a directory in
 * the way of a file). A file that became a directory is already in the first group.
 */
export function staleEntries(previous: string[], current: string[]): string[] {
  const now = new Set(current);
  const dirs = new Set(
    previous.flatMap((file) =>
      file
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
    ),
  );
  return [...previous.filter((file) => !now.has(file)), ...current.filter((file) => dirs.has(file))];
}

/** Quick remote check used by the UI to validate a repository and list branches. */
export async function listRemoteBranches(source: GitSource, organizationId?: string | null): Promise<string[]> {
  const tmp = path.join((await import("node:os")).tmpdir(), `serve-ls-${Date.now()}`);
  const access = await gitAccess(source, tmp, organizationId);
  try {
    const out = await run("git", ["ls-remote", "--heads", "--", access.cloneUrl], {
      env: access.gitEnv,
      redact: access.redact,
    });
    return out
      .split("\n")
      .map((l) => l.split("refs/heads/")[1])
      .filter(Boolean);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
