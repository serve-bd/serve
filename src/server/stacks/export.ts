import { and, eq, inArray, isNull } from "drizzle-orm";
import YAML from "yaml";
import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { STACK_FILE, toStackName } from "@/lib/stack";

type Service = typeof schema.service.$inferSelect;

export type StackExport = {
  /** serve-compose.yml's text. */
  file: string;
  /** Files it names, by path next to it: env files and compose files. */
  files: Record<string, string>;
  /** What did not fit in the file, to say. */
  notes: string[];
};

const quoteEnv = (v: string) => (/^[A-Za-z0-9_./:@,+=-]*$/.test(v) ? v : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`);

/**
 * An environment's services as a serve-compose.yml that rebuilds them elsewhere. Services are
 * keyed by their names, so ${{ }} links between them read the same in the file. Variable values
 * go to .env.<key> files only with `values` (the caller checked the right to see secrets);
 * otherwise the files list the names with empty values. Links stay in the file: they are not secret.
 */
const onlyLinks = (value: string) => /^(\$\{\{[^}]+\}\})+$/.test(value.trim()) && !/replica\.pick\(/i.test(value);

export async function exportStack(
  environmentId: string,
  opts: {
    stack?: string | null;
    services?: string[];
    values: boolean;
    name: string /** Compose files may hold passwords: shown only to those who manage services. */;
    composeFiles: boolean;
  },
): Promise<StackExport> {
  let services = await db
    .select()
    .from(schema.service)
    .where(and(eq(schema.service.environmentId, environmentId), isNull(schema.service.parentServiceId)));
  if (opts.stack) services = services.filter((s) => s.stackName === opts.stack);
  if (opts.services?.length) {
    const wanted = new Set(opts.services.map((s) => s.toLowerCase()));
    services = services.filter((s) => wanted.has(s.name.toLowerCase()) || wanted.has(s.id));
  }
  const notes: string[] = [];
  const files: Record<string, string> = {};
  const out: Record<string, Record<string, unknown>> = {};
  const ids = services.map((s) => s.id);
  const vars = ids.length ? await db.select().from(schema.envVar).where(inArray(schema.envVar.serviceId, ids)) : [];
  const domains = ids.length
    ? await db
        .select()
        .from(schema.domain)
        .where(and(inArray(schema.domain.serviceId, ids), eq(schema.domain.generated, false)))
    : [];

  for (const s of services.sort((a, b) => Number(b.type === "database") - Number(a.type === "database") || a.name.localeCompare(b.name))) {
    const entry = source(s, notes, opts.composeFiles);
    if (!entry) continue;
    const extra = entry.__file as [string, string] | undefined;
    if (extra) {
      files[extra[0]] = extra[1];
      delete entry.__file;
    }
    if (s.type !== "database") {
      if (s.runtime.port && s.type === "app") entry.port = s.runtime.port;
      const mine = domains.filter((d) => d.serviceId === s.id);
      if (mine.length)
        entry.domains = mine.map((d) =>
          d.composeService || d.port ? { host: d.hostname, ...(d.port ? { port: d.port } : {}), ...(d.composeService ? { service: d.composeService } : {}) } : d.hostname,
        );
      if (s.type === "app" && s.runtime.replicas && s.runtime.replicas !== 1) entry.deploy = { replicas: s.runtime.replicas };

      const env: Record<string, string> = {};
      const lines: string[] = [];
      for (const v of vars.filter((x) => x.serviceId === s.id).sort((a, b) => a.key.localeCompare(b.key))) {
        const value = decryptOrNull(v.value) ?? "";
        // A value made only of links reads the same anywhere the services keep their names, and is
        // not secret (the variables page shows it to everyone): it stays in the file. Text next
        // to a link, or a replica.pick list, is a value like any other.
        if (!v.literal && onlyLinks(value)) env[v.key] = value;
        else lines.push(`${v.key}=${opts.values ? quoteEnv(value) : ""}`);
      }
      if (Object.keys(env).length) entry.env = env;
      if (lines.length) {
        const path = `.env.${s.name}`;
        files[path] = `${opts.values ? "" : "# Fill in the values.\n"}${lines.join("\n")}\n`;
        entry.env_file = path;
      }
    }
    out[s.name] = entry;
  }
  if (!opts.values && Object.keys(files).some((f) => f.startsWith(".env."))) notes.push("Variable values were left out: fill in the .env files, or export again with values.");
  const doc = { name: toStackName(opts.name) || "stack", services: out };
  const file = `# ${STACK_FILE}: serve compose up rebuilds these services. Database data is not in it: restore a backup.\n${YAML.stringify(doc, { lineWidth: 0 })}`;
  return { file, files, notes };
}

/** Where a service comes from, as the file says it; null (with a note) when a file cannot say it. */
function source(s: Service, notes: string[], composeFiles: boolean): Record<string, unknown> | null {
  if (s.type === "database" && s.database) {
    const { engine, version } = s.database as { engine: string; version: string };
    return { database: `${engine}:${version}` };
  }
  if (s.type === "compose") {
    if (!composeFiles) {
      notes.push(`${s.name}: its compose file is shown only to members who manage services. Skipped.`);
      return null;
    }
    if (!s.compose?.content) {
      notes.push(`${s.name}: its compose file comes from a repository, which a stack cannot name yet. Skipped.`);
      return null;
    }
    const path = `${s.name}.compose.yml`;
    return { compose: path, __file: [path, s.compose.content] };
  }
  const src = s.source;
  const build = s.build;
  const settings: Record<string, unknown> = {};
  if (build) {
    if (build.builder && build.builder !== "auto") settings.builder = build.builder;
    if (build.dockerfile && build.dockerfile !== "Dockerfile") settings.dockerfile = build.dockerfile;
    for (const k of ["installCommand", "buildCommand", "startCommand", "publishDir", "target"] as const) if (build[k]) settings[k] = build[k];
    const root = (build.rootDir ?? "/").replace(/^\/+/, "");
    if (root) settings.rootDir = root;
  }
  if (src?.type === "git") {
    return { git: { repo: src.repository, branch: src.branch }, ...(Object.keys(settings).length ? { build: settings } : {}) };
  }
  if (src?.type === "image") {
    if (src.registryId || src.registryUsername) notes.push(`${s.name}: its image needs a registry login. Add the registry in the other Serve too.`);
    return { image: src.image };
  }
  if (src?.type === "upload") {
    notes.push(`${s.name}: it is deployed from the CLI. Put its folder at ./${s.name} next to ${STACK_FILE}.`);
    return { build: { context: `./${s.name}`, ...settings } };
  }
  notes.push(`${s.name}: its Dockerfile is pasted in Serve, which a stack cannot hold yet. Skipped.`);
  return null;
}
