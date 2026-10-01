import { z } from "zod";

/**
 * The one-click template catalog: templates/<id>/ folders in the repository, bundled into
 * templates/index.json (pnpm templates:build). Serve reads that file from GitHub, so a new
 * template needs no release; the copy in the image is the fallback.
 */

/** Bumped when the file changes in a way older Serve versions cannot read. */
export const CATALOG_SCHEMA = 1;

const varSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    // hex16: Serve 0.1.9+. Older versions do not know it and leave such templates out.
    generate: z.enum(["password", "secret", "hex32", "hex16", "base64key"]).optional(),
    value: z.string().max(2000).optional(),
    /** Filled with the service's public URL (https://domain); follows the primary domain. */
    publicUrl: z.boolean().optional(),
    /** Filled with the service's public hostname (domain only); follows the primary domain. */
    publicHost: z.boolean().optional(),
    /** Filled with the public URL of another compose service's domain (see `domains`). Serve 0.1.9+. */
    serviceUrl: z.string().min(1).optional(),
    /** Filled with the public hostname of another compose service's domain. Serve 0.1.9+. */
    serviceHost: z.string().min(1).optional(),
    /** Shown on the configure step. */
    label: z.string().max(80).optional(),
  })
  // A field this version does not know is a feature it cannot fill: the template is left out.
  .strict();

export type TemplateVar = z.infer<typeof varSchema>;

/** Logos show as images only, but a remote file is still kept free of scripts and links. */
function safeSvg(svg: string) {
  return /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg) && !/<script|<foreignObject|\bon[a-z]+\s*=|javascript:|<use[^>]+href\s*=\s*["']?(?!#)/i.test(svg);
}

export const templateSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(64),
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  category: z.string().min(1).max(40),
  website: z.url(),
  /** Tile colour behind the logo (or the first letter). */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Shown first in the catalog. */
  popular: z.boolean().optional(),
  /** Mounts the Docker socket or host paths: only Root admins may create it. */
  hostAccess: z.boolean().optional(),
  /** One or two sentences shown before creating (first login, extra ports, …). */
  note: z.string().max(500).optional(),
  /** The oldest Serve version that can run it; older ones leave it out. */
  minVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
  /** Compose service + port that receives the generated domain. */
  expose: z.object({ service: z.string().min(1), port: z.number().int().min(1).max(65535) }),
  /** More compose services that get a generated domain of their own (an API, an admin console). Serve 0.1.9+. */
  domains: z
    .array(z.object({ service: z.string().min(1), port: z.number().int().min(1).max(65535) }))
    .max(4)
    .optional(),
  vars: z.array(varSchema),
  compose: z.string().min(1).max(100_000),
  /** White glyph on the tile (SVG source), or null for a lettered tile. */
  logo: z.string().max(50_000).refine(safeSvg, "not a plain SVG").nullable(),
});

export type CatalogTemplate = z.infer<typeof templateSchema>;

export type Catalog = { schema: number; templates: CatalogTemplate[] };

/** A template folder's template.json: everything but the id, compose file and logo. */
export const templateMetaSchema = templateSchema.omit({ id: true, compose: true, logo: true }).strict();

function newer(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/**
 * Reads a catalog file. Null when the file itself is unusable (not JSON, newer schema);
 * otherwise each template stands alone: a broken one or one for a newer Serve is left out.
 */
export function parseCatalog(text: string, version: string): { templates: CatalogTemplate[]; skipped: string[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const doc = z.object({ schema: z.number().int(), templates: z.array(z.unknown()) }).safeParse(raw);
  if (!doc.success || doc.data.schema > CATALOG_SCHEMA) return null;
  const templates: CatalogTemplate[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const item of doc.data.templates) {
    const t = templateSchema.safeParse(item);
    const id = t.success ? t.data.id : String((item as { id?: unknown })?.id ?? "?");
    if (!t.success || seen.has(t.data.id) || (t.data.minVersion && /^\d+\.\d+\.\d+/.test(version) && newer(t.data.minVersion, version))) {
      skipped.push(id);
      continue;
    }
    seen.add(t.data.id);
    templates.push(t.data);
  }
  return { templates, skipped };
}
