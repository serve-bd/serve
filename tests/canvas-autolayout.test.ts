import { describe, expect, it } from "vitest";
import { autoLayout, CARD_H, CARD_W, FRAME_PAD, FRAME_TOP, type LayoutService } from "@/lib/canvas-layout";

const svc = (id: string, serverId: string, uses: string[] = []): LayoutService => ({ id, serverId, uses: uses.map((u) => ({ id: u })) });

function frames(services: LayoutService[], pos: ReturnType<typeof autoLayout>) {
  const out = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
  for (const server of new Set(services.map((s) => s.serverId))) {
    const ps = services.filter((s) => s.serverId === server).map((s) => pos[s.id]);
    out.set(server, {
      minX: Math.min(...ps.map((p) => p.x)) - FRAME_PAD,
      minY: Math.min(...ps.map((p) => p.y)) - FRAME_TOP,
      maxX: Math.max(...ps.map((p) => p.x + CARD_W)) + FRAME_PAD,
      maxY: Math.max(...ps.map((p) => p.y + CARD_H)) + FRAME_PAD,
    });
  }
  return [...out.values()];
}

/** Whether the straight line between two points crosses a rectangle (sampled). */
function crosses(a: { x: number; y: number }, b: { x: number; y: number }, r: { x: number; y: number }) {
  for (let t = 0.02; t < 0.98; t += 0.01) {
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > r.x && x < r.x + CARD_W && y > r.y && y < r.y + CARD_H) return true;
  }
  return false;
}

describe("project canvas auto layout", () => {
  it("keeps a line between servers clear of other cards and boxes apart", () => {
    const services = [svc("buraq", "ubuntu2", ["postgres"]), svc("mysql", "ubuntu2"), svc("mattermost", "local"), svc("postgres", "test")];
    const pos = autoLayout(services);
    const from = { x: pos.buraq.x + CARD_W, y: pos.buraq.y + CARD_H / 2 };
    const to = { x: pos.postgres.x, y: pos.postgres.y + CARD_H / 2 };
    expect(pos.postgres.x).toBeGreaterThan(pos.buraq.x);
    for (const other of ["mysql", "mattermost"]) expect(crosses(from, to, pos[other])).toBe(false);
    const boxes = frames(services, pos);
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1)) expect(a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY).toBe(false);
  });

  it("packs unrelated services of one server in rows of three", () => {
    const services = Array.from({ length: 7 }, (_, i) => svc(`s${i}`, "local"));
    const pos = autoLayout(services);
    const xs = new Set(Object.values(pos).map((p) => p.x));
    const ys = new Set(Object.values(pos).map((p) => p.y));
    expect(xs.size).toBeLessThanOrEqual(3);
    expect(ys.size).toBe(3);
    // No two cards on top of each other.
    const keys = Object.values(pos).map((p) => `${p.x},${p.y}`);
    expect(new Set(keys).size).toBe(7);
  });

  it("places users left of what they use on one server", () => {
    const pos = autoLayout([svc("web", "local", ["api"]), svc("api", "local", ["db"]), svc("db", "local")]);
    expect(pos.web.x).toBeLessThan(pos.api.x);
    expect(pos.api.x).toBeLessThan(pos.db.x);
  });
});
