"use client";

import "@xyflow/react/dist/base.css";
import * as React from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  type EdgeTypes,
  getBezierPath,
  Handle,
  type Node,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { LayoutGrid, Maximize, Minus, Network, Plus, Server as ServerIcon, X } from "lucide-react";
import { useRouter } from "@/hooks/use-router";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { useMeshConfirm } from "@/components/mesh-confirm";
import { useAction } from "@/hooks/use-action";
import { resetNetworkCanvas, saveNetworkCanvas, setNetworkMember } from "@/server/actions/mesh";
import type { MeshNetworkView } from "@/server/mesh";
import { type NetworkLayoutInput, networkLayout, NET_H, NET_W, SERVER_H, SERVER_W } from "@/lib/canvas-layout";
import { cn } from "@/lib/utils";

type Pos = { x: number; y: number };
export type CanvasServer = {
  id: string;
  name: string;
  joined: boolean;
  state: "starting" | "ready" | "error" | "off" | null;
  message: string | null;
  address: string | null;
  nat: boolean;
};
type Networks = Omit<MeshNetworkView, "member">[];

/** One colour per network, in order; readable on light and dark. */
const COLORS = ["#14b8a6", "#6366f1", "#f59e0b", "#ec4899", "#22c55e", "#0ea5e9", "#a855f7", "#ef4444"];

type NetworkNode = Node<{ name: string; color: string; count: number }, "network">;
type ServerNode = Node<{ server: CanvasServer; networks: number }, "server">;
type MemberEdge = Edge<{ networkName: string; serverName: string; color: string; onRemove: () => void }, "member">;

function NetworkNodeView({ data }: NodeProps<NetworkNode>) {
  return (
    <div
      style={{ width: NET_W, height: NET_H, borderColor: data.color, background: `color-mix(in oklab, ${data.color} 14%, var(--surface))` }}
      className="flex items-center gap-2 rounded-full border-2 px-4 shadow-sm"
    >
      <Network className="size-4 flex-none" style={{ color: data.color }} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">{data.name}</span>
      <span className="flex-none text-[11px] text-muted tabular-nums">{data.count}</span>
      <Handle type="source" position={Position.Bottom} className="!size-2 !min-h-0 !min-w-0 !border-0 !bg-transparent" isConnectable={false} />
    </div>
  );
}

function ServerNodeView({ data, selected }: NodeProps<ServerNode>) {
  const s = data.server;
  const tone = !s.joined
    ? { dot: "bg-faint", text: "Not joined" }
    : s.state === "error"
      ? { dot: "bg-bad", text: "Needs attention" }
      : s.state === "ready"
        ? { dot: "bg-ok", text: data.networks ? "Ready" : "In no network" }
        : { dot: "animate-led bg-warn", text: "Starting…" };
  return (
    <div
      style={{ width: SERVER_W, height: SERVER_H }}
      className={cn(
        "flex cursor-pointer flex-col justify-center gap-1 rounded-2xl border bg-surface px-3.5 shadow-sm transition-[border-color,box-shadow] hover:shadow-md",
        !s.joined && "border-dashed opacity-70",
        s.state === "error" ? "border-bad/50" : selected ? "border-accent" : "border-line hover:border-line-strong",
      )}
      title={s.message ?? undefined}
    >
      <Handle type="target" position={Position.Top} className="!size-2 !min-h-0 !min-w-0 !border-0 !bg-transparent" isConnectable={false} />
      <span className="flex items-center gap-2">
        <ServerIcon className="size-3.5 flex-none text-muted" />
        <span className="truncate text-[13px] font-semibold text-fg">{s.name}</span>
      </span>
      <span className="flex items-center gap-1.5 text-[11px] text-muted">
        <span className={cn("size-1.5 flex-none rounded-full", tone.dot)} />
        <span className="truncate">
          {tone.text}
          {s.address && <span className="font-mono"> · {s.address}</span>}
          {s.nat && " · no public address"}
        </span>
      </span>
    </div>
  );
}

function MemberEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<MemberEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: data?.color, strokeWidth: selected ? 2.5 : 1.75, opacity: selected ? 1 : 0.8 }} />
      <EdgeLabelRenderer>
        <button
          type="button"
          aria-label={`Remove ${data?.serverName} from ${data?.networkName}`}
          onClick={(e) => {
            e.stopPropagation();
            data?.onRemove();
          }}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          className="nodrag nopan pointer-events-auto absolute flex size-5 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-sm transition-colors hover:border-bad/50 hover:text-bad"
        >
          <X className="size-3" />
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeId = (kind: "network" | "server", id: string) => `${kind}:${id}`;

const nodeTypes: NodeTypes = { network: NetworkNodeView, server: ServerNodeView };
const edgeTypes: EdgeTypes = { member: MemberEdgeView };

type Props = { networks: Networks; servers: CanvasServer[]; saved: Record<string, Pos> };

function Canvas({ networks, servers, saved }: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const meshConfirm = useMeshConfirm();
  const flow = useReactFlow();
  const colorOf = React.useMemo(() => new Map(networks.map((n, i) => [n.id, COLORS[i % COLORS.length]])), [networks]);
  const input: NetworkLayoutInput = React.useMemo(
    () => ({ networks: networks.map((n) => ({ id: n.id, servers: n.servers.map((s) => s.id) })), servers: servers.map((s) => s.id) }),
    [networks, servers],
  );
  const auto = React.useMemo(() => networkLayout(input), [input]);
  const build = React.useCallback(
    (prev: Node[]): Node[] => {
      const at = (id: string) => prev.find((n) => n.id === id)?.position ?? saved[id] ?? auto[id];
      return [
        ...networks.map(
          (n): NetworkNode => ({
            id: nodeId("network", n.id),
            type: "network",
            position: at(nodeId("network", n.id)),
            data: { name: n.name, color: colorOf.get(n.id)!, count: n.servers.length },
          }),
        ),
        ...servers.map(
          (s): ServerNode => ({
            id: nodeId("server", s.id),
            type: "server",
            position: at(nodeId("server", s.id)),
            data: { server: s, networks: networks.filter((n) => n.servers.some((m) => m.id === s.id)).length },
          }),
        ),
      ];
    },
    [networks, servers, saved, auto, colorOf],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(build([]));
  const dragFrom = React.useRef<{ id: string; position: Pos } | null>(null);
  React.useEffect(() => {
    setNodes((prev) => build(prev));
  }, [build, setNodes]);

  const member = useAction((networkId: string, serverId: string, on: boolean) => setNetworkMember(networkId, serverId, on), {
    success: "Saved. Servers pick up the change within seconds.",
  });
  const save = useAction((positions: Record<string, Pos>) => saveNetworkCanvas(positions), { refresh: false });
  const reset = useAction(() => resetNetworkCanvas(), {
    success: "Layout reset",
    onSuccess: () => {
      setNodes((prev) => prev.map((n) => ({ ...n, position: auto[n.id] ?? n.position })));
      requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 300, maxZoom: 1 }));
    },
  });

  const edges: MemberEdge[] = React.useMemo(
    () =>
      networks.flatMap((n) =>
        n.servers.map((s) => ({
          id: `${n.id}|${s.id}`,
          type: "member" as const,
          source: nodeId("network", n.id),
          target: nodeId("server", s.id),
          data: {
            networkName: n.name,
            serverName: s.name,
            color: colorOf.get(n.id)!,
            onRemove: async () => {
              const others = n.servers.filter((x) => x.id !== s.id);
              if (
                await meshConfirm(
                  { kind: "remove", networkId: n.id, serverId: s.id },
                  {
                    title: `Remove ${s.name} from ${n.name}?`,
                    description: others.length
                      ? `${s.name} stops reaching ${others.map((x) => x.name).join(", ")} through ${n.name}. Servers that share another network keep that link.`
                      : `${s.name} is the only server in ${n.name}.`,
                    confirmLabel: "Remove",
                  },
                )
              )
                void member.run(n.id, s.id, false);
            },
          },
        })),
      ),
    [networks, colorOf, meshConfirm, member],
  );

  return (
    <div className="serve-canvas relative size-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_e, node) => {
          if (node.type === "server") router.push(`/servers/${node.id.slice("server:".length)}/network`);
        }}
        onNodeDragStart={(_e, node) => {
          dragFrom.current = { id: node.id, position: node.position };
        }}
        onNodeDragStop={(_e, node, dragged) => {
          const from = dragFrom.current?.id === node.id ? dragFrom.current.position : null;
          dragFrom.current = null;
          const target = node.type === "server" ? flow.getIntersectingNodes(node).find((n) => n.type === "network") : undefined;
          if (!target || !from) {
            void save.run(Object.fromEntries(dragged.map((n) => [n.id, n.position])));
            return;
          }
          // Dropped on a network: it goes in (or not), and the card slides back to where it was.
          setNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, position: from } : n)));
          const serverId = node.id.slice("server:".length);
          const networkId = target.id.slice("network:".length);
          const network = networks.find((n) => n.id === networkId);
          const server = servers.find((s) => s.id === serverId);
          if (!network || !server || network.servers.some((s) => s.id === serverId)) return;
          if (!server.joined) {
            toast.error(`${server.name} has not joined the private network`, "Join it from its Private network page first.");
            return;
          }
          void member.run(networkId, serverId, true);
        }}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--line-strong)" />
      </ReactFlow>
      <div className="absolute bottom-4 left-4 flex items-center gap-1 rounded-xl border border-line bg-surface/95 p-1 shadow-sm backdrop-blur">
        <ToolButton label="Zoom out" onClick={() => void flow.zoomOut({ duration: 200 })}>
          <Minus />
        </ToolButton>
        <ToolButton label="Zoom in" onClick={() => void flow.zoomIn({ duration: 200 })}>
          <Plus />
        </ToolButton>
        <ToolButton label="Fit to screen" onClick={() => void flow.fitView({ padding: 0.2, duration: 300, maxZoom: 1 })}>
          <Maximize />
        </ToolButton>
        <ToolButton
          label="Arrange automatically"
          onClick={async () => {
            if (await confirm({ title: "Arrange automatically?", description: "Servers and networks go back to automatic places.", confirmLabel: "Arrange" })) void reset.run();
          }}
        >
          <LayoutGrid />
        </ToolButton>
      </div>
      <p className="absolute right-4 bottom-4 hidden max-w-xs rounded-xl border border-line bg-surface/95 px-3 py-2 text-[11px] leading-relaxed text-muted shadow-sm backdrop-blur sm:block">
        Drag a server onto a network to add it. Press × on a line to take it out.
      </p>
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

export function NetworkCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
