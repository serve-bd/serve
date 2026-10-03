"use client";

import "@xyflow/react/dist/base.css";
import * as React from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  type EdgeTypes,
  getBezierPath,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  ViewportPortal,
} from "@xyflow/react";
import { AlertTriangle, ArrowUpRight, LayoutGrid, Maximize2, Minimize2, Minus, Plus, Scan, Server as ServerIcon } from "lucide-react";
import { useRouter } from "@/hooks/use-router";
import { engineColors, ServiceIcon } from "@/components/service-icon";
import { StatusLabel } from "@/components/ui/status";
import { WaitingMark } from "./waiting-mark";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { resetCanvasLayout, saveCanvasPositions } from "@/server/actions/projects";
import type { ServiceCardData } from "@/server/project-data";
import { cn } from "@/lib/utils";
import { useCanvasFullscreen } from "@/hooks/use-canvas-fullscreen";
import { autoLayout, CARD_H, CARD_W, FRAME_PAD, FRAME_TOP, type Pos } from "@/lib/canvas-layout";

type ServiceNode = Node<{ s: ServiceCardData; projectId: string }, "service">;

const sourceKind = (s: ServiceCardData) => (s.source && s.type === "app" ? (s.source.includes("/") && !s.source.includes(":") ? "git" : "image") : null);

/**
 * A box around each server's services, sized from where they sit now; drawn behind the cards.
 * Dragging a box moves all of its cards together.
 */
function ServerFrames({
  nodes,
  canManage,
  setNodes,
  onMoved,
  stored,
}: {
  nodes: ServiceNode[];
  canManage: boolean;
  setNodes: React.Dispatch<React.SetStateAction<ServiceNode[]>>;
  onMoved: (positions: Record<string, Pos>) => void;
  /** Places saved before. */
  stored: Record<string, Pos>;
}) {
  const flow = useReactFlow();
  const drag = React.useRef<{ ids: Set<string>; x: number; y: number; zoom: number; start: Map<string, Pos>; moved: boolean } | null>(null);
  const byServer = new Map<string, ServiceNode[]>();
  for (const n of nodes) byServer.set(n.data.s.serverId, [...(byServer.get(n.data.s.serverId) ?? []), n]);
  // A drag the browser cut off: the cards go back to where they started, nothing is saved.
  const cancel = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) setNodes((all) => all.map((n) => (d.start.has(n.id) ? { ...n, position: d.start.get(n.id)! } : n)));
  };
  if (byServer.size < 2) return null;
  return (
    <ViewportPortal>
      {[...byServer].map(([serverId, list]) => {
        const minX = Math.min(...list.map((n) => n.position.x)) - FRAME_PAD;
        const minY = Math.min(...list.map((n) => n.position.y)) - FRAME_TOP;
        const maxX = Math.max(...list.map((n) => n.position.x + CARD_W)) + FRAME_PAD;
        const maxY = Math.max(...list.map((n) => n.position.y + CARD_H)) + FRAME_PAD;
        return (
          <div
            key={serverId}
            className={cn(
              "nopan absolute rounded-3xl border border-dashed border-line-strong/70 bg-surface-2/30",
              canManage ? "pointer-events-auto cursor-grab active:cursor-grabbing" : "pointer-events-none",
            )}
            // touch-action: the browser must not take a touch drag over as a scroll.
            style={{ transform: `translate(${minX}px, ${minY}px)`, width: maxX - minX, height: maxY - minY, touchAction: "none" }}
            title={canManage ? "Drag to move this server's services" : undefined}
            onPointerDown={(e) => {
              if (!canManage || e.button !== 0) return;
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = {
                ids: new Set(list.map((n) => n.id)),
                x: e.clientX,
                y: e.clientY,
                zoom: flow.getZoom(),
                start: new Map(list.map((n) => [n.id, n.position])),
                moved: false,
              };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = (e.clientX - d.x) / d.zoom;
              const dy = (e.clientY - d.y) / d.zoom;
              if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
              d.moved = true;
              setNodes((all) => all.map((n) => (d.ids.has(n.id) ? { ...n, position: { x: Math.round(d.start.get(n.id)!.x + dx), y: Math.round(d.start.get(n.id)!.y + dy) } } : n)));
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = null;
              e.currentTarget.releasePointerCapture(e.pointerId);
              if (!d?.moved) return;
              const dx = Math.round((e.clientX - d.x) / d.zoom);
              const dy = Math.round((e.clientY - d.y) / d.zoom);
              const moved = Object.fromEntries([...d.start].map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]));
              setNodes((all) => all.map((n) => (moved[n.id] ? { ...n, position: moved[n.id] } : n)));
              // Cards placed automatically keep their place from now on, so they never jump into the moved box.
              // Cards saved before are left out: someone else may have moved them since.
              onMoved({ ...Object.fromEntries(nodes.filter((n) => !stored[n.id]).map((n) => [n.id, n.position])), ...moved });
            }}
            onPointerCancel={() => cancel()}
            onLostPointerCapture={() => cancel()}
          >
            <span className="flex items-center gap-1.5 px-4 pt-3 text-[11px] font-medium tracking-wide text-muted uppercase">
              <ServerIcon className="size-3" /> {list[0].data.s.serverName || "Server"}
            </span>
          </div>
        );
      })}
    </ViewportPortal>
  );
}

function ServiceCardNode({ data, selected }: NodeProps<ServiceNode>) {
  const { s } = data;
  const issue = s.issues[0];
  return (
    <div
      style={{ width: CARD_W, height: CARD_H }}
      className={cn(
        "group flex cursor-pointer flex-col justify-between rounded-2xl border bg-surface shadow-sm transition-[border-color,box-shadow] duration-150 hover:shadow-md",
        issue?.tone === "bad" ? "border-bad/50" : issue?.tone === "warn" ? "border-warn/50" : selected ? "border-accent" : "border-line hover:border-line-strong",
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !min-h-0 !min-w-0 !border-0 !bg-transparent" isConnectable={false} />
      <div className="flex items-start gap-3 px-3.5 pt-3">
        <ServiceIcon type={s.type} engine={s.engine} icon={s.icon} source={sourceKind(s)} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-fg">{s.name}</span>
          </span>
          <span className="truncate text-[11px] text-muted">{s.domain ?? s.source ?? (s.engine ? s.engine : s.type)}</span>
        </div>
        {s.domain && (
          <a
            href={`${s.domainHttps ? "https" : "http"}://${s.domain}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="nodrag flex-none rounded-md p-1 text-faint transition-colors hover:bg-hover hover:text-accent"
            aria-label={`Open ${s.domain}`}
          >
            <ArrowUpRight className="size-3.5" />
          </a>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line px-3.5 py-2">
        <StatusLabel status={s.status} className="text-[11px]" />
        {s.lastDeploy?.status === "waiting" ? (
          <WaitingMark className="text-[11px]" />
        ) : (
          issue && (
            <span className={cn("flex min-w-0 items-center gap-1 text-[11px]", issue.tone === "bad" ? "text-bad" : "text-warn")} title={s.issues.map((i) => i.text).join("\n")}>
              <AlertTriangle className="size-3 flex-none" />
              <span className="truncate">{s.issues.length > 1 ? `${s.issues.length} issues` : "Needs attention"}</span>
            </span>
          )
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!size-2 !min-h-0 !min-w-0 !border-0 !bg-transparent" isConnectable={false} />
    </div>
  );
}

const nodeTypes: NodeTypes = { service: ServiceCardNode };

type UseEdge = Edge<{ variables: string[]; kind: "local" | "private" | "broken"; color: string }, "uses">;

/** Colors for lines to services without an engine color, picked by the service so a line keeps its color. */
const LINE_PALETTE = ["#0ea5e9", "#a855f7", "#f59e0b", "#14b8a6", "#ec4899", "#84cc16", "#6366f1", "#f97316"];

/** A line takes the color of the service it goes to (a database its engine's), lifted a little so dark ones show on the canvas. */
function lineColor(target: ServiceCardData) {
  const base = (target.engine && engineColors[target.engine]) || LINE_PALETTE[[...target.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % LINE_PALETTE.length];
  return `color-mix(in oklab, ${base} 78%, var(--fg))`;
}

/** A use: the line, and a small pill with the variables it goes through. */
function UseEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style }: EdgeProps<UseEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const vars = data?.variables ?? [];
  const text = vars.length > 2 ? `${vars.slice(0, 2).join(", ")} +${vars.length - 2}` : vars.join(", ");
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            ...(data?.kind === "local" ? { color: data.color, borderColor: `color-mix(in oklab, ${data.color} 45%, transparent)` } : {}),
          }}
          title={data?.kind === "broken" ? `${vars.join(", ")}: the servers share no private network, so this name does not resolve.` : vars.join(", ")}
          className={cn(
            "nodrag nopan pointer-events-auto absolute flex max-w-[180px] items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-4 shadow-sm",
            data?.kind === "broken"
              ? "border-bad/40 bg-[color-mix(in_oklab,var(--bad)_14%,var(--surface))] text-bad"
              : data?.kind === "private"
                ? "border-accent/40 bg-surface text-accent-strong"
                : "border-line bg-surface text-muted",
          )}
        >
          {data?.kind === "broken" && <AlertTriangle className="size-3 flex-none" />}
          <span className="truncate">{text}</span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes: EdgeTypes = { uses: UseEdgeView };

function edgesOf(services: ServiceCardData[]): UseEdge[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const edges: UseEdge[] = [];
  for (const s of services)
    for (const u of s.uses) {
      const target = byId.get(u.id);
      if (!target) continue;
      const kind = u.broken ? "broken" : s.serverId !== target.serverId && u.private ? "private" : "local";
      const color = kind === "broken" ? "var(--bad)" : kind === "private" ? "var(--accent)" : lineColor(target);
      edges.push({
        id: `${s.id}->${u.id}`,
        type: "uses",
        source: s.id,
        target: u.id,
        animated: kind === "private",
        data: { variables: u.variables, kind, color },
        style: { stroke: color, strokeWidth: 1.5, strokeDasharray: kind === "broken" ? "5 4" : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      });
    }
  return edges;
}

type Props = {
  projectId: string;
  environmentId: string;
  services: ServiceCardData[];
  saved: Record<string, Pos>;
  canManage: boolean;
};

function Canvas({ projectId, environmentId, services, saved, canManage }: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const flow = useReactFlow();
  const fs = useCanvasFullscreen(flow);
  // Laid out again only when services or their uses change, not on every status refresh.
  const shapeKey = JSON.stringify(services.map((s) => ({ id: s.id, serverId: s.serverId, uses: s.uses.map((u) => ({ id: u.id })) })));
  const auto = React.useMemo(() => autoLayout(JSON.parse(shapeKey)), [shapeKey]);
  // Where each service sits: dragged here, saved before, or placed automatically.
  // A refresh hands over an equal but new object: only a real change of the saved places counts.
  const savedKey = JSON.stringify(saved);
  const stored = React.useMemo(() => JSON.parse(savedKey) as Record<string, Pos>, [savedKey]);
  const place = React.useCallback((s: ServiceCardData, current?: Pos): Pos => current ?? stored[s.id] ?? auto[s.id], [stored, auto]);
  const build = React.useCallback(
    (prev: ServiceNode[]): ServiceNode[] =>
      services.map((s) => {
        // New data keeps what React Flow knows about a card (its place, size, selection).
        const old = prev.find((n) => n.id === s.id);
        return { ...old, id: s.id, type: "service" as const, position: place(s, old?.position), data: { s, projectId }, draggable: canManage };
      }),
    [services, place, projectId, canManage],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<ServiceNode>(build([]));
  // New data (status, a service added or removed) keeps what is already on the canvas where it is.
  React.useEffect(() => {
    setNodes((prev) => build(prev));
  }, [build, setNodes]);
  const edges = React.useMemo(() => edgesOf(services), [services]);

  // Refreshed after saving, so the page cache (used by Back) knows the new places.
  const save = useAction((positions: Record<string, Pos>) => saveCanvasPositions(environmentId, positions));
  const reset = useAction(() => resetCanvasLayout(environmentId), {
    onSuccess: () => {
      setNodes(services.map((s) => ({ id: s.id, type: "service", position: auto[s.id], data: { s, projectId }, draggable: canManage })));
      requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 300 }));
    },
  });

  return (
    <div ref={fs.ref} className={cn("serve-canvas", fs.className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_e, node) => {
          router.push(`/projects/${projectId}/services/${node.id}`);
        }}
        onNodeDragStop={(_e, _node, dragged) => {
          if (!canManage) return;
          const moved = Object.fromEntries(dragged.map((n) => [n.id, n.position]));
          if (Object.keys(moved).length) void save.run(moved);
        }}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--line-strong)" />
        <ServerFrames nodes={nodes} canManage={canManage} setNodes={setNodes} stored={stored} onMoved={(moved) => void save.run(moved)} />
      </ReactFlow>
      <div className="absolute bottom-4 left-4 flex items-center gap-1 rounded-xl border border-line bg-surface/95 p-1 shadow-sm backdrop-blur">
        <ToolButton label="Zoom out" onClick={() => void flow.zoomOut({ duration: 200 })}>
          <Minus />
        </ToolButton>
        <ToolButton label="Zoom in" onClick={() => void flow.zoomIn({ duration: 200 })}>
          <Plus />
        </ToolButton>
        <ToolButton label="Fit to screen" onClick={() => void flow.fitView({ padding: 0.2, duration: 300, maxZoom: 1 })}>
          <Scan />
        </ToolButton>
        <ToolButton label={fs.full ? "Exit full screen" : "Full screen"} onClick={fs.toggle}>
          {fs.full ? <Minimize2 /> : <Maximize2 />}
        </ToolButton>
        {canManage && (
          <ToolButton
            label="Arrange automatically"
            onClick={async () => {
              if (
                await confirm({
                  title: "Arrange automatically?",
                  description: "Services go back to automatic places for everyone. Moved cards lose their places.",
                  confirmLabel: "Arrange",
                })
              )
                void reset.run();
            }}
          >
            <LayoutGrid />
          </ToolButton>
        )}
      </div>
      <Legend services={services} />
    </div>
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg [&_svg]:size-4"
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** What the lines mean, only for the kinds on this canvas. */
function Legend({ services }: { services: ServiceCardData[] }) {
  const byId = new Map(services.map((s) => [s.id, s]));
  const uses = services.flatMap((s) => s.uses.map((u) => ({ u, across: s.serverId !== byId.get(u.id)?.serverId && u.private })));
  if (!uses.length) return null;
  const kinds = [
    { on: uses.some((x) => !x.across && !x.u.broken), color: "var(--line-strong)", dash: false, text: "Uses (in the color of the service used)" },
    { on: uses.some((x) => x.across && !x.u.broken), color: "var(--accent)", dash: false, text: "Over the private network" },
    { on: uses.some((x) => x.u.broken), color: "var(--bad)", dash: true, text: "Not reachable: no shared network" },
  ].filter((k) => k.on);
  return (
    <div className="absolute right-4 bottom-4 hidden flex-col gap-1.5 rounded-xl border border-line bg-surface/95 px-3 py-2.5 text-[11px] text-muted shadow-sm backdrop-blur sm:flex">
      {kinds.map((k) => (
        <span key={k.text} className="flex items-center gap-2">
          <svg width="22" height="6" aria-hidden>
            <line x1="0" y1="3" x2="22" y2="3" stroke={k.color} strokeWidth="1.5" strokeDasharray={k.dash ? "4 3" : undefined} />
          </svg>
          {k.text}
        </span>
      ))}
    </div>
  );
}

export function ProjectCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
