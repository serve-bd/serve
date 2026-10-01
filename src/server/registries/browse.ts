import { decrypt } from "@/server/crypto";
import { hostIsPrivate } from "@/server/net/public-host";
import type { RegistryRow } from "./index";

/**
 * Lists the images of a saved registry and the tags of an image, for the image picker. GitHub and
 * Docker Hub have APIs that list an account's images; other registries are asked through the
 * Registry API (`_catalog`), which many turn off: then the name is typed.
 */

export type ImageEntry = { name: string; ref: string; updatedAt: string | null; private: boolean | null };
export type TagEntry = { name: string; updatedAt: string | null };
export type ImageList = { images: ImageEntry[]; listable: boolean; note: string | null };

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 4_000_000;
const MAX_IMAGES = 500;
const MAX_TAGS = 300;

type Login = { username: string; password: string } | null;

const DOCKER_HUB = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

/** host, repository and tag of an image reference ("nginx" is docker.io/library/nginx). */
export function splitImage(image: string): { host: string; repo: string; tag: string | null } {
  let rest = image.trim().replace(/@sha256:[a-f0-9]+$/i, "");
  let tag: string | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const first = rest.split("/")[0];
  let host = "docker.io";
  if (rest.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) {
    host = first.toLowerCase();
    rest = rest.slice(first.length + 1);
  }
  if (DOCKER_HUB.has(host)) host = "docker.io";
  if (host === "docker.io" && !rest.includes("/")) rest = `library/${rest}`;
  return { host, repo: rest.toLowerCase(), tag };
}

/** The same registry, whatever spelling of Docker Hub is used. */
export function sameRegistryHost(a: string, b: string) {
  const n = (h: string) => (DOCKER_HUB.has(h.toLowerCase()) ? "docker.io" : h.toLowerCase());
  return n(a) === n(b);
}

const loginOf = (row: RegistryRow | null): Login => (row ? { username: row.username, password: decrypt(row.password) } : null);
const basic = (l: NonNullable<Login>) => `Basic ${Buffer.from(`${l.username}:${l.password}`).toString("base64")}`;

async function get(url: string, headers: Record<string, string> = {}, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { accept: "application/json", "user-agent": "serve", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error("The registry answered with too much data.");
  return res;
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("The registry answered with too much data.");
  return JSON.parse(text) as T;
}

function failure(what: string, res: Response) {
  if (res.status === 401 || res.status === 403) return new Error(`${what}: the registry refused the login (HTTP ${res.status}). Check the token's permissions.`);
  return new Error(`${what}: HTTP ${res.status}.`);
}

/* --------------------------------- GitHub --------------------------------- */

type GhPackage = { name: string; visibility?: string; updated_at?: string; owner?: { login?: string } };
type GhVersion = { updated_at?: string; created_at?: string; metadata?: { container?: { tags?: string[] } } };

const github = (path: string, token: string) =>
  get(`https://api.github.com${path}`, { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" });

/** Pages of a GitHub list (100 a page, up to 5 pages). Null when the owner does not exist for this path. */
async function githubList<T>(path: string, token: string): Promise<T[] | null> {
  const all: T[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await github(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token);
    if (res.status === 404) return page === 1 ? null : all;
    if (!res.ok) throw failure("GitHub", res);
    const items = await json<T[]>(res);
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

/** Package paths for an owner: the token's own account, else an organization, else another user. */
function githubOwnerPaths(owner: string, username: string) {
  return owner.toLowerCase() === username.toLowerCase() ? ["/user"] : [`/orgs/${encodeURIComponent(owner)}`, `/users/${encodeURIComponent(owner)}`];
}

async function githubImages(row: RegistryRow): Promise<ImageEntry[]> {
  const token = decrypt(row.password);
  const owners = [...new Set([row.username, row.namespace].filter((o): o is string => !!o).map((o) => o.toLowerCase()))];
  const out = new Map<string, ImageEntry>();
  for (const owner of owners) {
    for (const base of githubOwnerPaths(owner, row.username)) {
      const list = await githubList<GhPackage>(`${base}/packages?package_type=container`, token);
      if (!list) continue;
      for (const p of list) {
        const ownerLogin = (p.owner?.login ?? owner).toLowerCase();
        const name = `${ownerLogin}/${p.name}`;
        out.set(name, { name, ref: `ghcr.io/${name}`, updatedAt: p.updated_at ?? null, private: p.visibility ? p.visibility !== "public" : null });
      }
      break;
    }
  }
  return [...out.values()];
}

async function githubTags(row: RegistryRow, repo: string): Promise<TagEntry[] | null> {
  const [owner, ...rest] = repo.split("/");
  if (!owner || !rest.length) return null;
  const token = decrypt(row.password);
  const name = encodeURIComponent(rest.join("/"));
  for (const base of githubOwnerPaths(owner, row.username)) {
    const versions = await githubList<GhVersion>(`${base}/packages/container/${name}/versions`, token);
    if (!versions) continue;
    const tags: TagEntry[] = [];
    for (const v of versions) for (const t of v.metadata?.container?.tags ?? []) tags.push({ name: t, updatedAt: v.updated_at ?? v.created_at ?? null });
    return tags;
  }
  return null;
}

/* ------------------------------- Docker Hub ------------------------------- */

type HubRepo = { name: string; namespace?: string; last_updated?: string | null; is_private?: boolean };
type HubTag = { name: string; last_updated?: string | null; tag_last_pushed?: string | null };

async function hubToken(login: Login) {
  if (!login) return null;
  const res = await get("https://hub.docker.com/v2/users/login", { "content-type": "application/json" }, { method: "POST", body: JSON.stringify(login) });
  if (!res.ok) throw failure("Docker Hub", res);
  return (await json<{ token?: string }>(res)).token ?? null;
}

async function hubPages<T>(path: string, token: string | null): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = `https://hub.docker.com${path}`;
  for (let page = 0; url && page < 5; page++) {
    const res = await get(url, token ? { authorization: `Bearer ${token}` } : {});
    if (!res.ok) throw failure("Docker Hub", res);
    const body: { results?: T[]; next?: string | null } = await json(res);
    all.push(...(body.results ?? []));
    url = body.next?.startsWith("https://hub.docker.com/") ? body.next : null;
  }
  return all;
}

async function hubImages(row: RegistryRow): Promise<ImageEntry[]> {
  const ns = (row.namespace || row.username).toLowerCase();
  const token = await hubToken(loginOf(row));
  const repos = await hubPages<HubRepo>(`/v2/namespaces/${encodeURIComponent(ns)}/repositories?page_size=100&ordering=last_updated`, token);
  return repos.map((r) => {
    const name = `${r.namespace ?? ns}/${r.name}`;
    return { name, ref: name, updatedAt: r.last_updated ?? null, private: r.is_private ?? null };
  });
}

async function hubTags(row: RegistryRow | null, repo: string): Promise<TagEntry[]> {
  const [ns, ...rest] = repo.split("/");
  const token = row ? await hubToken(loginOf(row)) : null;
  const tags = await hubPages<HubTag>(
    `/v2/namespaces/${encodeURIComponent(ns)}/repositories/${encodeURIComponent(rest.join("/"))}/tags?page_size=100&ordering=last_updated`,
    token,
  );
  return tags.map((t) => ({ name: t.name, updatedAt: t.tag_last_pushed ?? t.last_updated ?? null }));
}

/* ------------------------------ Registry API ------------------------------ */

const apiHost = (host: string) => (host === "docker.io" ? "registry-1.docker.io" : host);

/**
 * GET on the Registry API with its token dance: a 401 names where to get a token (Bearer) or asks
 * for the login itself (Basic).
 */
async function registryGet(host: string, path: string, login: Login, scope: string, allowPrivate: boolean) {
  if (!allowPrivate && (await hostIsPrivate(host))) throw new Error("That registry is on a private network.");
  const url = `https://${apiHost(host)}${path}`;
  const res = await get(url);
  if (res.status !== 401) return res;
  const challenge = res.headers.get("www-authenticate") ?? "";
  if (/^basic/i.test(challenge)) return login ? get(url, { authorization: basic(login) }) : res;
  const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (!params.realm) return res;
  const realm = new URL(params.realm);
  if (realm.protocol !== "https:" || (!allowPrivate && (await hostIsPrivate(realm.hostname)))) throw new Error("The registry sent its login to an address Serve does not use.");
  realm.searchParams.set("service", params.service ?? "");
  realm.searchParams.set("scope", params.scope ?? scope);
  const tokenRes = await get(realm.toString(), login ? { authorization: basic(login) } : {});
  if (!tokenRes.ok) return tokenRes;
  const body = await json<{ token?: string; access_token?: string }>(tokenRes);
  const token = body.token ?? body.access_token;
  return token ? get(url, { authorization: `Bearer ${token}` }) : res;
}

/** The next page of a Registry API list, from its Link header. */
function nextPage(res: Response) {
  const link = res.headers.get("link");
  const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
  return m ? (m[1].startsWith("/") ? m[1] : new URL(m[1]).pathname + new URL(m[1]).search) : null;
}

async function catalogImages(row: RegistryRow, allowPrivate: boolean): Promise<ImageEntry[] | null> {
  const names: string[] = [];
  let path: string | null = "/v2/_catalog?n=500";
  for (let page = 0; path && page < 5 && names.length < MAX_IMAGES; page++) {
    const res = await registryGet(row.host, path, loginOf(row), "registry:catalog:*", allowPrivate);
    if ([401, 403, 404, 405].includes(res.status)) return page === 0 ? null : names.map(toEntry);
    if (!res.ok) throw failure("The registry", res);
    names.push(...((await json<{ repositories?: string[] }>(res)).repositories ?? []));
    path = nextPage(res);
  }
  return names.map(toEntry);
  function toEntry(name: string): ImageEntry {
    return { name, ref: `${row.host}/${name}`, updatedAt: null, private: null };
  }
}

async function registryTags(host: string, repo: string, login: Login, allowPrivate: boolean): Promise<TagEntry[]> {
  const names: string[] = [];
  let path: string | null = `/v2/${repo}/tags/list?n=1000`;
  for (let page = 0; path && page < 5; page++) {
    const res = await registryGet(host, path, login, `repository:${repo}:pull`, allowPrivate);
    if (res.status === 404) throw new Error("The registry does not know this image. Check the name.");
    if (!res.ok) throw failure("The registry", res);
    names.push(...((await json<{ tags?: string[] | null }>(res)).tags ?? []));
    path = nextPage(res);
  }
  return names.map((name) => ({ name, updatedAt: null }));
}

/* --------------------------------- Public --------------------------------- */

/** Newest first when dates are known; else latest, then versions from high to low. */
export function sortTags(tags: TagEntry[]): TagEntry[] {
  const seen = new Map<string, TagEntry>();
  for (const t of tags) {
    const had = seen.get(t.name);
    if (!had || (t.updatedAt && (!had.updatedAt || t.updatedAt > had.updatedAt))) seen.set(t.name, t);
  }
  return [...seen.values()]
    .sort((a, b) => {
      if (a.updatedAt && b.updatedAt && a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      if (a.name === "latest" || b.name === "latest") return a.name === "latest" ? -1 : 1;
      return b.name.localeCompare(a.name, undefined, { numeric: true });
    })
    .slice(0, MAX_TAGS);
}

export async function listImages(row: RegistryRow, allowPrivate = false): Promise<ImageList> {
  if (row.kind === "ghcr" || row.host === "ghcr.io") {
    return { images: sortImages(await githubImages(row)), listable: true, note: null };
  }
  if (row.kind === "dockerhub" || DOCKER_HUB.has(row.host)) {
    return { images: sortImages(await hubImages(row)), listable: true, note: null };
  }
  const images = await catalogImages(row, allowPrivate);
  if (!images) return { images: [], listable: false, note: "This registry does not share its list of images. Type the image name." };
  return { images: sortImages(images), listable: true, note: null };
}

function sortImages(images: ImageEntry[]) {
  return images
    .sort((a, b) => (a.updatedAt && b.updatedAt && a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.name.localeCompare(b.name)))
    .slice(0, MAX_IMAGES);
}

/** Tags of an image, newest first. `row` is the saved registry it lives in (or null for a public image). */
export async function listTags(row: RegistryRow | null, image: string, allowPrivate = false): Promise<TagEntry[]> {
  const { host, repo } = splitImage(image);
  if (host === "docker.io") return sortTags(await hubTags(row, repo));
  if (row && host === "ghcr.io") {
    const tags = await githubTags(row, repo).catch(() => null);
    if (tags?.length) return sortTags(tags);
  }
  return sortTags(await registryTags(host, repo, loginOf(row), allowPrivate));
}
