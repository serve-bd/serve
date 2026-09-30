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
      return { url, cloneUrl: url, gitEnv: { ...gitEnv, ...tokenConfig(url, "github", token) }, redact };
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
  return { url, cloneUrl, gitEnv, redact };
}

export async function cloneRepository(
  source: GitSource,
  dir: string,
  log: (line: string) => void,
  signal?: AbortSignal,
  organizationId?: string | null,
  opts: { submodules?: boolean } = {},
): Promise<CloneResult> {
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
  const [commitSha, commitAuthor, commitMessage] = out.trim().split("\x1f");
  log(`Checked out ${commitSha.slice(0, 7)} — ${commitMessage}`);
  return { dir, commitSha, commitAuthor, commitMessage };
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
