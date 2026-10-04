import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { paths } from "@/server/paths";
import { commandExists, redactor, run } from "@/server/process";
import { sh } from "@/server/servers/ssh";
import type { ServerCtx } from "@/server/servers/context";
import type { BuildConfig } from "@/server/services/types";
import { scopeCacheMounts } from "@/server/security";
import { buildArgFlags } from "./options";
import { declareBuildArgs } from "@/lib/dockerfile";
import { type BuildNetwork, builderFlags, builderName, ensureBuilder, serverCli, withBuilder } from "./build-network";

export type BuildContext = {
  /** Absolute path of the build context (repo + rootDir). */
  contextDir: string;
  image: string;
  build: BuildConfig;
  buildEnv: Record<string, string>;
  labels: Record<string, string>;
  log: (line: string) => void;
  signal?: AbortSignal;
  redact: string[];
  /** Points the docker CLI (and nixpacks) at the target server; empty for the local server. */
  dockerEnv?: Record<string, string>;
  /** Prefix for BuildKit cache mount ids and the nixpacks cache key (per organization). */
  cacheScope: string;
  /** Target platform, like linux/arm64; unset builds for the server's own. */
  platform?: string | null;
  /** The environment network the build may reach, with its services' names (Dockerfile builds). */
  network?: BuildNetwork | null;
  /**
   * Another server to build on: the files go there as one archive over SSH and the build runs on the
   * server itself. Docker's own transfer of a build context sends many small messages, each waiting
   * for an answer, which is very slow over a long SSH path (a machine behind a tunnel).
   */
  remote?: { server: Pick<ServerCtx, "local" | "exec">; buildsDir: string } | null;
  /** The commit being built: Dockerfiles read it with `ARG SOURCE_COMMIT`. */
  commit?: string | null;
};

export type BuildResult = {
  /** Port detected for the built app, when the builder knows it. */
  detectedPort?: number;
  builder: string;
};

async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  engines?: { node?: string };
};

type Detected = { kind: string; dockerfile: string; port: number };

function nodeMajor(pkg: PackageJson) {
  const spec = pkg.engines?.node ?? "";
  const match = spec.match(/(\d{2})/);
  const major = match ? Number(match[1]) : 22;
  return [18, 20, 22, 24].includes(major) ? major : 22;
}

async function detectPackageManager(dir: string, pkg: PackageJson) {
  if (pkg.packageManager?.startsWith("pnpm") || (await exists(path.join(dir, "pnpm-lock.yaml")))) return "pnpm";
  if (pkg.packageManager?.startsWith("yarn") || (await exists(path.join(dir, "yarn.lock")))) return "yarn";
  if ((await exists(path.join(dir, "bun.lockb"))) || (await exists(path.join(dir, "bun.lock")))) return "bun";
  return "npm";
}

const installFor: Record<string, string> = {
  pnpm: "corepack enable && pnpm install --frozen-lockfile || pnpm install",
  yarn: "corepack enable && (yarn install --frozen-lockfile || yarn install)",
  npm: "if [ -f package-lock.json ]; then npm ci; else npm install; fi",
  bun: "bun install",
};

const runFor: Record<string, string> = {
  pnpm: "pnpm run",
  yarn: "yarn run",
  npm: "npm run",
  bun: "bun run",
};

function argLines(env: Record<string, string>) {
  const keys = Object.keys(env).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  return keys.length ? keys.map((k) => `ARG ${k}`).join("\n") + "\n" : "";
}

const STATIC_NGINX_CONF = `server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    location / {
        try_files $uri $uri.html $uri/ /index.html;
    }
    location ~* \\.(?:js|css|woff2?|png|jpe?g|gif|svg|ico|webp|avif)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }
}
`;

function staticStage(from: string, publishDir: string) {
  const dir = publishDir.replace(/^\/+|\/+$/g, "") || ".";
  return `FROM nginx:stable-alpine
COPY .serve.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=${from} /app/${dir === "." ? "" : dir} /usr/share/nginx/html
EXPOSE 80
`;
}

/** Built-in zero-config detection that produces a Dockerfile. */
async function detect(dir: string, build: BuildConfig, env: Record<string, string>): Promise<Detected> {
  const args = argLines(env);
  const pkg = await readJson<PackageJson>(path.join(dir, "package.json"));

  if (build.builder === "static" && !pkg) {
    return {
      kind: "static",
      port: 80,
      dockerfile: `FROM alpine AS source
WORKDIR /app
COPY . .
${staticStage("source", build.publishDir || ".")}`,
    };
  }

  if (pkg) {
    const pm = await detectPackageManager(dir, pkg);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = pkg.scripts ?? {};
    const install = build.installCommand || installFor[pm];
    const buildCmd = build.buildCommand || (scripts.build ? `${runFor[pm]} build` : "");
    const base = pm === "bun" ? "oven/bun:1" : `node:${nodeMajor(pkg)}-slim`;

    const staticFramework = !scripts.start && !build.startCommand && (deps.vite || deps["react-scripts"] || deps.astro || deps["@angular/core"] || deps.parcel);
    if (build.builder === "static" || staticFramework) {
      const publishDir = build.publishDir || (deps["react-scripts"] ? "build" : deps["@angular/core"] ? "dist/browser" : "dist");
      return {
        kind: "static",
        port: 80,
        dockerfile: `FROM ${base} AS build
WORKDIR /app
${args}ENV CI=true
COPY . .
RUN ${install}
RUN ${buildCmd || "true"}
${staticStage("build", publishDir)}`,
      };
    }

    const start = build.startCommand || (scripts.start ? `${runFor[pm]} start` : pm === "bun" ? "bun run index.ts" : "node index.js");
    const isNext = !!deps.next;
    return {
      kind: isNext ? "nextjs" : pm === "bun" ? "bun" : "node",
      port: 3000,
      dockerfile: `FROM ${base}
WORKDIR /app
${args}ENV CI=true NEXT_TELEMETRY_DISABLED=1
${pm !== "bun" ? "RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*\n" : ""}COPY . .
RUN ${install}
${buildCmd ? `RUN ${buildCmd}\n` : ""}ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ${JSON.stringify(["sh", "-c", start])}
`,
    };
  }

  const hasPython = (await exists(path.join(dir, "requirements.txt"))) || (await exists(path.join(dir, "pyproject.toml"))) || (await exists(path.join(dir, "Pipfile")));
  if (hasPython) {
    let start = build.startCommand || "";
    if (!start && (await exists(path.join(dir, "Procfile")))) {
      const procfile = await fs.readFile(path.join(dir, "Procfile"), "utf8");
      start = procfile.match(/^web:\s*(.+)$/m)?.[1] ?? "";
    }
    if (!start && (await exists(path.join(dir, "manage.py")))) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let project = "app";
      for (const e of entries) {
        if (e.isDirectory() && (await exists(path.join(dir, e.name, "wsgi.py")))) project = e.name;
      }
      start = `python manage.py migrate --noinput; gunicorn ${project}.wsgi --bind 0.0.0.0:$PORT`;
    }
    if (!start && (await exists(path.join(dir, "main.py")))) start = "uvicorn main:app --host 0.0.0.0 --port $PORT";
    if (!start && (await exists(path.join(dir, "app.py")))) start = "gunicorn app:app --bind 0.0.0.0:$PORT";
    if (!start) throw new Error("Could not detect how to start this Python app. Set a start command in the build settings.");
    const install =
      build.installCommand ||
      `if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; elif [ -f pyproject.toml ]; then pip install --no-cache-dir .; fi && pip install --no-cache-dir gunicorn uvicorn`;
    return {
      kind: "python",
      port: 8000,
      dockerfile: `FROM python:3.13-slim
WORKDIR /app
${args}ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PORT=8000
COPY . .
RUN ${install}
${build.buildCommand ? `RUN ${build.buildCommand}\n` : ""}EXPOSE 8000
CMD ${JSON.stringify(["sh", "-c", start])}
`,
    };
  }

  if (await exists(path.join(dir, "go.mod"))) {
    return {
      kind: "go",
      port: 8080,
      dockerfile: `FROM golang:1.25-alpine AS build
WORKDIR /src
${args}COPY . .
RUN ${build.buildCommand || "go mod download && CGO_ENABLED=0 go build -ldflags='-s -w' -o /out/app ."}
FROM alpine:3
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/app /app/app
WORKDIR /app
ENV PORT=8080
EXPOSE 8080
CMD ${JSON.stringify(["sh", "-c", build.startCommand || "/app/app"])}
`,
    };
  }

  if (await exists(path.join(dir, "Cargo.toml"))) {
    return {
      kind: "rust",
      port: 8080,
      dockerfile: `FROM rust:1-slim AS build
WORKDIR /src
${args}COPY . .
RUN ${build.buildCommand || "cargo build --release && mkdir -p /out && find target/release -maxdepth 1 -type f -executable -exec cp {} /out/app \\;"}
FROM debian:stable-slim
RUN apt-get update -qq && apt-get install -y -qq ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/app /app/app
ENV PORT=8080
EXPOSE 8080
CMD ${JSON.stringify(["sh", "-c", build.startCommand || "/app/app"])}
`,
    };
  }

  if ((await exists(path.join(dir, "composer.json"))) || (await exists(path.join(dir, "index.php")))) {
    return {
      kind: "php",
      port: 80,
      dockerfile: `FROM php:8.4-apache
RUN a2enmod rewrite
WORKDIR /var/www/html
COPY . .
${(await exists(path.join(dir, "composer.json"))) ? "COPY --from=composer:2 /usr/bin/composer /usr/bin/composer\nRUN apt-get update -qq && apt-get install -y -qq unzip && composer install --no-dev --optimize-autoloader\n" : ""}${(await exists(path.join(dir, "public"))) ? "ENV APACHE_DOCUMENT_ROOT=/var/www/html/public\nRUN sed -ri -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf\n" : ""}EXPOSE 80
`,
    };
  }

  if (await exists(path.join(dir, build.publishDir || ".", "index.html"))) {
    return {
      kind: "static",
      port: 80,
      dockerfile: `FROM alpine AS source
WORKDIR /app
COPY . .
${staticStage("source", build.publishDir || ".")}`,
    };
  }

  throw new Error("Could not detect the language of this repository. Add a Dockerfile, or pick a builder in the build settings.");
}

type DockerBuildOptions = {
  /**
   * A build file read by a BuildKit frontend (Railpack's plan), used as it is: no ARG lines, no
   * build arguments. Build variables reach it as secrets, read from the environment of `docker`.
   */
  frontend?: { syntax: string; secrets: Record<string, string> };
};

async function dockerBuild(ctx: BuildContext, dockerfile: string, dockerfileContent?: string, opts: DockerBuildOptions = {}) {
  const args = ["build", "--progress=plain", "-t", ctx.image, ...(ctx.platform ? ["--platform", ctx.platform] : [])];
  let tempDockerfile: string | null = null;
  const frontend = opts.frontend;
  // The file is rewritten when build variables need declaring (ARG) or cache mounts need the
  // organization's prefix; otherwise the repository's own file is used as it is.
  const buildKeys = Object.keys(ctx.buildEnv);
  const own = dockerfileContent || frontend ? null : await fs.readFile(path.join(ctx.contextDir, dockerfile), "utf8").catch(() => null);
  if (own && (own.includes("type=cache") || buildKeys.length)) {
    const ignore = path.join(ctx.contextDir, `${dockerfile}.dockerignore`);
    if (await exists(ignore)) await fs.copyFile(ignore, path.join(ctx.contextDir, ".serve.Dockerfile.dockerignore"));
    dockerfileContent = own;
  }
  if (dockerfileContent) {
    // Variables marked for the build reach RUN steps without an ARG line in the Dockerfile.
    dockerfileContent = declareBuildArgs(scopeCacheMounts(dockerfileContent, ctx.cacheScope), buildKeys);
    tempDockerfile = path.join(ctx.contextDir, ".serve.Dockerfile");
    await fs.writeFile(tempDockerfile, dockerfileContent);
    if (dockerfileContent.includes(".serve.nginx.conf")) {
      await fs.writeFile(path.join(ctx.contextDir, ".serve.nginx.conf"), STATIC_NGINX_CONF);
    }
    args.push("-f", tempDockerfile);
  } else {
    args.push("-f", path.join(ctx.contextDir, dockerfile));
  }
  if (frontend) {
    args.push("--build-arg", `BUILDKIT_SYNTAX=${frontend.syntax}`);
    for (const k of Object.keys(frontend.secrets)) args.push("--secret", `id=${k},env=${k}`);
  } else for (const [k, v] of Object.entries(ctx.buildEnv)) args.push("--build-arg", `${k}=${v}`);
  // Only a Dockerfile that declares ARG SOURCE_COMMIT reads it, so other builds keep their cache.
  if (!frontend && ctx.commit && !("SOURCE_COMMIT" in ctx.buildEnv)) args.push("--build-arg", `SOURCE_COMMIT=${ctx.commit}`);
  const extra = frontend ? [] : buildArgFlags(ctx.build.buildArgs);
  if (extra.length)
    ctx.log(
      `Build arguments: ${extra
        .filter((_, i) => i % 2)
        .map((a) => a.split("=")[0])
        .join(", ")}`,
    );
  args.push(...extra);
  for (const [k, v] of Object.entries(ctx.labels)) args.push("--label", `${k}=${v}`);
  if (ctx.build.target && !frontend) args.push("--target", ctx.build.target);
  if (ctx.build.noCache) args.push("--no-cache", "--pull");
  const build = async (flags: string[]) => {
    const all = [...args, ...flags, ctx.contextDir];
    const secrets = frontend?.secrets ?? {};
    if (ctx.remote) await buildOnServer(ctx, ctx.remote, all, secrets);
    else
      await run("docker", all, {
        onLine: ctx.log,
        signal: ctx.signal,
        redact: ctx.redact,
        env: { DOCKER_BUILDKIT: "1", ...ctx.dockerEnv, ...secrets },
      });
  };
  try {
    if (ctx.network && usesServices(ctx.buildEnv, ctx.network.hosts)) {
      const network = ctx.network;
      const name = builderName(network.name);
      const cli = ctx.remote ? serverCli(ctx.remote.server) : (a: string[]) => run("docker", a, { env: { ...ctx.dockerEnv } });
      // Counted from before it starts, so another build ending meanwhile does not stop it.
      await withBuilder(name, cli, async () => {
        if (!(await ensureBuilder(name, network.name, cli, ctx.log))) return build([]);
        const count = Object.keys(network.hosts).length;
        ctx.log(count ? `Build steps can reach this environment's services (${count} names)` : "Build steps can reach this environment's network");
        return build(builderFlags(name, network.hosts));
      });
    } else await build([]);
  } finally {
    if (tempDockerfile) await fs.rm(tempDockerfile, { force: true });
  }
}

/**
 * Whether a build variable names one of the environment's services (DATABASE_URL pointing at the
 * database). Only then does the build run in the environment's builder: other builds keep Docker's
 * own builder and its warm cache.
 */
export function usesServices(buildEnv: Record<string, string>, hosts: Record<string, string>) {
  const names = Object.keys(hosts);
  if (!names.length) return false;
  const edge = "[^A-Za-z0-9_.-]";
  return Object.values(buildEnv).some((value) => names.some((host) => new RegExp(`(^|${edge})${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(${edge}|$)`).test(value)));
}

/**
 * Copies the build context to the server as one archive, then runs `docker` there with these
 * arguments (`build`, or `run` for a builder that runs in a container), and the environment given.
 */
async function buildOnServer(ctx: BuildContext, remote: NonNullable<BuildContext["remote"]>, args: string[], env: Record<string, string> = {}) {
  const dir = path.posix.join(remote.buildsDir, `context-${crypto.randomBytes(6).toString("hex")}`);
  const local = ctx.contextDir;
  // Paths in the arguments (context, Dockerfile) point into the copy on the server.
  // A bind mount names it before a colon (`<context>:/workspace`).
  const mapped = args.map((a) =>
    a === local
      ? dir
      : a.startsWith(`${local}/`)
        ? path.posix.join(dir, path.relative(local, a).split(path.sep).join("/"))
        : a.startsWith(`${local}:`)
          ? `${dir}${a.slice(local.length)}`
          : a,
  );
  const redact = redactor(ctx.redact);
  const started = Date.now();
  // Copies left by builds whose connection dropped are removed after an hour.
  await remote.server.exec(`find ${sh(remote.buildsDir)} -maxdepth 1 -name 'context-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true`).catch(() => {});
  let upload = { code: 1, stdout: "", stderr: "" };
  // A connection that drops (a server behind a tunnel whose link resets) ends without an exit
  // status or a message: the upload is tried once more before the build fails.
  for (let attempt = 1; attempt <= 2; attempt++) {
    upload = await remote.server
      .exec(`rm -rf ${sh(dir)} && mkdir -p ${sh(dir)} && tar -xzf - -C ${sh(dir)}`, {
        stdin: () => spawn("tar", ["-czf", "-", "-C", local, "."], { stdio: ["ignore", "pipe", "ignore"] }).stdout,
        signal: ctx.signal,
      })
      .catch((error: Error) => ({ code: 255, stdout: "", stderr: error.message }));
    if (upload.code === 0 || ctx.signal?.aborted) break;
    await remote.server.exec(`rm -rf ${sh(dir)}`).catch(() => {});
    if (attempt === 1 && !upload.stderr.trim()) ctx.log("The connection to the server dropped while sending the build files; trying again");
    else break;
  }
  if (upload.code !== 0) {
    const detail = (upload.stderr || upload.stdout).trim();
    throw new Error(`Could not copy the build files to the server: ${detail || "the connection dropped. Check that the server is online and try again."}`);
  }
  ctx.log(`Sent the build files to the server in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  try {
    const vars = Object.entries(env)
      .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map(([k, v]) => `${k}=${sh(v)} `)
      .join("");
    const res = await remote.server.exec(`cd ${sh(dir)} && ${vars}DOCKER_BUILDKIT=1 docker ${mapped.map(sh).join(" ")}`, {
      onLine: (line) => ctx.log(redact(line)),
      signal: ctx.signal,
    });
    if (ctx.signal?.aborted) throw new Error("Build cancelled");
    if (res.code !== 0) throw new Error(`docker ${mapped[0]} exited with code ${res.code}`);
  } finally {
    // A cancelled build keeps running on the server after its SSH channel closes: stop it by its directory.
    if (ctx.signal?.aborted) await remote.server.exec(`pkill -f ${sh(`docker build.*${dir}`)} || true`).catch(() => {});
    await remote.server.exec(`rm -rf ${sh(dir)}`).catch(() => {});
  }
}

const RAILPACK_VERSION = "0.40.1";
/** Checksums of the release archives, so a changed download is never run. */
const RAILPACK_SHA256: Record<string, { file: string; sha256: string }> = {
  x64: { file: "x86_64-unknown-linux-musl", sha256: "2842de93e68713af9037e0bc0a398d7da78f3b96aa4804303a638db2bc69bd30" },
  arm64: { file: "arm64-unknown-linux-musl", sha256: "c24a064b586b8f4f8c2fab44dd5ef19253e4c6cc4e1df793b3ae19cd87f7a5d4" },
};
const RAILPACK_FRONTEND = `ghcr.io/railwayapp/railpack-frontend:v${RAILPACK_VERSION}`;
export const DEFAULT_BUILDPACKS_BUILDER = "heroku/builder:24";

/** The Railpack binary, downloaded once into the data directory on first use. */
async function railpackBin(log: (line: string) => void) {
  const bin = path.join(paths.tools, `railpack-${RAILPACK_VERSION}`);
  if (await exists(bin)) return bin;
  const asset = RAILPACK_SHA256[process.arch];
  if (process.platform !== "linux" || !asset) throw new Error(`Railpack does not run on ${process.platform}/${process.arch}.`);
  log(`Downloading Railpack ${RAILPACK_VERSION}`);
  const url = `https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-${asset.file}.tar.gz`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Could not download Railpack: HTTP ${res.status}`);
  const archive = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash("sha256").update(archive).digest("hex") !== asset.sha256) throw new Error("The Railpack download did not match its checksum.");
  await fs.mkdir(paths.tools, { recursive: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "serve-railpack-"));
  try {
    await fs.writeFile(path.join(tmp, "railpack.tar.gz"), archive);
    await run("tar", ["-xzf", path.join(tmp, "railpack.tar.gz"), "-C", tmp, "railpack"]);
    await fs.chmod(path.join(tmp, "railpack"), 0o755);
    // Moved in whole, so a build running at the same time never runs a half written file; each
    // download has its own temporary name, so two at once do not write into one.
    const part = `${bin}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    await fs.copyFile(path.join(tmp, "railpack"), part);
    await fs.chmod(part, 0o755);
    await fs.rename(part, bin);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return bin;
}

/** Build variables and build arguments: both reach Railpack and Buildpacks as plain variables. */
function buildVariables(ctx: BuildContext) {
  const vars: Record<string, string> = { ...ctx.buildEnv };
  for (const a of ctx.build.buildArgs ?? []) if (a.key.trim()) vars[a.key.trim()] = a.value;
  return vars;
}

/** Railpack: it writes a build plan, which BuildKit builds with Railpack's frontend. */
async function railpackBuild(ctx: BuildContext) {
  const bin = await railpackBin(ctx.log);
  const vars = buildVariables(ctx);
  const planName = ".serve-railpack-plan.json";
  const plan = path.join(ctx.contextDir, planName);
  const args = ["prepare", ctx.contextDir, "--plan-out", plan, "--hide-pretty-plan"];
  for (const [k, v] of Object.entries(vars)) args.push("--env", `${k}=${v}`);
  if (ctx.build.installCommand) args.push("--env", `RAILPACK_INSTALL_CMD=${ctx.build.installCommand}`);
  if (ctx.build.buildCommand) args.push("--build-cmd", ctx.build.buildCommand);
  if (ctx.build.startCommand) args.push("--start-cmd", ctx.build.startCommand);
  ctx.log(`Building with Railpack ${RAILPACK_VERSION}`);
  await run(bin, args, { onLine: ctx.log, signal: ctx.signal, redact: ctx.redact, cwd: ctx.contextDir });
  try {
    // The plan names the variables it reads as secrets; each one is passed by name.
    const planned = (JSON.parse(await fs.readFile(plan, "utf8")) as { secrets?: string[] }).secrets ?? [];
    const secrets = Object.fromEntries(planned.filter((k) => k in vars).map((k) => [k, vars[k]]));
    await dockerBuild(ctx, planName, undefined, { frontend: { syntax: RAILPACK_FRONTEND, secrets } });
  } finally {
    await fs.rm(plan, { force: true });
  }
  // BuildKit frontends leave out image labels: they are added on top.
  await relabel(ctx);
}

/** Builder images whose publishers are known: others need the rights to run things on the host. */
export function knownBuildpacksBuilder(image: string) {
  return /^(docker\.io\/)?(heroku\/builder:|paketobuildpacks\/(builder-|ubuntu-noble-builder))/.test(image);
}

/**
 * Cloud Native Buildpacks: the builder image's lifecycle (creator) runs next to Docker on the server
 * that builds, and saves the image there. The pack CLI is not used: with build variables it rewrites
 * the builder image, which fails on Docker's containerd image store.
 */
async function buildpacksBuild(ctx: BuildContext) {
  const builder = ctx.build.buildpacksBuilder?.trim() || DEFAULT_BUILDPACKS_BUILDER;
  const name = `serve-cnb-${crypto.randomBytes(6).toString("hex")}`;
  const vars = Object.fromEntries(Object.entries(buildVariables(ctx)).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)));
  // Build variables are files in /platform/env, written inside the container from its environment:
  // nothing is left in the source the image is made from, and values stay off the command line.
  const passed = Object.fromEntries(Object.entries(vars).map(([k, v]) => [`SERVE_ENV_${k}`, v]));
  ctx.log(`Building with Cloud Native Buildpacks (${builder})`);
  const runImage = await pullRunImage(ctx, builder);
  const script = [
    "set -e",
    "mkdir -p /platform/env",
    'for n in $SERVE_ENV_NAMES; do printf %s "$(printenv "SERVE_ENV_$n")" > "/platform/env/$n"; done',
    `exec /cnb/lifecycle/creator -app=/workspace -cache-dir=/cache -daemon -run-image=${runImage} ${ctx.build.noCache ? "-skip-restore " : ""}"$0"`,
  ].join("\n");
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    // The lifecycle starts as root to reach Docker and runs the buildpacks as the builder's own user.
    "--user",
    "root",
    "-e",
    "CNB_PLATFORM_API=0.13",
    "-e",
    `SERVE_ENV_NAMES=${Object.keys(vars).join(" ")}`,
    ...Object.keys(passed).flatMap((k) => ["-e", k]),
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-v",
    `${ctx.contextDir}:/workspace`,
    // Layers cached per organization, across builds.
    "-v",
    `serve-cnb-cache-${ctx.cacheScope.replace(/[^a-zA-Z0-9_.-]/g, "-")}:/cache`,
    "--entrypoint",
    "sh",
    builder,
    "-c",
    script,
    ctx.image,
  ];
  // An image already under this name (a build of the same deployment run again) makes the lifecycle
  // fail to save over it on Docker's containerd image store.
  await dockerOn(ctx, ["image", "rm", "-f", ctx.image]).catch(() => {});
  try {
    if (ctx.remote) await buildOnServer(ctx, ctx.remote, args, passed);
    else await run("docker", args, { onLine: ctx.log, signal: ctx.signal, redact: ctx.redact, env: { ...ctx.dockerEnv, ...passed } });
  } finally {
    // A cancelled build: its container keeps going after the CLI stops.
    if (ctx.signal?.aborted)
      await (ctx.remote ? ctx.remote.server.exec(`docker rm -f ${sh(name)}`) : run("docker", ["rm", "-f", name], { env: { ...ctx.dockerEnv } })).catch(() => {});
  }
  // The start command, when set, replaces the buildpacks' own web process.
  await relabel(ctx, ctx.build.startCommand ? `ENTRYPOINT ["/cnb/lifecycle/launcher"]\nCMD ${JSON.stringify([ctx.build.startCommand])}\n` : "");
}

/** `docker` on the server that builds, returning its output. */
async function dockerOn(ctx: BuildContext, args: string[]) {
  if (!ctx.remote) return run("docker", args, { signal: ctx.signal, env: { ...ctx.dockerEnv } });
  const res = await ctx.remote.server.exec(`docker ${args.map(sh).join(" ")}`, { signal: ctx.signal });
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || `docker ${args[0]} exited with code ${res.code}`);
  return res.stdout;
}

/**
 * The builder's run image (the base of the app image) must be in Docker before the lifecycle saves
 * the image there: the lifecycle reads it from Docker and does not pull it.
 */
async function pullRunImage(ctx: BuildContext, builder: string): Promise<string> {
  const has = (image: string) =>
    dockerOn(ctx, ["image", "inspect", "--format", "{{.Id}}", image]).then(
      () => true,
      () => false,
    );
  if (ctx.build.noCache || !(await has(builder))) {
    ctx.log(`Pulling ${builder}`);
    await dockerOn(ctx, ["pull", "-q", builder]);
  }
  const label = await dockerOn(ctx, ["image", "inspect", "--format", '{{index .Config.Labels "io.buildpacks.builder.metadata"}}', builder]);
  let meta: { images?: { image?: string }[]; stack?: { runImage?: { image?: string } } } = {};
  try {
    meta = JSON.parse(label.trim());
  } catch {
    throw new Error(`${builder} is not a Cloud Native Buildpacks builder image.`);
  }
  const runImage = meta.images?.[0]?.image ?? meta.stack?.runImage?.image;
  if (!runImage) throw new Error(`${builder} names no run image.`);
  if (ctx.build.noCache || !(await has(runImage))) {
    ctx.log(`Pulling ${runImage}`);
    await dockerOn(ctx, ["pull", "-q", runImage]);
  }
  // Docker's containerd image store cannot export one platform of a multi-platform image (Docker
  // 29.8 on arm64 refuses it), which the lifecycle does to read the run image. A copy holding only
  // this server's platform exports fine: the app image is built on that copy.
  const local = `serve-cnb-run:${crypto.createHash("sha256").update(runImage).digest("hex").slice(0, 12)}`;
  if (ctx.build.noCache || !(await has(local))) {
    const cmd = `printf 'FROM %s\\n' ${sh(runImage)} | docker build -q -t ${sh(local)} -`;
    if (ctx.remote) {
      const res = await ctx.remote.server.exec(cmd, { signal: ctx.signal });
      if (res.code !== 0) throw new Error(`Could not prepare the run image: ${(res.stderr || res.stdout).trim()}`);
    } else await run("sh", ["-c", cmd], { signal: ctx.signal, env: { ...ctx.dockerEnv } });
  }
  return local;
}

/** Adds the image labels Serve finds its images by (and any extra lines) on top of a built image. */
async function relabel(ctx: BuildContext, extra = "") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "serve-relabel-"));
  try {
    const plain: BuildContext = {
      ...ctx,
      contextDir: dir,
      buildEnv: {},
      network: null,
      build: { ...ctx.build, buildArgs: [], target: null, noCache: false },
      log: () => {},
    };
    await dockerBuild(plain, "", `FROM ${ctx.image}\n${extra}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The Node major Nixpacks falls back to without a version (18) is gone from its packages. */
const NIXPACKS_NODE_DEFAULT = 22;

/**
 * The Node version to hand Nixpacks for a Node project that names none: its own fallback (Node 18)
 * reached end of life and no longer installs. Null when the project or its variables choose one.
 */
export async function nixpacksNodeDefault(ctx: Pick<BuildContext, "contextDir" | "buildEnv" | "build">): Promise<number | null> {
  if ("NIXPACKS_NODE_VERSION" in ctx.buildEnv || (ctx.build.buildArgs ?? []).some((a) => a.key.trim() === "NIXPACKS_NODE_VERSION")) return null;
  const pkg = await readJson<PackageJson>(path.join(ctx.contextDir, "package.json"));
  if (!pkg || pkg.engines?.node) return null;
  for (const file of [".nvmrc", ".node-version"]) if (await exists(path.join(ctx.contextDir, file))) return null;
  const tools = await fs.readFile(path.join(ctx.contextDir, ".tool-versions"), "utf8").catch(() => "");
  if (/^\s*nodejs\s/m.test(tools)) return null;
  return NIXPACKS_NODE_DEFAULT;
}

export async function buildImage(ctx: BuildContext): Promise<BuildResult> {
  const { build } = ctx;
  const dockerfilePath = path.join(ctx.contextDir, build.dockerfile || "Dockerfile");
  const hasDockerfile = await exists(dockerfilePath);

  let builder = build.builder;
  if (builder === "auto") {
    if (hasDockerfile) builder = "dockerfile";
    else if (await commandExists("nixpacks")) builder = "nixpacks";
  }

  if (builder === "dockerfile") {
    if (!hasDockerfile) throw new Error(`No Dockerfile found at ${build.dockerfile}.`);
    ctx.log(`Building with Dockerfile (${build.dockerfile})`);
    await dockerBuild(ctx, build.dockerfile);
    return { builder: "dockerfile" };
  }

  if (builder === "railpack") {
    await railpackBuild(ctx);
    return { builder: "railpack" };
  }

  if (builder === "buildpacks") {
    await buildpacksBuild(ctx);
    return { builder: "buildpacks" };
  }

  if (builder === "nixpacks") {
    if (!(await commandExists("nixpacks"))) throw new Error("Nixpacks is not installed on this server.");
    ctx.log("Building with Nixpacks");
    const args = ["build", ctx.contextDir, "--name", ctx.image, "--cache-key", ctx.cacheScope, ...(ctx.platform ? ["--platform", ctx.platform] : [])];
    if (build.installCommand) args.push("--install-cmd", build.installCommand);
    if (build.buildCommand) args.push("--build-cmd", build.buildCommand);
    if (build.startCommand) args.push("--start-cmd", build.startCommand);
    for (const [k, v] of Object.entries(ctx.buildEnv)) args.push("--env", `${k}=${v}`);
    for (const a of ctx.build.buildArgs ?? []) if (a.key.trim()) args.push("--env", `${a.key.trim()}=${a.value}`);
    for (const [k, v] of Object.entries(ctx.labels)) args.push("--label", `${k}=${v}`);
    if (ctx.build.noCache) args.push("--no-cache");
    const node = await nixpacksNodeDefault(ctx);
    if (node) {
      args.push("--env", `NIXPACKS_NODE_VERSION=${node}`);
      ctx.log(`The project names no Node version: using Node ${node}. Set engines.node in package.json, a .nvmrc file or NIXPACKS_NODE_VERSION to choose one.`);
    }
    await run("nixpacks", args, { onLine: ctx.log, signal: ctx.signal, redact: ctx.redact, env: ctx.dockerEnv });
    return { builder: "nixpacks" };
  }

  const detected = await detect(ctx.contextDir, build, ctx.buildEnv);
  ctx.log(`Detected ${detected.kind} project, generating a Dockerfile`);
  await dockerBuild(ctx, "", detected.dockerfile);
  return { builder: detected.kind, detectedPort: detected.port };
}
