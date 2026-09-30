import YAML, { isMap, isScalar, isSeq, type Document, type YAMLMap } from "yaml";

/**
 * Storage of one compose service, read from and written back to the compose file. The file stays
 * the source of truth: the storage page only edits `volumes` and `configs` of a service, keeping
 * comments and everything else as written.
 */
export type ComposeMount =
  /** A named volume of the stack (`data:/var/lib/app`). */
  | { kind: "volume"; source: string; target: string; readOnly?: boolean }
  /** A path on the server (`/srv/media:/media`, `./conf:/etc/app`). */
  | {
      kind: "bind";
      source: string;
      target: string;
      readOnly?: boolean;
      /** "file": an existing file; written so Docker does not create a directory in its place. */
      hostType?: "file" | "directory";
    }
  /** A file whose content lives in the compose file (top-level `configs` with `content`); always read-only. */
  | { kind: "file"; name: string; target: string; content: string }
  /** Anything else (tmpfs, anonymous volumes, interpolated paths, configs from files): kept as written. */
  | { kind: "other"; from: "volumes" | "configs"; index: number; target: string; label: string };

export type ServiceMounts = { service: string; mounts: ComposeMount[] };

export const MOUNT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

// Inline config content is interpolated by Compose: a literal $ is written as $$.
const escapeDollars = (s: string) => s.replace(/\$/g, "$$$$");
const unescapeDollars = (s: string) => s.replace(/\$\$/g, "$");

function parse(content: string) {
  const doc = YAML.parseDocument(content, { merge: true });
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  return doc;
}

function shortVolume(raw: string, index: number): ComposeMount {
  const parts = raw.split(":");
  // Windows drive letters are not a concern on Linux servers; a single part is an anonymous volume.
  if (parts.length === 1) return { kind: "other", from: "volumes", index, target: parts[0], label: "Anonymous volume" };
  const [source, target, mode] = parts;
  const readOnly = (mode ?? "").split(",").includes("ro") || undefined;
  if (source.includes("$")) return { kind: "other", from: "volumes", index, target, label: `Path from a variable (${source})` };
  if (/^[/.~]/.test(source)) return { kind: "bind", source, target, readOnly };
  return { kind: "volume", source, target, readOnly };
}

function longVolume(v: Record<string, unknown>, index: number): ComposeMount {
  const target = String(v.target ?? "");
  const source = typeof v.source === "string" ? v.source : "";
  const readOnly = v.read_only === true || undefined;
  // `bind: { create_host_path: false }` is how the page writes a server file.
  const bind = v.bind as Record<string, unknown> | undefined;
  const fileBind = !!bind && Object.keys(bind).length === 1 && bind.create_host_path === false;
  const extra = Object.keys(v).some((k) => !["type", "source", "target", "read_only"].includes(k) && !(k === "bind" && fileBind));
  if (!extra && !source.includes("$")) {
    if (v.type === "volume" && source && !bind) return { kind: "volume", source, target, readOnly };
    if (v.type === "bind" && source) return fileBind ? { kind: "bind", source, target, readOnly, hostType: "file" } : { kind: "bind", source, target, readOnly };
  }
  return { kind: "other", from: "volumes", index, target, label: v.type === "tmpfs" ? "Temporary (tmpfs)" : `${String(v.type ?? "mount")} mount` };
}

/** The storage of every service in a compose file. */
export function readComposeMounts(content: string): ServiceMounts[] {
  const data = parse(content).toJS() as {
    services?: Record<string, { volumes?: unknown[]; configs?: unknown[] } | null>;
    configs?: Record<string, { content?: unknown; file?: unknown } | null>;
  } | null;
  const configs = data?.configs ?? {};
  return Object.entries(data?.services ?? {}).map(([service, svc]) => {
    const mounts: ComposeMount[] = [];
    (Array.isArray(svc?.volumes) ? svc.volumes : []).forEach((v, i) => {
      if (typeof v === "string") mounts.push(shortVolume(v, i));
      else if (v && typeof v === "object") mounts.push(longVolume(v as Record<string, unknown>, i));
    });
    (Array.isArray(svc?.configs) ? svc.configs : []).forEach((c, i) => {
      const ref = typeof c === "string" ? { source: c } : ((c ?? {}) as { source?: string; target?: string; uid?: unknown; gid?: unknown; mode?: unknown });
      const name = String(ref.source ?? "");
      const target = ref.target ?? `/${name}`;
      const def = configs[name];
      const plain = typeof c === "string" || Object.keys(ref).every((k) => k === "source" || k === "target");
      if (plain && def && typeof def.content === "string") mounts.push({ kind: "file", name, target, content: unescapeDollars(def.content) });
      else mounts.push({ kind: "other", from: "configs", index: i, target, label: def?.file ? `Config file (${String(def.file)})` : "Config" });
    });
    return { service, mounts };
  });
}

/** Problems with mounts before they are written: empty fields, relative targets, bad names, duplicates. */
export function composeMountProblems(mounts: ComposeMount[]): string[] {
  const problems: string[] = [];
  const targets = new Set<string>();
  const names = new Set<string>();
  for (const m of mounts) {
    if (!m.target.startsWith("/")) problems.push(`"${m.target || "(empty)"}" is not an absolute path in the container`);
    else if (targets.has(m.target)) problems.push(`${m.target} is mounted twice`);
    targets.add(m.target);
    if (m.kind === "volume" && !MOUNT_NAME.test(m.source)) problems.push(`"${m.source}" is not a valid volume name (letters, digits, . _ -)`);
    if (m.kind === "bind" && !/^(\/|\.{1,2}\/|~)/.test(m.source)) problems.push(`"${m.source}" must be an absolute path on the server`);
    if (m.kind === "file") {
      if (!MOUNT_NAME.test(m.name)) problems.push(`"${m.name}" is not a valid file name (letters, digits, . _ -)`);
      else if (names.has(m.name)) problems.push(`The file name ${m.name} is used twice`);
      names.add(m.name);
    }
  }
  return problems;
}

function serviceNode(doc: Document, service: string) {
  const services = doc.get("services");
  if (!isMap(services)) throw new Error("The compose file has no services.");
  const node = services.get(service, true);
  if (!isMap(node)) throw new Error(`The compose file has no service ${service}.`);
  return node as YAMLMap;
}

/** Names of top-level configs with inline content that no service uses any more. */
function usedConfigNames(doc: Document) {
  const used = new Set<string>();
  const services = doc.get("services");
  if (!isMap(services)) return used;
  for (const item of services.items) {
    const configs = isMap(item.value) ? item.value.get("configs") : null;
    if (!isSeq(configs)) continue;
    for (const c of configs.toJSON() as unknown[]) used.add(typeof c === "string" ? c : String((c as { source?: string })?.source ?? ""));
  }
  return used;
}

function usedVolumeNames(doc: Document) {
  const used = new Set<string>();
  for (const s of readComposeMounts(doc.toString())) for (const m of s.mounts) if (m.kind === "volume") used.add(m.source);
  return used;
}

/**
 * Replaces one service's storage. Mounts of kind "other" refer to entries by position and are
 * kept exactly as written. New named volumes and files get top-level entries; top-level entries
 * the page added that nothing uses any more are removed (ones with settings are left alone).
 */
export function writeComposeMounts(content: string, service: string, mounts: ComposeMount[]): string {
  const problems = composeMountProblems(mounts);
  if (problems.length) throw new Error(problems.join("; "));
  const doc = parse(content);
  const node = serviceNode(doc, service);
  const oldVolumes = node.get("volumes", true);
  const oldConfigs = node.get("configs", true);
  const keep = (seq: unknown, index: number) => (isSeq(seq) ? seq.items[index] : undefined);

  const volumes: unknown[] = [];
  const configs: unknown[] = [];
  const files: { name: string; content: string }[] = [];
  for (const m of mounts) {
    if (m.kind === "bind" && m.hostType === "file") {
      volumes.push(doc.createNode({ type: "bind", source: m.source, target: m.target, ...(m.readOnly ? { read_only: true } : {}), bind: { create_host_path: false } }));
    } else if (m.kind === "volume" || m.kind === "bind") {
      const text = `${m.source}:${m.target}${m.readOnly ? ":ro" : ""}`;
      // An unchanged entry keeps its node, and with it its comment.
      const same = isSeq(oldVolumes) ? oldVolumes.items.find((item) => isScalar(item) && item.value === text && !volumes.includes(item)) : undefined;
      volumes.push(same ?? text);
    } else if (m.kind === "file") {
      configs.push(doc.createNode({ source: m.name, target: m.target }));
      files.push({ name: m.name, content: m.content });
    } else {
      const kept = keep(m.from === "volumes" ? oldVolumes : oldConfigs, m.index);
      if (kept !== undefined) (m.from === "volumes" ? volumes : configs).push(kept);
    }
  }
  if (volumes.length) node.set("volumes", doc.createNode(volumes));
  else node.delete("volumes");
  if (configs.length) node.set("configs", doc.createNode(configs));
  else node.delete("configs");

  // Top-level configs: inline content for this service's files.
  let topConfigs = doc.get("configs", true);
  if (files.length && !isMap(topConfigs)) {
    topConfigs = doc.createNode({});
    doc.set("configs", topConfigs);
  }
  if (isMap(topConfigs)) {
    for (const f of files) {
      const existing = topConfigs.get(f.name, true);
      if (isMap(existing) && existing.has("file")) throw new Error(`A config called ${f.name} already reads a file. Choose another name.`);
      topConfigs.set(f.name, doc.createNode({ content: escapeDollars(f.content) }));
    }
    const used = usedConfigNames(doc);
    for (const item of [...topConfigs.items]) {
      const key = String((item.key as { value?: unknown })?.value ?? item.key);
      const value = item.value;
      const inline = isMap(value) && value.items.length === 1 && value.has("content");
      if (inline && !used.has(key)) topConfigs.delete(key);
    }
    if (!topConfigs.items.length) doc.delete("configs");
  }

  // Top-level volumes: declare new named volumes; drop empty declarations nothing uses.
  const named = mounts.filter((m) => m.kind === "volume").map((m) => (m as { source: string }).source);
  let topVolumes = doc.get("volumes", true);
  if (named.length && !isMap(topVolumes)) {
    topVolumes = doc.createNode({});
    doc.set("volumes", topVolumes);
  }
  if (isMap(topVolumes)) {
    for (const name of named) if (!topVolumes.has(name)) topVolumes.set(name, doc.createNode({}));
    const used = usedVolumeNames(doc);
    for (const item of [...topVolumes.items]) {
      const key = String((item.key as { value?: unknown })?.value ?? item.key);
      const value = item.value as { value?: unknown } | null;
      const empty = value === null || (value && "value" in value && value.value === null) || (isMap(value) && !value.items.length);
      if (empty && !used.has(key)) topVolumes.delete(key);
    }
    if (!topVolumes.items.length) doc.delete("volumes");
  }
  return doc.toString();
}

/** Docker's name for a named volume of a stack: its `name:` when set, else `<project>_<volume>`. */
export function composeVolumeName(content: string, project: string, volume: string) {
  const data = parse(content).toJS() as { volumes?: Record<string, { name?: unknown } | null> } | null;
  const def = data?.volumes?.[volume];
  return typeof def?.name === "string" && def.name ? def.name : `${project}_${volume}`;
}
