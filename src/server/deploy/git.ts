import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { decrypt } from "@/server/crypto";
import { run } from "@/server/process";
import type { GitSource } from "@/server/services/types";

export type CloneResult = {
  dir: string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
};

function withToken(url: string, provider: string, token: string) {
  const u = new URL(url);
  const user =
    provider === "github" ? "x-access-token" : provider === "bitbucket" ? "x-token-auth" : "oauth2";
  u.username = user;
  u.password = token;
  return u.toString();
}

export function normalizeRepoUrl(input: string) {
  const value = input.trim();
  // owner/repo shorthand → GitHub
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}.git`;
  return value;
}

/** Build the clone URL and git environment for a source. */
export async function gitAccess(source: GitSource, workDir: string, organizationId?: string | null) {
  const url = normalizeRepoUrl(source.repository);
  const gitEnv: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR",
  };
  let cloneUrl = url;
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
      return { url, cloneUrl: withToken(url, "github", token), gitEnv, redact };
    }
    const secret = decrypt(cred.secret);
    redact.push(secret);
    if (cred.provider === "ssh" || url.startsWith("git@") || url.startsWith("ssh://")) {
      const keyFile = path.join(workDir, ".serve-ssh-key");
      await fs.mkdir(workDir, { recursive: true });
      await fs.writeFile(keyFile, secret.trim() + "\n", { mode: 0o600 });
      gitEnv.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
    } else {
      cloneUrl = withToken(url, cred.provider, secret);
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
    const out = await run("git", ["ls-remote", "--heads", access.cloneUrl], {
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
