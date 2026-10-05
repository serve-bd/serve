import { describe, expect, it } from "vitest";
import { counterRate } from "@/lib/counter-rate";
import { combineScopes, type ScopePoint } from "@/lib/metric-combine";

const STEP = 60_000;
const p = (scope: string, i: number, rx: number, memory = 100): ScopePoint => ({
  scope,
  t: i * STEP,
  cpu: 1,
  memory,
  memoryLimit: 1000,
  netRx: rx,
  netTx: rx,
  disk: null,
  diskTotal: null,
});

describe("one chart over every server of a service", () => {
  it("adds up the servers' CPU and memory", () => {
    const out = combineScopes([p("a", 0, 0), p("a@b", 0, 0, 50)], STEP);
    expect(out).toEqual([expect.objectContaining({ cpu: 2, memory: 150, memoryLimit: 2000 })]);
  });

  it("a server missing one bucket counts with its last value, not as a dip, and the network rate shows no spike", () => {
    // Each server sends 60 bytes a minute. b misses minute 2.
    const pts = [0, 1, 2, 3, 4].flatMap((i) => [p("a", i, i * 60), ...(i === 2 ? [] : [p("a@b", i, 1_000_000 + i * 60)])]);
    const out = combineScopes(pts, STEP);
    expect(out.map((o) => o.memory)).toEqual([200, 200, 200, 200, 200]);
    const rates = counterRate(out, "netRx").map((r) => r.v ?? 0);
    // The minute b missed shows its bytes a minute late (3 instead of 2, then 1), never b's whole counter.
    expect(Math.max(...rates)).toBeLessThanOrEqual(3.0001);
    expect(rates.reduce((a, b) => a + b, 0) * 60).toBeCloseTo(4 * 120);
    expect(rates.at(-1)).toBeCloseTo(2);
  });

  it("a server joining mid-window or a counter reset never shows as traffic", () => {
    const pts = [p("a", 0, 0), p("a", 1, 60), p("a@b", 1, 5_000_000), p("a", 2, 120), p("a@b", 2, 60), p("a", 3, 180), p("a@b", 3, 120)];
    const rates = counterRate(combineScopes(pts, STEP), "netRx").map((r) => r.v);
    for (const v of rates) if (v !== null) expect(v).toBeLessThanOrEqual(2.0001);
  });

  it("a server gone for longer stops counting", () => {
    const pts = [p("a", 0, 0), p("a@b", 0, 0), p("a", 1, 0), p("a", 2, 0), p("a", 3, 0), p("a", 4, 0)];
    expect(combineScopes(pts, STEP).map((o) => o.memory)).toEqual([200, 200, 200, 100, 100]);
  });
});
