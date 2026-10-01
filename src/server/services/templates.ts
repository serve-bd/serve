import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bundledFile from "../../../templates/index.json";
import { env } from "@/server/env";
import { currentVersion, updateRepository } from "@/server/instance/version";
import { composeSecurityIssues } from "@/server/security";
import { type CatalogTemplate, parseCatalog } from "@/lib/template-catalog";

/**
 * One-click service templates. The catalog lives in the repository's templates/ folder and is read
 * from GitHub, so a new template reaches every instance without a release. Pages never wait for
 * GitHub: they get the last copy (memory, then the data directory, then the one in the image) and a
 * stale copy is refreshed in the background.
 */

export type { TemplateVar } from "@/lib/template-catalog";
export { composeVariables } from "@/lib/compose-vars";

export type Template = Omit<CatalogTemplate, "logo"> & {
  /** Hash of the logo for its URL, or null for a lettered tile. */
  logo: string | null;
};

/** Categories offered for organization templates; the catalog may use others. */
export const templateCategories = [
  "Automation",
  "Analytics",
  "CMS",
  "Productivity",
  "Developer tools",
  "Monitoring",
  "Storage",
  "AI",
  "Communication",
  "Security",
  "Media",
  "Databases",
] as const;

export type TemplateCategory = (typeof templateCategories)[number];

/** A copy younger than this is used as is. */
const FRESH_MS = 5 * 60_000;
/** After a failed refresh, the next try waits this long. */
const RETRY_MS = 60_000;

type State = {
  templates: Template[];
  logos: Map<string, string>;
  /** When the copy was last confirmed against the source (0: never, e.g. the bundled one). */
  checkedAt: number;
  etag: string | null;
  source: "remote" | "cache" | "bundled";
};

let state: State | null = null;
let loading: Promise<State> | null = null;
let refreshing: Promise<void> | null = null;
let lastTry = 0;

/** Where the catalog comes from; "off" keeps the copy in the image. */
function sourceUrl() {
  const custom = process.env.SERVE_TEMPLATES_URL;
  if (custom === "off" || custom === "") return null;
  return custom || `https://raw.githubusercontent.com/${updateRepository()}/main/templates/index.json`;
}

const cacheFile = () => path.join(env.dataDir, "cache", "templates.json");

function build(list: CatalogTemplate[], meta: Omit<State, "templates" | "logos">): State {
  const logos = new Map<string, string>();
  const templates = list.map(({ logo, ...t }) => {
    const hash = logo ? crypto.createHash("sha256").update(logo).digest("hex").slice(0, 12) : null;
    if (logo) logos.set(t.id, logo);
    // The file says what it needs, but what it mounts decides: only Root admins create host access.
    return { ...t, hostAccess: !!t.hostAccess || composeSecurityIssues(t.compose).length > 0, logo: hash };
  });
  return { templates, logos, ...meta };
}

let bundledState: State | null = null;

/** The copy in the image. */
function bundled(): State {
  if (!bundledState) {
    const parsed = parseCatalog(JSON.stringify(bundledFile), currentVersion());
    bundledState = build(parsed?.templates ?? [], { checkedAt: 0, etag: null, source: "bundled" });
  }
  return bundledState;
}

async function load(): Promise<State> {
  const text = await fs.readFile(cacheFile(), "utf8").catch(() => null);
  if (text) {
    try {
      const saved = JSON.parse(text) as { checkedAt: number; etag: string | null; catalog: string };
      const parsed = parseCatalog(saved.catalog, currentVersion());
      if (parsed?.templates.length) return build(parsed.templates, { checkedAt: saved.checkedAt, etag: saved.etag, source: "cache" });
    } catch {
      // A damaged cache file: start from the bundled copy.
    }
  }
  return bundled();
}

async function refresh(url: string) {
  lastTry = Date.now();
  const current = state;
  const res = await fetch(url, {
    headers: { "user-agent": `serve/${currentVersion()}`, ...(current?.etag && current.source !== "bundled" ? { "if-none-match": current.etag } : {}) },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (res.status === 304 && current) {
    state = { ...current, checkedAt: Date.now() };
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const parsed = parseCatalog(text, currentVersion());
  // An empty or unreadable file never replaces a working catalog.
  if (!parsed?.templates.length) throw new Error("the catalog file is empty or unreadable");
  if (parsed.skipped.length) console.warn(`[templates] left out: ${parsed.skipped.join(", ")}`);
  const etag = res.headers.get("etag");
  state = build(parsed.templates, { checkedAt: Date.now(), etag, source: "remote" });
  await fs
    .mkdir(path.dirname(cacheFile()), { recursive: true })
    .then(() => fs.writeFile(cacheFile(), JSON.stringify({ checkedAt: Date.now(), etag, catalog: text })))
    .catch(() => {});
}

/** The catalog now; refreshes a stale copy in the background. */
async function catalog(): Promise<State> {
  if (!state) {
    loading ??= load().finally(() => {
      loading = null;
    });
    state = await loading;
  }
  const url = sourceUrl();
  const now = Date.now();
  if (url && !refreshing && now - state.checkedAt > FRESH_MS && now - lastTry > RETRY_MS) {
    refreshing = refresh(url)
      .catch((err) => console.warn(`[templates] could not refresh from ${url}: ${(err as Error).message}`))
      .finally(() => {
        refreshing = null;
      });
  }
  return state;
}

export async function getTemplates(): Promise<Template[]> {
  return (await catalog()).templates;
}

/** A template by id. One the catalog dropped is still found in the bundled copy, for services made from it. */
export async function getTemplate(id: string): Promise<Template | null> {
  const found = (await catalog()).templates.find((t) => t.id === id);
  if (found) return found;
  return bundled().templates.find((t) => t.id === id) ?? null;
}

export async function templateLogo(id: string): Promise<string | null> {
  return (await catalog()).logos.get(id) ?? bundled().logos.get(id) ?? null;
}

export type TemplateBrands = Record<string, { color: string; logo: string | null }>;

/** Tile colour and logo URL of every template (dropped ones too, for services made from them). */
export async function templateBrands(): Promise<TemplateBrands> {
  const list = [...bundled().templates, ...(await getTemplates())];
  return Object.fromEntries(list.map((t) => [t.id, { color: t.color, logo: t.logo ? `/api/templates/${t.id}/logo?v=${t.logo}` : null }]));
}
