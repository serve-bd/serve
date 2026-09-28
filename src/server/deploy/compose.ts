import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { env } from "@/server/env";
import { LABEL } from "@/server/docker/client";
import { run } from "@/server/process";
import { composeAlias } from "@/server/proxy/nginx";

type ComposeFile = {
  services?: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  [key: string]: unknown;
};

type ComposeService = {
  networks?: string[] | Record<string, { aliases?: string[] } | null>;
  labels?: string[] | Record<string, string>;
  network_mode?: string;
  [key: string]: unknown;
};

export function parseCompose(content: string): ComposeFile {
  const doc = YAML.parse(content) as ComposeFile | null;
  if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object") {
    throw new Error("The compose file has no services.");
  }
  return doc;
}

export function composeServiceNames(content: string): string[] {
  try {
    return Object.keys(parseCompose(content).services ?? {});
  } catch {
    return [];
  }
}

/** Ports each compose service exposes (best effort, used for domain suggestions). */
export function composeServicePorts(content: string): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  try {
    const doc = parseCompose(content);
    for (const [name, svc] of Object.entries(doc.services ?? {})) {
      const ports = new Set<number>();
      for (const p of [...((svc.expose as unknown[]) ?? []), ...((svc.ports as unknown[]) ?? [])]) {
        const str = typeof p === "object" && p ? String((p as { target?: number }).target ?? "") : String(p);
        const container = str.split(":").pop()?.split("/")[0];
        if (container && /^\d+$/.test(container)) ports.add(Number(container));
      }
      out[name] = [...ports];
    }
  } catch {
    // ignore
  }
  return out;
}

/**
 * Attach every service to the shared Serve network with a predictable alias,
 * so the proxy can route to `<slug>-<service>`.
 */
export function transformCompose(content: string, slug: string, serviceId: string): string {
  const doc = parseCompose(content);
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    if (svc.network_mode) continue;
    const alias = composeAlias(slug, name);
    if (Array.isArray(svc.networks)) {
      const nets: Record<string, { aliases?: string[] } | null> = {};
      for (const n of svc.networks) nets[n] = null;
      svc.networks = nets;
    }
    const nets = (svc.networks as Record<string, { aliases?: string[] } | null>) ?? { default: null };
    if (!Object.keys(nets).length) nets.default = null;
    nets[env.network] = { aliases: [alias] };
    svc.networks = nets;

    const labels = { [LABEL.managed]: "true", [LABEL.service]: serviceId, [LABEL.slug]: slug, [LABEL.kind]: "compose" };
    if (Array.isArray(svc.labels)) {
      svc.labels = [...svc.labels, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)];
    } else {
      svc.labels = { ...(svc.labels ?? {}), ...labels };
    }
  }
  doc.networks = { ...(doc.networks ?? {}), [env.network]: { external: true, name: env.network } };
  return YAML.stringify(doc);
}

function envFile(vars: Record<string, string>) {
  return (
    Object.entries(vars)
      // Single quotes keep values literal (no interpolation) in compose env files.
      .map(([k, v]) => `${k}=${v.includes("'") ? JSON.stringify(v) : `'${v}'`}`)
      .join("\n") + "\n"
  );
}

export type ComposeRun = {
  projectName: string;
  /** Directory the compose file lives in (relative paths resolve from here). */
  dir: string;
  file: string;
  vars: Record<string, string>;
  log: (line: string) => void;
  signal?: AbortSignal;
  redact?: string[];
};

export async function writeComposeFiles(opts: ComposeRun & { content: string }) {
  await fs.mkdir(opts.dir, { recursive: true });
  await fs.writeFile(path.join(opts.dir, opts.file), opts.content);
  await fs.writeFile(path.join(opts.dir, ".env"), envFile(opts.vars), { mode: 0o600 });
}

function composeArgs(opts: Pick<ComposeRun, "projectName" | "dir" | "file">) {
  return ["compose", "-p", opts.projectName, "--project-directory", opts.dir, "-f", path.join(opts.dir, opts.file)];
}

export async function composeUp(opts: ComposeRun) {
  await run("docker", [...composeArgs(opts), "up", "-d", "--build", "--remove-orphans", "--wait", "--wait-timeout", "300"], {
    cwd: opts.dir,
    onLine: opts.log,
    signal: opts.signal,
    redact: opts.redact,
  });
}

export async function composeCommand(
  opts: Pick<ComposeRun, "projectName" | "dir" | "file">,
  args: string[],
  log?: (line: string) => void,
) {
  return run("docker", [...composeArgs(opts), ...args], { cwd: opts.dir, onLine: log });
}

/** `docker compose down` using only the project name (works without files). */
export async function composeDownByProject(projectName: string, removeVolumes: boolean) {
  const args = ["compose", "-p", projectName, "down", "--remove-orphans"];
  if (removeVolumes) args.push("-v");
  await run("docker", args).catch(() => {});
}
