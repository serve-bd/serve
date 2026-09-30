import { Graph, layout } from "@dagrejs/dagre";

/** Size of a service card on the project canvas, and the room around a server's cards. */
export const CARD_W = 264;
export const CARD_H = 104;
export const FRAME_PAD = 24;
export const FRAME_TOP = 40;

export type Pos = { x: number; y: number };

/** What the layout needs of a service. */
export type LayoutService = { id: string; serverId: string; uses: { id: string }[] };

/** Places for one group of services that use each other: users left of what they use. */
function layoutComponent(list: LayoutService[], ids: Set<string>): { pos: Record<string, Pos>; w: number; h: number } {
  const g = new Graph();
  g.setGraph({ rankdir: "LR", nodesep: 32, ranksep: 110, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const s of list) g.setNode(s.id, { width: CARD_W, height: CARD_H });
  for (const s of list) for (const u of s.uses) if (ids.has(u.id) && g.hasNode(u.id)) g.setEdge(s.id, u.id);
  layout(g);
  const pos: Record<string, Pos> = {};
  let w = 0;
  let h = 0;
  for (const s of list) {
    const n = g.node(s.id);
    pos[s.id] = { x: Math.round(n.x - CARD_W / 2), y: Math.round(n.y - CARD_H / 2) };
    w = Math.max(w, pos[s.id].x + CARD_W);
    h = Math.max(h, pos[s.id].y + CARD_H);
  }
  return { pos, w, h };
}

/**
 * Automatic places. Per server (a column of its own when there are several), services that use
 * each other are laid out together, and the groups are packed in rows so unrelated services sit
 * side by side instead of in one long column.
 */
export function autoLayout(services: LayoutService[]): Record<string, Pos> {
  const GAP = 48;
  const ROW_W = 3 * CARD_W + 2 * GAP;
  // Servers whose services use services elsewhere go left, so lines run left to right.
  const serverOf = new Map(services.map((s) => [s.id, s.serverId]));
  const score = new Map<string, number>();
  for (const s of services)
    for (const u of s.uses) {
      const to = serverOf.get(u.id);
      if (!to || to === s.serverId) continue;
      score.set(s.serverId, (score.get(s.serverId) ?? 0) + 1);
      score.set(to, (score.get(to) ?? 0) - 1);
    }
  const servers = [...new Set(services.map((s) => s.serverId))].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0));
  const out: Record<string, Pos> = {};
  let offsetX = 0;
  for (const serverId of servers) {
    const list = services.filter((s) => s.serverId === serverId);
    const ids = new Set(list.map((s) => s.id));
    // Connected groups on this server (uses in either direction).
    const seen = new Set<string>();
    const groups: LayoutService[][] = [];
    for (const start of list) {
      if (seen.has(start.id)) continue;
      const group: LayoutService[] = [];
      const queue = [start];
      seen.add(start.id);
      while (queue.length) {
        const s = queue.shift()!;
        group.push(s);
        for (const other of list)
          if (!seen.has(other.id) && (s.uses.some((u) => u.id === other.id) || other.uses.some((u) => u.id === s.id))) {
            seen.add(other.id);
            queue.push(other);
          }
      }
      groups.push(group);
    }
    // Bigger groups first, then pack left to right, wrapping into rows.
    groups.sort((a, b) => b.length - a.length);
    let x = 0;
    let y = 0;
    let rowH = 0;
    let width = 0;
    for (const group of groups) {
      const { pos, w, h } = layoutComponent(group, ids);
      if (x > 0 && x + w > ROW_W) {
        x = 0;
        y += rowH + GAP;
        rowH = 0;
      }
      for (const [id, p] of Object.entries(pos)) out[id] = { x: offsetX + x + p.x, y: y + p.y };
      x += w + GAP;
      rowH = Math.max(rowH, h);
      width = Math.max(width, x - GAP);
    }
    offsetX += width + GAP + 2 * FRAME_PAD + 40;
  }
  return out;
}
