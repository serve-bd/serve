/** The file manager's requests (see src/server/files/http.ts) and path helpers. */

export type Entry = {
  name: string;
  type: "dir" | "file" | "link" | "other";
  size: number;
  mtime: number;
  mode: string;
  owner: string;
  group: string;
  link?: { target: string; kind: "dir" | "file" | "missing" };
};

export type Listing = { path: string; entries: Entry[]; mounts?: { path: string; kind: "volume" | "bind" | "other"; name: string }[] };

/** GET with a query, or POST a body. Errors carry the server's message and the HTTP status. */
export async function request<T = unknown>(endpoint: string, query: Record<string, string>, body?: unknown): Promise<T> {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(
    qs ? `${endpoint}?${qs}` : endpoint,
    body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

export const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

export const parentOf = (path: string) => path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";

/** "/etc/nginx" → [{name: "etc", path: "/etc"}, {name: "nginx", path: "/etc/nginx"}]. */
export function segmentsOf(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` }));
}
