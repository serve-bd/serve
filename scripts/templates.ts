/**
 * Builds templates/index.json from the templates/<id>/ folders, the file Serve reads from GitHub.
 *   pnpm templates:build   write it
 *   pnpm templates:check   fail when a template is invalid or the file is out of date (CI)
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { composeVariables } from "../src/lib/compose-vars";
import { CATALOG_SCHEMA, type Catalog, templateMetaSchema, templateSchema } from "../src/lib/template-catalog";

export const TEMPLATES_DIR = path.resolve(__dirname, "../templates");
export const INDEX_FILE = path.join(TEMPLATES_DIR, "index.json");

/** Mistakes the schema cannot see: the compose file and template.json must agree. */
function composeProblems(
  id: string,
  compose: string,
  expose: { service: string },
  vars: { key: string; serviceUrl?: string; serviceHost?: string }[],
  domains: { service: string }[] = [],
  minVersion?: string,
) {
  const problems: string[] = [];
  let doc: { services?: Record<string, unknown> } | null = null;
  try {
    doc = YAML.parse(compose);
  } catch (err) {
    return [`${id}: compose.yml is not valid YAML (${(err as Error).message.split("\n")[0]})`];
  }
  if (!doc?.services || typeof doc.services !== "object") return [`${id}: compose.yml has no services`];
  if (!(expose.service in doc.services)) problems.push(`${id}: expose.service "${expose.service}" is not a service in compose.yml`);
  for (const d of domains) {
    if (!(d.service in doc.services)) problems.push(`${id}: domains service "${d.service}" is not a service in compose.yml`);
    if (d.service === expose.service) problems.push(`${id}: domains repeats the exposed service "${d.service}"`);
  }
  const routed = new Set([expose.service, ...domains.map((d) => d.service)]);
  for (const v of vars) {
    const target = v.serviceUrl ?? v.serviceHost;
    if (target && !routed.has(target)) problems.push(`${id}: var ${v.key} follows "${target}", which has no domain (add it to domains)`);
  }
  // Older versions would create the stack without the extra domains.
  const needs019 = domains.length > 0 || vars.some((v) => v.serviceUrl || v.serviceHost || (v as { generate?: string }).generate === "hex16");
  if (needs019 && (!minVersion || minVersion.localeCompare("0.1.9", undefined, { numeric: true }) < 0)) {
    problems.push(`${id}: uses domains, serviceUrl/serviceHost or hex16: set "minVersion": "0.1.9"`);
  }
  const declared = new Set(vars.map((v) => v.key));
  for (const v of composeVariables(compose)) {
    if (!v.hasDefault && !declared.has(v.name)) problems.push(`${id}: compose.yml uses \${${v.name}} but template.json has no var for it`);
  }
  return problems;
}

export function buildCatalog(dir = TEMPLATES_DIR): { catalog: Catalog; problems: string[] } {
  const problems: string[] = [];
  const templates: Catalog["templates"] = [];
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const id of ids) {
    const folder = path.join(dir, id);
    const read = (name: string) => (fs.existsSync(path.join(folder, name)) ? fs.readFileSync(path.join(folder, name), "utf8") : null);
    const metaText = read("template.json");
    const compose = read("compose.yml");
    if (!metaText || !compose) {
      problems.push(`${id}: needs template.json and compose.yml`);
      continue;
    }
    let meta: unknown;
    try {
      meta = JSON.parse(metaText);
    } catch (err) {
      problems.push(`${id}: template.json is not valid JSON (${(err as Error).message})`);
      continue;
    }
    const metaResult = templateMetaSchema.safeParse(meta);
    if (!metaResult.success) {
      problems.push(...metaResult.error.issues.map((i) => `${id}: template.json ${i.path.join(".") || "(root)"}: ${i.message}`));
      continue;
    }
    const logo = read("logo.svg");
    const result = templateSchema.safeParse({ id, ...metaResult.data, compose, logo: logo?.trim() ?? null });
    if (!result.success) {
      problems.push(...result.error.issues.map((i) => `${id}: ${i.path.join(".") || "(root)"}: ${i.message}`));
      continue;
    }
    problems.push(...composeProblems(id, compose, result.data.expose, result.data.vars, result.data.domains, result.data.minVersion));
    templates.push(result.data);
  }
  return { catalog: { schema: CATALOG_SCHEMA, templates }, problems };
}

export const serializeCatalog = (catalog: Catalog) => `${JSON.stringify(catalog, null, 1)}\n`;

if (require.main === module) {
  const check = process.argv.includes("--check");
  const { catalog, problems } = buildCatalog();
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  const text = serializeCatalog(catalog);
  if (check) {
    const current = fs.existsSync(INDEX_FILE) ? fs.readFileSync(INDEX_FILE, "utf8") : "";
    if (current !== text) {
      console.error("templates/index.json is out of date: run pnpm templates:build and commit it.");
      process.exit(1);
    }
    console.log(`${catalog.templates.length} templates OK.`);
  } else {
    fs.writeFileSync(INDEX_FILE, text);
    console.log(`Wrote ${catalog.templates.length} templates to templates/index.json.`);
  }
}
