/*
 * A service's chart over all the servers it runs on: each server's samples ("<service>@<server>"
 * scopes, see metrics) are averaged per bucket, then added up. Servers report on their own, so a
 * bucket can miss one: it then counts with its last value for a couple of buckets instead of
 * dipping. Network use is a byte counter per server; the combined counter only grows by each
 * server's own increases, so a gap, a server joining or a counter reset never shows as a spike.
 */

export type ScopePoint = {
  scope: string;
  t: number;
  cpu: number;
  memory: number;
  memoryLimit: number;
  netRx: number | null;
  netTx: number | null;
  disk: number | null;
  diskTotal: number | null;
};

export type SeriesPoint = Omit<ScopePoint, "scope">;

/** Buckets a server may miss before it stops counting (with its last value) until it reports again. */
const FILL = 2;

const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);

export function combineScopes(points: ScopePoint[], stepMs: number): SeriesPoint[] {
  const times = [...new Set(points.map((p) => p.t))].sort((a, b) => a - b);
  const byScope = new Map<string, Map<number, ScopePoint>>();
  for (const p of points) {
    if (!byScope.has(p.scope)) byScope.set(p.scope, new Map());
    byScope.get(p.scope)!.set(p.t, p);
  }
  type State = { last: ScopePoint | null; rx: number; tx: number };
  const state = new Map<string, State>([...byScope.keys()].map((s) => [s, { last: null, rx: 0, tx: 0 }]));
  return times.map((t) => {
    const out: SeriesPoint = { t, cpu: 0, memory: 0, memoryLimit: 0, netRx: null, netTx: null, disk: null, diskTotal: null };
    for (const [scope, samples] of byScope) {
      const st = state.get(scope)!;
      const p = samples.get(t);
      if (p) {
        // A counter only adds what it grew since the last sample; a reset (container restarted) adds nothing.
        const near = st.last && t - st.last.t <= (FILL + 1) * stepMs;
        if (near && p.netRx !== null && st.last!.netRx !== null && p.netRx >= st.last!.netRx) st.rx += p.netRx - st.last!.netRx;
        if (near && p.netTx !== null && st.last!.netTx !== null && p.netTx >= st.last!.netTx) st.tx += p.netTx - st.last!.netTx;
        st.last = p;
      }
      const use = p ?? (st.last && t - st.last.t <= FILL * stepMs ? st.last : null);
      if (!use) continue;
      out.cpu += use.cpu;
      out.memory += use.memory;
      out.memoryLimit += use.memoryLimit;
      out.disk = add(out.disk, use.disk);
      out.diskTotal = add(out.diskTotal, use.diskTotal);
      if (use.netRx !== null) out.netRx = (out.netRx ?? 0) + st.rx;
      if (use.netTx !== null) out.netTx = (out.netTx ?? 0) + st.tx;
    }
    return out;
  });
}
