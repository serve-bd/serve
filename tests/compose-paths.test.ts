import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composeLocalPaths, composeSecurityIssues, pathsOutside } from "@/server/security";
import { repoUrlProblem } from "@/lib/repo-url";

describe("compose options that reach the host", () => {
  it("refuses host files through secrets and configs, other containers' volumes and host cgroups", () => {
    const issues = composeSecurityIssues(`services:
  a:
    image: x
    volumes_from: [serve-db]
    cgroup: host
    build:
      context: .
      ssh: [default]
      secrets: [token]
      additional_contexts:
        up: ../..
        img: docker-image://alpine
secrets:
  token:
    file: /var/run/docker.sock
  local:
    file: ./token.txt
configs:
  conf:
    file: ../../etc/passwd
`);
    const text = issues.join("|");
    for (const part of ["volumes_from", "cgroup: host", "build.ssh", "build.secrets", 'build context "../.."', "secrets token", "configs conf"]) expect(text).toContain(part);
    expect(text).not.toContain("docker-image");
    expect(text).not.toContain("secrets local");
  });
});

describe("paths a compose file reads on the host", () => {
  it("lists bind sources, env files, contexts, Dockerfiles and secret files relative to the file", () => {
    const paths = composeLocalPaths(
      `services:
  a:
    image: x
    env_file: [.env]
    volumes: ["./data:/data", "named:/n", { type: bind, source: ./conf, target: /c }]
    build: { context: ./app, dockerfile: Dockerfile.prod }
secrets:
  s: { file: ./secret.txt }
`,
      "/repo",
    );
    expect(paths.sort()).toEqual(["/repo/.env", "/repo/app", "/repo/app/Dockerfile.prod", "/repo/conf", "/repo/data", "/repo/secret.txt"]);
  });

  it("finds a symlink in the repository that leads outside it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-repo-"));
    fs.mkdirSync(path.join(root, "inside"));
    fs.symlinkSync("/etc", path.join(root, "data"));
    fs.symlinkSync(path.join(root, "inside"), path.join(root, "ok"));
    const out = await pathsOutside(root, [path.join(root, "data"), path.join(root, "ok"), path.join(root, "inside"), path.join(root, "missing")]);
    expect(out).toEqual([path.join(root, "data")]);
  });
});

describe("repository addresses", () => {
  it("accepts https, ssh and scp-like addresses only", () => {
    for (const ok of ["https://github.com/a/b.git", "http://git.local/x/y", "ssh://git@host/a/b", "git@github.com:a/b.git"]) expect(repoUrlProblem(ok)).toBeNull();
    for (const bad of ["file:///etc", "/srv/repo", "../repo", "-upload-pack=x", "ext::sh -c x", "https://", "git@host:", "https://a.com/ x"])
      expect(repoUrlProblem(bad)).not.toBeNull();
  });
});
