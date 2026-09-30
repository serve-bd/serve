/** IPv4 range of a CIDR as [first, last] numbers, or null for anything else (IPv6). */
export function v4Range(cidr: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (!m) return null;
  const prefix = Number(m[5]);
  const base = ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
  const size = 2 ** (32 - prefix);
  const first = base - (base % size);
  return [first, first + size - 1];
}

/**
 * A /16 for the shared network when Docker's pools are exhausted: 10.209.0.0/16 first, then
 * 10.223-10.239 (outside stacks 10.210-10.219, tunnels 10.222 and the private network 10.240+).
 * Another Serve instance on the same engine already holds 10.209, so the next free one is taken.
 */
export function freeSharedSubnet(used: string[]) {
  const taken = used.map(v4Range).filter((r): r is [number, number] => !!r);
  for (const second of [209, ...Array.from({ length: 17 }, (_, i) => 223 + i)]) {
    const [first, last] = v4Range(`10.${second}.0.0/16`)!;
    if (!taken.some(([a, b]) => first <= b && a <= last)) return `10.${second}.0.0/16`;
  }
  return null;
}
