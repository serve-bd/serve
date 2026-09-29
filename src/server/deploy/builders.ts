import fs from "node:fs/promises";
import path from "node:path";
import { commandExists, run } from "@/server/process";
import type { BuildConfig } from "@/server/services/types";
import { buildArgFlags } from "./options";

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

async function dockerBuild(ctx: BuildContext, dockerfile: string, dockerfileContent?: string) {
  const args = ["build", "--progress=plain", "-t", ctx.image];
  let tempDockerfile: string | null = null;
  if (dockerfileContent) {
    tempDockerfile = path.join(ctx.contextDir, ".serve.Dockerfile");
    await fs.writeFile(tempDockerfile, dockerfileContent);
    if (dockerfileContent.includes(".serve.nginx.conf")) {
      await fs.writeFile(path.join(ctx.contextDir, ".serve.nginx.conf"), STATIC_NGINX_CONF);
    }
    args.push("-f", tempDockerfile);
  } else {
    args.push("-f", path.join(ctx.contextDir, dockerfile));
  }
  for (const [k, v] of Object.entries(ctx.buildEnv)) args.push("--build-arg", `${k}=${v}`);
  const extra = buildArgFlags(ctx.build.buildArgs);
  if (extra.length)
    ctx.log(
      `Build arguments: ${extra
        .filter((_, i) => i % 2)
        .map((a) => a.split("=")[0])
        .join(", ")}`,
    );
  args.push(...extra);
  for (const [k, v] of Object.entries(ctx.labels)) args.push("--label", `${k}=${v}`);
  if (ctx.build.target) args.push("--target", ctx.build.target);
  if (ctx.build.noCache) args.push("--no-cache", "--pull");
  args.push(ctx.contextDir);
  try {
    await run("docker", args, {
      onLine: ctx.log,
      signal: ctx.signal,
      redact: ctx.redact,
      env: { DOCKER_BUILDKIT: "1", ...ctx.dockerEnv },
    });
  } finally {
    if (tempDockerfile) await fs.rm(tempDockerfile, { force: true });
  }
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

  if (builder === "nixpacks") {
    if (!(await commandExists("nixpacks"))) throw new Error("Nixpacks is not installed on this server.");
    ctx.log("Building with Nixpacks");
    const args = ["build", ctx.contextDir, "--name", ctx.image];
    if (build.installCommand) args.push("--install-cmd", build.installCommand);
    if (build.buildCommand) args.push("--build-cmd", build.buildCommand);
    if (build.startCommand) args.push("--start-cmd", build.startCommand);
    for (const [k, v] of Object.entries(ctx.buildEnv)) args.push("--env", `${k}=${v}`);
    for (const a of ctx.build.buildArgs ?? []) if (a.key.trim()) args.push("--env", `${a.key.trim()}=${a.value}`);
    for (const [k, v] of Object.entries(ctx.labels)) args.push("--label", `${k}=${v}`);
    if (ctx.build.noCache) args.push("--no-cache");
    await run("nixpacks", args, { onLine: ctx.log, signal: ctx.signal, redact: ctx.redact, env: ctx.dockerEnv });
    return { builder: "nixpacks" };
  }

  const detected = await detect(ctx.contextDir, build, ctx.buildEnv);
  ctx.log(`Detected ${detected.kind} project, generating a Dockerfile`);
  await dockerBuild(ctx, "", detected.dockerfile);
  return { builder: detected.kind, detectedPort: detected.port };
}
