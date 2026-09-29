/**
 * Limits per organization, shared by the dashboard and the server. A missing or
 * null value means unlimited.
 */

export type OrgLimits = {
  projects?: number | null;
  /** Apps, Docker Compose stacks and databases together. Previews count. */
  services?: number | null;
  apps?: number | null;
  compose?: number | null;
  databases?: number | null;
  domains?: number | null;
  /** Sum of the CPU limits of all services, in cores. */
  cpu?: number | null;
  /** Sum of the memory limits of all services, in MB. */
  memory?: number | null;
  /** Measured size of the organization's volumes, in GB. */
  disk?: number | null;
  /** Size of the organization's backups, in GB. */
  backupStorage?: number | null;
  /** Builds that may run at the same time; more wait in the queue. */
  concurrentBuilds?: number | null;
  /** Different servers the organization's services may run on. */
  servers?: number | null;
  /** Only these servers may be used. Null means every server the organization can see. */
  allowedServers?: string[] | null;
  /** CPU (cores) a service without its own limit counts as, and gets, when a CPU limit applies. */
  defaultCpu?: number | null;
  /** Memory (MB) a service without its own limit counts as, and gets, when a memory limit applies. */
  defaultMemory?: number | null;
};

export type CountedLimit = Exclude<keyof OrgLimits, "allowedServers" | "defaultCpu" | "defaultMemory">;

export const limitCatalog: { key: CountedLimit; label: string; unit?: string; step?: number; description: string }[] = [
  { key: "projects", label: "Projects", description: "Projects in the organization." },
  { key: "services", label: "Services", description: "Apps, stacks and databases, previews included." },
  { key: "apps", label: "Apps", description: "Services built from Git or an image." },
  { key: "compose", label: "Docker Compose stacks", description: "Stacks, counted once each." },
  { key: "databases", label: "Databases", description: "Database services." },
  { key: "domains", label: "Domains", description: "Custom and generated domains." },
  { key: "cpu", label: "CPU", unit: "cores", step: 0.25, description: "Sum of the services' CPU limits." },
  { key: "memory", label: "Memory", unit: "MB", description: "Sum of the services' memory limits." },
  { key: "disk", label: "Volume storage", unit: "GB", step: 0.5, description: "Measured size of volumes, checked every half hour." },
  { key: "backupStorage", label: "Backup storage", unit: "GB", step: 0.5, description: "Size of kept backups." },
  { key: "concurrentBuilds", label: "Builds at once", description: "More builds wait in the queue." },
  { key: "servers", label: "Servers", description: "Different servers the services run on." },
];

export const DEFAULT_RESERVATION = { cpu: 0.5, memory: 512 };

export type Usage = Partial<Record<CountedLimit, number>>;

/** Share of a limit in use: ok below 80 %, warn from 80 %, full at 100 %. */
export function usageLevel(used: number, limit: number | null | undefined): "ok" | "warn" | "full" {
  if (limit === null || limit === undefined) return "ok";
  if (limit <= 0 || used >= limit) return "full";
  return used / limit >= 0.8 ? "warn" : "ok";
}

export function formatLimitValue(key: CountedLimit, value: number) {
  const unit = limitCatalog.find((l) => l.key === key)?.unit;
  const n = Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1).replace(/\.?0+$/, "");
  return unit ? `${n} ${unit}` : n;
}

/**
 * The message for going over a limit, or null when `adding` more still fits.
 * Adding nothing (a check of the current state) only fails when already over.
 */
export function limitError(key: CountedLimit, used: number, adding: number, limit: number | null | undefined): string | null {
  if (limit === null || limit === undefined) return null;
  const after = used + adding;
  if (adding > 0 ? after <= limit + 1e-9 : used <= limit + 1e-9) return null;
  const label = limitCatalog.find((l) => l.key === key)?.label ?? key;
  const name = label === label.toUpperCase() ? label : label.toLowerCase();
  return `This organization has reached its ${name} limit (${formatLimitValue(key, used)} of ${formatLimitValue(key, limit)} used). Ask an administrator to raise it.`;
}

/** Keeps only valid, non-negative numbers; empty values mean unlimited. */
export function normalizeLimits(input: OrgLimits): OrgLimits {
  const out: OrgLimits = {};
  for (const { key } of limitCatalog) {
    const v = input[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = key === "cpu" || key === "disk" || key === "backupStorage" ? Math.round(v * 100) / 100 : Math.round(v);
  }
  if (typeof input.defaultCpu === "number" && input.defaultCpu > 0) out.defaultCpu = Math.round(input.defaultCpu * 100) / 100;
  if (typeof input.defaultMemory === "number" && input.defaultMemory > 0) out.defaultMemory = Math.round(input.defaultMemory);
  if (Array.isArray(input.allowedServers)) out.allowedServers = [...new Set(input.allowedServers.filter((s) => typeof s === "string" && s))];
  return out;
}

export function hasAnyLimit(limits: OrgLimits) {
  return limitCatalog.some(({ key }) => typeof limits[key] === "number") || !!limits.allowedServers;
}

/**
 * The first limit that adding these would break, with its message. New services also
 * need room on disk: a full volume limit refuses them.
 */
export function firstOverLimit(limits: OrgLimits, usage: Usage, adds: Partial<Record<CountedLimit, number>>): { key: CountedLimit; message: string } | null {
  for (const [key, add] of Object.entries(adds) as [CountedLimit, number][]) {
    if (!add) continue;
    const message = limitError(key, usage[key] ?? 0, add, limits[key]);
    if (message) return { key, message };
  }
  const disk = usage.disk ?? 0;
  if ((adds.services ?? 0) > 0 && limits.disk != null && disk >= limits.disk) {
    return { key: "disk", message: limitError("disk", disk, 1, limits.disk) ?? "Volume storage is full." };
  }
  return null;
}
