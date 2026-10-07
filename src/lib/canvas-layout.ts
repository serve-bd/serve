import { Graph, layout } from "@dagrejs/dagre";

/** Size of a service card on the project canvas, and the room around a server's cards. */
export const CARD_W = 264;
export const CARD_H = 104;
export const FRAME_PAD = 24;
export const FRAME_TOP = 40;
/** The volume strip under a card: a line per volume, at most three and a "+N more" line. */
export const VOLUME_LINE_H = 18;
export const VOLUME_LINES = 3;

/** Height of a card with this many volumes. */
export function cardHeight(volumes: number) {
  const lines = volumes > VOLUME_LINES ? VOLUME_LINES + 1 : volumes;
  return CARD_H + (lines ? lines * VOLUME_LINE_H + 12 : 0);
}

export type Pos = { x: number; y: number };

/** What the layout needs of a service. `h`: its card's height when not CARD_H. */
export type LayoutService = { id: string; serverId: string; uses: { id: string }[]; h?: number };

type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** The box a server draws around its cards (same padding as the canvas). */
function frameOf(ids: string[], pos: Record<string, Pos>, h: (id: string) => number): Box {
  return {
    minX: Math.min(...ids.map((id) => pos[id].x)) - FRAME_PAD,
    minY: Math.min(...ids.map((id) => pos[id].y)) - FRAME_TOP,
    maxX: Math.max(...ids.map((id) => pos[id].x + CARD_W)) + FRAME_PAD,
    maxY: Math.max(...ids.map((id) => pos[id].y + h(id))) + FRAME_PAD,
  };
}

const overlaps = (a: Box, b: Box, gap: number) => a.minX < b.maxX + gap && b.minX < a.maxX + gap && a.minY < b.maxY + gap && b.minY < a.maxY + gap;

/**
 * Automatic places for the whole project at once: one graph, each server a group, users left of
 * what they use. Lines then run left to right between neighbouring columns instead of across
 * unrelated cards and servers. Services that use nothing are chained in rows of three inside their
 * server (invisible links), so a server with many of them stays compact.
 */
export function autoLayout(services: LayoutService[]): Record<string, Pos> {
  if (!services.length) return {};
  const g = new Graph({ compound: true });
  g.setGraph({ rankdir: "LR", nodesep: 56, ranksep: 180, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(services.map((s) => s.id));
  const heights = new Map(services.map((s) => [s.id, s.h ?? CARD_H]));
  const h = (id: string) => heights.get(id) ?? CARD_H;
  const servers = [...new Set(services.map((s) => s.serverId))];
  for (const server of servers) g.setNode(`server:${server}`, {});
  for (const s of services) {
    g.setNode(s.id, { width: CARD_W, height: h(s.id) });
    g.setParent(s.id, `server:${s.serverId}`);
  }
  const linked = new Set<string>();
  for (const s of services)
    for (const u of s.uses)
      if (ids.has(u.id) && u.id !== s.id) {
        g.setEdge(s.id, u.id);
        linked.add(s.id);
        linked.add(u.id);
      }
  // Services that use nothing and are used by nothing: one grid block per server, placed by the
  // graph as a single node and filled in afterwards.
  const COLS = 3;
  const CELL_GAP = 32;
  const blocks = new Map<string, string[]>();
  // Each row of a block is as tall as its tallest card.
  const rowHeights = (alone: string[]) => Array.from({ length: Math.ceil(alone.length / COLS) }, (_, r) => Math.max(...alone.slice(r * COLS, r * COLS + COLS).map(h)));
  for (const server of servers) {
    const alone = services.filter((s) => s.serverId === server && !linked.has(s.id)).map((s) => s.id);
    if (!alone.length) continue;
    blocks.set(server, alone);
    for (const id of alone) g.removeNode(id);
    const cols = Math.min(COLS, alone.length);
    const rows = rowHeights(alone);
    g.setNode(`block:${server}`, { width: cols * CARD_W + (cols - 1) * CELL_GAP, height: rows.reduce((a, b) => a + b, 0) + (rows.length - 1) * CELL_GAP });
    g.setParent(`block:${server}`, `server:${server}`);
  }
  layout(g);

  const pos: Record<string, Pos> = {};
  for (const s of services) {
    if (!linked.has(s.id)) continue;
    const n = g.node(s.id);
    pos[s.id] = { x: Math.round(n.x - CARD_W / 2), y: Math.round(n.y - h(s.id) / 2) };
  }
  for (const [server, alone] of blocks) {
    const n = g.node(`block:${server}`);
    const left = n.x - n.width / 2;
    const rows = rowHeights(alone);
    const tops = rows.map((_, r) => n.y - n.height / 2 + rows.slice(0, r).reduce((a, b) => a + b + CELL_GAP, 0));
    alone.forEach((id, i) => {
      pos[id] = { x: Math.round(left + (i % COLS) * (CARD_W + CELL_GAP)), y: Math.round(tops[Math.floor(i / COLS)]) };
    });
  }

  // Server boxes have more padding than the graph leaves between groups: move a box down until
  // it no longer touches one placed before it (left to right, top to bottom).
  const GAP = 32;
  const members = new Map(servers.map((server) => [server, services.filter((s) => s.serverId === server).map((s) => s.id)]));
  const order = [...servers].sort((a, b) => {
    const fa = frameOf(members.get(a)!, pos, h);
    const fb = frameOf(members.get(b)!, pos, h);
    return fa.minX - fb.minX || fa.minY - fb.minY;
  });
  const placed: Box[] = [];
  for (const server of order) {
    const list = members.get(server)!;
    for (let guard = 0; guard < 50; guard++) {
      const box = frameOf(list, pos, h);
      const hit = placed.find((p) => overlaps(box, p, GAP));
      if (!hit) break;
      const dy = hit.maxY + GAP - box.minY;
      for (const id of list) pos[id] = { x: pos[id].x, y: pos[id].y + dy };
    }
    placed.push(frameOf(list, pos, h));
  }

  // Start at the origin.
  const minX = Math.min(...Object.values(pos).map((p) => p.x));
  const minY = Math.min(...Object.values(pos).map((p) => p.y));
  for (const id of Object.keys(pos)) pos[id] = { x: pos[id].x - minX, y: pos[id].y - minY };
  return pos;
}

/**
 * Places for cards of data kept from deleted services: rows of three under everything else on the
 * canvas (wherever services were moved), so they never cover a service. `cards`: where the
 * services' cards are now, with their heights.
 */
export function keptLayout(ids: string[], cards: (Pos & { h: number })[]): Record<string, Pos> {
  const COLS = 3;
  const GAP = 32;
  const left = cards.length ? Math.min(...cards.map((c) => c.x)) : 0;
  // Under the services' server boxes too, which reach FRAME_PAD below their lowest card.
  const top = cards.length ? Math.max(...cards.map((c) => c.y + c.h)) + FRAME_PAD + 56 : 0;
  return Object.fromEntries(ids.map((id, i) => [id, { x: left + (i % COLS) * (CARD_W + GAP), y: top + Math.floor(i / COLS) * (CARD_H + GAP) }]));
}

/** Private networks canvas: network pills and server cards. */
export const NET_W = 200;
export const NET_H = 44;
export const SERVER_W = 232;
export const SERVER_H = 64;

export type NetworkLayoutInput = { networks: { id: string; servers: string[] }[]; servers: string[] };

/**
 * Networks on top, their servers below (a server in two networks sits between them); servers in
 * no network in a row underneath. Keys are node ids: "network:<id>" and "server:<id>".
 */
export function networkLayout(input: NetworkLayoutInput): Record<string, Pos> {
  const g = new Graph();
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 90, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const known = new Set(input.servers);
  const placed = new Set<string>();
  for (const n of input.networks) g.setNode(`network:${n.id}`, { width: NET_W, height: NET_H });
  for (const n of input.networks)
    for (const s of n.servers) {
      if (!known.has(s)) continue;
      if (!placed.has(s)) g.setNode(`server:${s}`, { width: SERVER_W, height: SERVER_H });
      placed.add(s);
      g.setEdge(`network:${n.id}`, `server:${s}`);
    }
  const out: Record<string, Pos> = {};
  let bottom = 0;
  let width = 0;
  if (input.networks.length) {
    layout(g);
    for (const id of g.nodes()) {
      const n = g.node(id);
      out[id] = { x: Math.round(n.x - n.width / 2), y: Math.round(n.y - n.height / 2) };
      bottom = Math.max(bottom, n.y + n.height / 2);
      width = Math.max(width, n.x + n.width / 2);
    }
  }
  // Servers outside every network: a row below, wrapping at the width above (at least four cards).
  const rest = input.servers.filter((s) => !placed.has(s));
  const perRow = Math.max(4, Math.floor((width + 40) / (SERVER_W + 40)));
  rest.forEach((s, i) => {
    out[`server:${s}`] = { x: (i % perRow) * (SERVER_W + 40), y: Math.round(bottom + (bottom ? 90 : 0) + Math.floor(i / perRow) * (SERVER_H + 32)) };
  });
  return out;
}
