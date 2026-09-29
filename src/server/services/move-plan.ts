import { referenceName } from "@/lib/refs";

/**
 * Moving services to another environment, worked out before anything changes: new names
 * (unique in the target), references that stop working, services worth moving along, and
 * the variable rewrites for renamed services. Pure, so it can be tested and previewed.
 */

export type MoveService = {
  id: string;
  name: string;
  slug: string;
  hostname: string | null;
  type: string;
  environmentId: string;
  projectId: string;
  parentServiceId: string | null;
};

export type MoveVar = { key: string; value: string };

export type MoveInput = {
  /** Services chosen to move (top level; previews are added by the caller as children). */
  moving: MoveService[];
  /** Previews and other children that follow their parent. */
  children: MoveService[];
  /** Every service of the source environments, moving or not. */
  sourceServices: MoveService[];
  /** Services already in the target environment. */
  targetServices: MoveService[];
  /** Variables by service id, decrypted, for every source service. */
  vars: Record<string, MoveVar[]>;
  /** Keys each service provides to references of its own (${{KEY}} without a scope). */
  selfKeys: Record<string, string[]>;
  /** Shared variable keys: per source environment, the target environment, and projects. */
  envKeys: Record<string, string[]>;
  targetEnvKeys: string[];
  projectKeys: Record<string, string[]>;
  targetProjectId: string;
};

export type BrokenReference = {
  /** Service whose variable holds the reference. */
  serviceId: string;
  serviceName: string;
  key: string;
  ref: string;
  reason: string;
  /** Moving this service too keeps the reference working. */
  fixWith: string | null;
};

export type MovePlan = {
  services: { id: string; name: string; newName: string; type: string; clearHostname: boolean; notes: string[] }[];
  broken: BrokenReference[];
  suggestions: { id: string; name: string; reason: string }[];
  /** Variable values to write for moved services whose references pointed at renamed services. */
  rewrites: Record<string, MoveVar[]>;
};

const REF = /\$\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const SCOPES = new Set(["shared", "environment", "project", "org", "team"]);

export function referencesIn(value: string) {
  return [...value.matchAll(REF)].map((m) => {
    const ref = m[1];
    const dot = ref.indexOf(".");
    return dot === -1 ? { ref, scope: null, key: ref } : { ref, scope: ref.slice(0, dot).toLowerCase(), key: ref.slice(dot + 1) };
  });
}

/** The service a reference scope names, the way resolveEnv does it (slug, name, dashed name; shared names match nothing). */
export function scopeTarget(scope: string, services: MoveService[]): MoveService | null {
  const bySlug = services.find((s) => s.slug.toLowerCase() === scope);
  if (bySlug) return bySlug;
  const byName = services.filter((s) => s.name.toLowerCase() === scope || referenceName(s.name) === scope);
  return byName.length === 1 ? byName[0] : null;
}

const taken = (name: string, names: Set<string>) => names.has(referenceName(name));

export function planMove(input: MoveInput): MovePlan {
  const moving = [...input.moving, ...input.children];
  const movingIds = new Set(moving.map((s) => s.id));
  const names = new Set(input.targetServices.map((s) => referenceName(s.name)));
  const targetHosts = new Set(input.targetServices.flatMap((s) => [s.slug, s.hostname].filter(Boolean) as string[]));

  // New names, unique in the target environment (moved services count as they are placed).
  const newName = new Map<string, string>();
  const services: MovePlan["services"] = [];
  for (const s of moving) {
    let name = s.name;
    if (taken(name, names)) {
      for (let i = 2; i < 100 && taken(name, names); i++) name = `${s.name}-${i}`;
    }
    names.add(referenceName(name));
    newName.set(s.id, name);
    const clearHostname = !!s.hostname && targetHosts.has(s.hostname);
    const notes: string[] = [];
    if (name !== s.name) notes.push(`Renamed to ${name}: the target environment already has a service called ${s.name}.`);
    if (clearHostname) notes.push(`Its private hostname ${s.hostname} is taken there, so it goes back to ${s.slug}.`);
    if (s.parentServiceId && movingIds.has(s.parentServiceId)) notes.push("Moves with its parent service.");
    services.push({ id: s.id, name: s.name, newName: name, type: s.type, clearHostname, notes });
  }

  const broken: BrokenReference[] = [];
  const rewrites: MovePlan["rewrites"] = {};
  const byId = new Map(input.sourceServices.map((s) => [s.id, s]));
  const envOf = (id: string) => byId.get(id)?.environmentId ?? "";

  for (const holder of input.sourceServices) {
    const inSameEnv = input.sourceServices.filter((s) => s.environmentId === holder.environmentId);
    const holderMoves = movingIds.has(holder.id);
    let changed = false;
    const nextVars = (input.vars[holder.id] ?? []).map((v) => {
      const renames = new Map<string, string>();
      for (const r of referencesIn(v.value)) {
        const push = (reason: string, fixWith: string | null) => broken.push({ serviceId: holder.id, serviceName: holder.name, key: v.key, ref: r.ref, reason, fixWith });
        if (r.scope === null) {
          // ${{KEY}}: its own variable, then the environment's shared ones, then what the service provides.
          if (!holderMoves) continue;
          const own = (input.vars[holder.id] ?? []).some((x) => x.key === r.key);
          const self = (input.selfKeys[holder.id] ?? []).includes(r.key);
          const fromEnv = (input.envKeys[envOf(holder.id)] ?? []).includes(r.key);
          if (!own && !self && fromEnv && !input.targetEnvKeys.includes(r.key)) push(`The target environment has no shared variable ${r.key}.`, null);
          continue;
        }
        if (SCOPES.has(r.scope)) {
          if (!holderMoves) continue;
          if ((r.scope === "environment" || r.scope === "shared") && !input.targetEnvKeys.includes(r.key)) {
            push(`The target environment has no shared variable ${r.key}.`, null);
          }
          if (r.scope === "project" && holder.projectId !== input.targetProjectId && !(input.projectKeys[input.targetProjectId] ?? []).includes(r.key)) {
            push(`The target project has no shared variable ${r.key}.`, null);
          }
          continue;
        }
        const target = scopeTarget(r.scope, inSameEnv);
        if (!target || target.id === holder.id) continue;
        const targetMoves = movingIds.has(target.id);
        if (holderMoves && targetMoves) {
          // Both move: keep it working, pointing at the new name when the service was renamed.
          const renamed = newName.get(target.id)!;
          if (renamed !== target.name && r.scope !== target.slug.toLowerCase()) renames.set(r.ref, `${referenceName(renamed)}.${r.key}`);
        } else if (holderMoves && !targetMoves) {
          const clash = scopeTarget(r.scope, input.targetServices);
          push(
            clash
              ? `${target.name} stays behind, and ${clash.name} in the target environment has the same name, so the reference would point there.`
              : `${target.name} stays in the current environment.`,
            target.parentServiceId ? null : target.id,
          );
        } else if (!holderMoves && targetMoves) {
          push(`${target.name} moves away from ${holder.name}.`, holder.parentServiceId ? null : holder.id);
        }
      }
      if (!renames.size) return v;
      changed = true;
      return { key: v.key, value: v.value.replace(REF, (m, ref: string) => (renames.has(ref) ? `\${{${renames.get(ref)}}}` : m)) };
    });
    if (changed) rewrites[holder.id] = nextVars;
  }

  const suggestions = [...new Map(broken.filter((b) => b.fixWith).map((b) => [b.fixWith!, b])).values()].map((b) => {
    const s = byId.get(b.fixWith!)!;
    return { id: s.id, name: s.name, reason: b.serviceId === s.id ? `uses ${b.ref}` : `${b.serviceName} uses ${b.ref}` };
  });

  return { services, broken, suggestions, rewrites };
}
