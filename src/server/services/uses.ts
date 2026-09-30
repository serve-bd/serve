import { PRIVATE_VARS, referencedService, serviceReferencesIn } from "@/lib/refs";

export type ServiceUse = {
  id: string;
  variables: string[];
  /** Uses a private name (host, port, connection URL) rather than a public one. */
  private: boolean;
  /** Private names this service cannot reach from every server it runs on: they do not resolve. */
  broken: boolean;
};

/**
 * What each service uses, from the references in its variables (followed through its own and
 * shared variables like variable resolution does). Pure: the caller passes the services, their
 * decrypted variables, shared variables and whether one service reaches another's private names.
 */
export function serviceUses<S extends { id: string; name: string; slug: string }>(
  services: S[],
  vars: { serviceId: string; key: string; value: string }[],
  scope: (scope: string, key: string) => string | undefined,
  reaches: (consumer: S, provider: S) => boolean,
): Map<string, ServiceUse[]> {
  const out = new Map<string, ServiceUse[]>();
  for (const v of vars) {
    const consumer = services.find((s) => s.id === v.serviceId);
    if (!consumer) continue;
    const own = (key: string) => vars.find((x) => x.serviceId === consumer.id && x.key === key)?.value;
    for (const ref of serviceReferencesIn(v.value, own, scope)) {
      const provider = referencedService(services, ref.name);
      if (!provider || provider.id === consumer.id) continue;
      const list = out.get(consumer.id) ?? [];
      let use = list.find((u) => u.id === provider.id);
      if (!use) {
        use = { id: provider.id, variables: [], private: false, broken: false };
        list.push(use);
      }
      if (!use.variables.includes(v.key)) use.variables.push(v.key);
      if (PRIVATE_VARS.test(ref.key)) {
        use.private = true;
        if (!reaches(consumer, provider)) use.broken = true;
      }
      out.set(consumer.id, list);
    }
  }
  for (const list of out.values()) for (const u of list) u.variables.sort();
  return out;
}
