import type { RegistryKind } from "@/server/db/schema";

/** Presets for the registry dialog. The host of "generic" (and self-hosted GitLab) is typed by the user. */
export const registryPresets: Record<RegistryKind, { label: string; host: string; hint: string }> = {
  dockerhub: { label: "Docker Hub", host: "docker.io", hint: "Account settings → Personal access tokens, with Read & Write access." },
  ghcr: { label: "GitHub Container Registry", host: "ghcr.io", hint: "A personal access token (classic) with write:packages and read:packages." },
  gitlab: { label: "GitLab Container Registry", host: "registry.gitlab.com", hint: "A deploy token or access token with read_registry and write_registry." },
  generic: { label: "Other registry", host: "", hint: "Any registry that speaks the Docker Registry HTTP API v2." },
};

/** Registry hosts are "name[:port]", without scheme or path. */
export function normalizeHost(input: string) {
  const host = input
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host)) throw new Error("Enter a registry host like registry.example.com or registry.example.com:5000.");
  return host;
}

/** Address Docker Engine uses to look up credentials for a host. Docker Hub has a historic one. */
export function authServer(host: string) {
  return host === "docker.io" || host === "index.docker.io" || host === "registry-1.docker.io" ? "https://index.docker.io/v1/" : host;
}

/** Repository path rules from the distribution spec, lower case only. */
export function normalizeRepository(input: string) {
  const repo = input
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  if (!repo || !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/.test(repo)) {
    throw new Error("Use a repository like team/app: lower-case letters, digits, dots, dashes and slashes.");
  }
  return repo;
}

/** Repository suggested for a service when none is set yet. */
export function defaultRepository(registry: { namespace: string | null; username: string }, slug: string) {
  const ns = (registry.namespace || registry.username).toLowerCase().replace(/[^a-z0-9._/-]/g, "-");
  return `${ns}/${slug}`.replace(/\/+/g, "/");
}

export const DEFAULT_TAG = "{short}-{deployment}";

/** Fill a tag pattern and make it a valid Docker tag (max 128 chars, [A-Za-z0-9_.-]). */
export function renderTag(pattern: string | null | undefined, vars: { commit?: string | null; deployment: string; branch?: string | null; service: string; now?: Date }) {
  const now = vars.now ?? new Date();
  const commit = vars.commit ?? "";
  const values: Record<string, string> = {
    commit,
    short: commit.slice(0, 7),
    deployment: vars.deployment.slice(0, 8),
    branch: vars.branch ?? "",
    service: vars.service,
    date: now.toISOString().slice(0, 10).replace(/-/g, ""),
  };
  let tag = (pattern?.trim() || DEFAULT_TAG).replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
  tag = tag
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[-.]+$/g, "");
  // A commitless image (no git metadata) still needs a unique, valid tag.
  if (!tag) tag = values.deployment;
  return tag.slice(0, 128);
}

/** Manifest digest from a push status line ("tag: digest: sha256:… size: N"), or null. */
export function parsePushDigest(status: string) {
  return /digest: (sha256:[a-f0-9]{64})/.exec(status)?.[1] ?? null;
}

/** Full reference for a repository in a registry. */
export function imageRef(host: string, repository: string, tagOrDigest: string) {
  const sep = tagOrDigest.startsWith("sha256:") ? "@" : ":";
  return `${host}/${repository}${sep}${tagOrDigest}`;
}
