import { PRIVATE_VARS, referencedService, referencesIn } from "@/lib/refs";

export type ServiceUse = {
  id: string;
  variables: string[];
  /** Uses a private name (host, port, connection URL) rather than a public one. */
  private: boolean;
  /** Private names across servers that share no private network: they do not resolve. */
  broken: boolean;
};

/**
 * What each service uses, from the references in its variables. Pure: the caller passes the
 * services, their decrypted variables and which servers reach each other privately.
 */
export function serviceUses(
  services: { id: string; name: string; slug: string; serverId: string }[],
  vars: { serviceId: string; key: string; value: string }[],
  connected: (a: string, b: string) => boolean,
): Map<string, ServiceUse[]> {
  const out = new Map<string, ServiceUse[]>();
  for (const v of vars) {
    const consumer = services.find((s) => s.id === v.serviceId);
    if (!consumer) continue;
    for (const ref of referencesIn([v.value])) {
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
        if (!connected(consumer.serverId, provider.serverId)) use.broken = true;
      }
      out.set(consumer.id, list);
    }
  }
  for (const list of out.values()) for (const u of list) u.variables.sort();
  return out;
}
