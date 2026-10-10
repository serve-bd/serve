import { db, schema } from "@/server/db";
import { decryptOrNull } from "@/server/crypto";
import { scopeReader } from "@/lib/refs";
import { serviceUses } from "@/server/services/uses";

type Service = typeof schema.service.$inferSelect;

/**
 * For each service, the services of its environment it uses: ${{name.VAR}} references (through
 * its own and shared variables, like variable resolution), and private names written out in its
 * variables or compose file (`names` gives each service's). Null when the variables cannot be read:
 * then every service may use every other one.
 */
export async function loadServiceUses(services: Service[], names: (s: Service) => string[], namesHost: (text: string, names: string[]) => boolean) {
  try {
    const [vars, projects, shared] = await Promise.all([
      db.select({ serviceId: schema.envVar.serviceId, key: schema.envVar.key, value: schema.envVar.value, literal: schema.envVar.literal }).from(schema.envVar),
      db.select({ id: schema.project.id, organizationId: schema.project.organizationId }).from(schema.project),
      db.select().from(schema.sharedVar),
    ]);
    const plain = vars.map((v) => ({ ...v, value: decryptOrNull(v.value) ?? "" }));
    const orgOf = new Map(projects.map((p) => [p.id, p.organizationId]));
    const sharedPlain = shared.map((v) => ({ ...v, value: decryptOrNull(v.value) ?? "" }));
    const byEnv = new Map<string, Service[]>();
    for (const s of services) byEnv.set(s.environmentId, [...(byEnv.get(s.environmentId) ?? []), s]);
    const out = new Map<string, Set<string>>();
    for (const [environmentId, list] of byEnv) {
      const projectId = list[0].projectId;
      const orgId = orgOf.get(projectId);
      const mapOf = (pick: (v: (typeof sharedPlain)[number]) => boolean) => Object.fromEntries(sharedPlain.filter(pick).map((v) => [v.key, v.value]));
      const scope = scopeReader({
        environment: mapOf((v) => v.environmentId === environmentId),
        project: mapOf((v) => !v.environmentId && v.projectId === projectId),
        org: mapOf((v) => !v.environmentId && !v.projectId && v.organizationId === orgId),
      });
      const ids = new Set(list.map((s) => s.id));
      const envVars = plain.filter((v) => ids.has(v.serviceId));
      // Literal values reference nothing: their ${{…}} is text.
      const refs = serviceUses(
        list,
        envVars.filter((v) => !v.literal),
        scope,
        () => true,
      );
      for (const c of list) {
        const used = new Set((refs.get(c.id) ?? []).map((u) => u.id));
        // A name typed into a value (postgres://…@postgresql:5432) or a compose file.
        const texts = [...envVars.filter((v) => v.serviceId === c.id).map((v) => v.value), c.compose?.content ?? ""].filter(Boolean);
        for (const p of list) if (p.id !== c.id && !used.has(p.id) && texts.some((t) => namesHost(t, names(p)))) used.add(p.id);
        out.set(c.id, used);
      }
    }
    return out;
  } catch {
    return null;
  }
}
