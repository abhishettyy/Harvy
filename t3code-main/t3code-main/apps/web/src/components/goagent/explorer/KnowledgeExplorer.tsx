import "@xyflow/react/dist/style.css";

import type { GoAgentGraphDelta, GoAgentGraphEdge, GoAgentGraphNode } from "@t3tools/contracts";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Crosshair, Maximize, Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Toggle } from "../../ui/toggle";
import { HintButton } from "./HintButton";
import {
  ChevronGlyph,
  DecisionDiamond,
  EmptyGraphIllustration,
  KIND_COLOR,
  KIND_LABEL,
  KindGlyph,
  fileTypeOf,
} from "./ExplorerIcons";
import { ExplorerInspector } from "./ExplorerInspector";
import { ExplorerTree } from "./ExplorerTree";
import {
  RELATION_GROUPS,
  ROOT_ID,
  aggregateEdges,
  ancestorsOf,
  buildExplorerModel,
  changeCount,
  focusOf,
  isContainerKind,
  layoutExplorer,
  nodeStats,
  relationGroupOf,
  revealIds,
  visibleRepresentative,
  type AggregatedEdge,
  type ExplorerFilters,
  type ExplorerKind,
  type ExplorerModel,
  type NodeStats,
  type PlacedNode,
  type RelationGroup,
} from "./explorerModel";
// Relationship styling: pattern + arrowhead + colour, never colour alone.
const RELATION_STYLE: Record<
  RelationGroup,
  {
    readonly color: string;
    readonly dash?: string;
    readonly width: number;
    readonly marker: string;
  }
> = {
  imports: { color: "#71717a", width: 1.25, marker: "ga-arrow-open" },
  calls: { color: "#22d3ee", width: 1.6, marker: "ga-arrow-solid" },
  inherits: { color: "#a78bfa", width: 1.6, marker: "ga-arrow-hollow" },
  governs: { color: "#f59e0b", dash: "1.5 4", width: 1.6, marker: "ga-diamond" },
  rationale: { color: "#22d3ee", dash: "1.5 4", width: 1.25, marker: "ga-dot" },
  other: { color: "#71717a", dash: "5 4", width: 1.25, marker: "ga-arrow-open" },
};

const MARKER_COLORS = {
  muted: "#71717a",
  cyan: "#22d3ee",
  violet: "#a78bfa",
  amber: "#f59e0b",
  success: "var(--color-success)",
  destructive: "var(--color-destructive)",
} as const;
type MarkerColor = keyof typeof MARKER_COLORS;

const GROUP_MARKER_COLOR: Record<RelationGroup, MarkerColor> = {
  imports: "muted",
  calls: "cyan",
  inherits: "violet",
  governs: "amber",
  rationale: "cyan",
  other: "muted",
};

const markerShape = (shape: string, color: string) => {
  switch (shape) {
    case "ga-arrow-solid":
      return (
        <path
          d="M1 1l8 4-8 4z"
          style={{ fill: color, stroke: color }}
          strokeWidth="1"
          strokeLinejoin="round"
        />
      );
    case "ga-arrow-hollow":
      return (
        <path
          d="M1 1l8 4-8 4z"
          style={{ fill: "var(--color-background)", stroke: color }}
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      );
    case "ga-diamond":
      return (
        <path
          d="M5 1l4 4-4 4-4-4z"
          style={{ fill: color, fillOpacity: 0.35, stroke: color }}
          strokeWidth="1.25"
        />
      );
    case "ga-dot":
      return <circle cx="5" cy="5" r="2.75" style={{ fill: color }} />;
    default:
      return (
        <path
          d="M1 1l8 4-8 4"
          style={{ stroke: color }}
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
  }
};

const SHAPES = ["ga-arrow-open", "ga-arrow-solid", "ga-arrow-hollow", "ga-diamond", "ga-dot"];

/** Arrowhead definitions shared by every edge (referenced as `url(#shape-color)`). */
function EdgeMarkers() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <defs>
        {SHAPES.flatMap((shape) =>
          (Object.keys(MARKER_COLORS) as Array<MarkerColor>).map((key) => (
            <marker
              key={`${shape}-${key}`}
              id={`${shape}-${key}`}
              viewBox="0 0 10 10"
              refX={shape === "ga-dot" ? 5 : 8.5}
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              {markerShape(shape, MARKER_COLORS[key])}
            </marker>
          )),
        )}
      </defs>
    </svg>
  );
}

type EdgeState = "normal" | "outgoing" | "incoming" | "dimmed";

type RelationEdgeData = {
  readonly edge: AggregatedEdge;
  readonly state: EdgeState;
  readonly showLabel: boolean;
};

function RelationEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<RelationEdgeData, "relation">>) {
  const [hovered, setHovered] = useState(false);
  if (data === undefined) return null;
  const { edge, state, showLabel } = data;
  const style = RELATION_STYLE[edge.group];
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.3,
  });
  const unverified = edge.evidence === "inferred" || edge.evidence === "ambiguous";
  const colorKey: MarkerColor =
    edge.changed === "added"
      ? "success"
      : edge.changed === "removed"
        ? "destructive"
        : state === "outgoing"
          ? "cyan"
          : state === "incoming"
            ? "violet"
            : GROUP_MARKER_COLOR[edge.group];
  const color = MARKER_COLORS[colorKey];
  const active = state === "outgoing" || state === "incoming" || hovered;
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={`url(#${style.marker}-${colorKey})`}
        style={{
          stroke: color,
          strokeWidth:
            (active ? style.width + 1 : style.width) + Math.min(edge.count - 1, 3) * 0.35,
          strokeDasharray: unverified ? "6 4" : style.dash,
          opacity: state === "dimmed" ? 0.08 : active ? 1 : 0.55,
          transition: "opacity 150ms ease, stroke-width 150ms ease",
        }}
      />
      {/* Wide invisible hit area for hover. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {(showLabel || active) && state !== "dimmed" ? (
        <EdgeLabelRenderer>
          <span
            className="pointer-events-none absolute rounded border bg-background px-1.5 py-0.5 text-3xs font-medium text-foreground shadow-sm"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              borderColor: color,
            }}
          >
            {edge.relations.join(" · ").replaceAll("_", " ")}
            {edge.count > 1 ? ` ×${edge.count}` : ""}
            {unverified ? " · inferred" : ""}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
// Nodes
type CardState = "normal" | "selected" | "related" | "dimmed";

type CardData = {
  readonly placed: PlacedNode;
  readonly state: CardState;
  readonly stats: NodeStats | undefined;
  readonly changes: { readonly added: number; readonly removed: number };
  readonly onToggle: (id: string) => void;
};

/** Hidden zoom-out detail: keep identity (icon + name), drop metadata. */
const useCompact = () => useStore((store) => store.transform[2] < 0.55);

const cardRing = (state: CardState) =>
  state === "selected"
    ? "ring-2 ring-info shadow-lg shadow-info/10"
    : state === "related"
      ? "ring-1 ring-info/50"
      : "";

const Handles = () => (
  <>
    <Handle type="target" position={Position.Left} className="pointer-events-none! opacity-0!" />
    <Handle type="source" position={Position.Right} className="pointer-events-none! opacity-0!" />
  </>
);

function ChangeBadge({ changes }: { readonly changes: CardData["changes"] }) {
  if (changes.added === 0 && changes.removed === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-3xs font-semibold">
      {changes.added > 0 ? <span className="text-success-foreground">+{changes.added}</span> : null}
      {changes.removed > 0 ? (
        <span className="text-destructive-foreground">−{changes.removed}</span>
      ) : null}
    </span>
  );
}

function ExpandButton({
  id,
  open,
  onToggle,
}: {
  readonly id: string;
  readonly open: boolean;
  readonly onToggle: (id: string) => void;
}) {
  return (
    <HintButton
      label={open ? "Collapse" : "Expand"}
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation();
        onToggle(id);
      }}
    >
      <ChevronGlyph size={12} open={open} />
    </HintButton>
  );
}

/** Collapsed directory or file: a card with identity, counts and an expand control. */
function CardNode({ data }: NodeProps<Node<CardData, "card">>) {
  const compact = useCompact();
  const { placed, state, stats, changes, onToggle } = data;
  const node = placed.node;
  const expandable = isContainerKind(node.kind) && node.childIds.length > 0;
  const typeLabel = node.kind === "file" ? fileTypeOf(node.name).label : null;
  const symbols = node.kind === "file" ? node.childIds.length : 0;
  return (
    <div
      className={[
        "flex h-full w-full flex-col justify-center gap-1 rounded-lg border bg-card px-3 text-card-foreground shadow-sm transition-[opacity,box-shadow] duration-150",
        cardRing(state),
        changes.added > 0 && node.kind === "file" ? "border-success/60" : "",
      ].join(" ")}
      style={{ opacity: state === "dimmed" ? 0.22 : 1 }}
    >
      <Handles />
      <div className="flex items-center gap-2">
        <KindGlyph kind={node.kind} name={node.name} size={compact ? 20 : 16} />
        <span
          className={`min-w-0 flex-1 truncate font-semibold ${compact ? "text-base" : "text-sm"}`}
        >
          {node.name}
        </span>
        <ChangeBadge changes={changes} />
        {expandable ? <ExpandButton id={node.id} open={false} onToggle={onToggle} /> : null}
      </div>
      {compact ? null : (
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          {node.kind === "directory" ? (
            <span>
              {node.fileCount} file{node.fileCount === 1 ? "" : "s"}
            </span>
          ) : (
            <>
              <span className="truncate">{typeLabel}</span>
              {symbols > 0 ? <Meta>{symbols} symbols</Meta> : null}
            </>
          )}
          {stats === undefined ? null : (
            <span className="ml-auto flex shrink-0 gap-2">
              {stats.uses > 0 ? <span aria-label="Links out">↗ {stats.uses}</span> : null}
              {stats.usedBy > 0 ? <span aria-label="Links in">↙ {stats.usedBy}</span> : null}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const Meta = ({ children }: { readonly children: ReactNode }) => (
  <span className="rounded bg-muted px-1.5 py-px text-3xs">{children}</span>
);

/** Function, method, class (collapsed), WHY comment or package: a compact pill. */
function SymbolNode({ data }: NodeProps<Node<CardData, "symbol">>) {
  const compact = useCompact();
  const { placed, state, stats, changes, onToggle } = data;
  const node = placed.node;
  const expandable = node.kind === "class" && node.childIds.length > 0;
  const color = KIND_COLOR[node.kind];
  return (
    <div
      className={[
        "flex h-full w-full items-center gap-2 rounded-full border bg-card pr-2 pl-2.5 text-card-foreground shadow-sm transition-opacity duration-150",
        cardRing(state),
        changes.added > 0 ? "border-success/70" : "",
      ].join(" ")}
      style={{ opacity: state === "dimmed" ? 0.22 : 1, borderLeftColor: color, borderLeftWidth: 3 }}
    >
      <Handles />
      <KindGlyph kind={node.kind} name={node.name} size={14} />
      <span
        className={`min-w-0 flex-1 truncate font-mono ${node.kind === "rationale" ? "font-sans italic" : ""} text-xs`}
      >
        {node.name}
      </span>
      {compact || stats === undefined || (stats.calls === 0 && stats.calledBy === 0) ? null : (
        <span className="shrink-0 text-3xs text-muted-foreground" aria-label="calls out, called by">
          {stats.calls}→ ←{stats.calledBy}
        </span>
      )}
      <ChangeBadge changes={changes} />
      {expandable ? <ExpandButton id={node.id} open={false} onToggle={onToggle} /> : null}
    </div>
  );
}

function DecisionNode({ data }: NodeProps<Node<CardData, "decision">>) {
  const { placed, state } = data;
  return (
    <div
      className={[
        "flex h-full w-full items-center gap-2.5 rounded-lg border border-warning/40 bg-warning/6 px-3 text-card-foreground shadow-sm transition-opacity duration-150",
        cardRing(state),
      ].join(" ")}
      style={{ opacity: state === "dimmed" ? 0.22 : 1 }}
    >
      <Handles />
      <DecisionDiamond size={20} filled className="shrink-0 text-warning" />
      <span className="line-clamp-2 min-w-0 flex-1 text-xs leading-snug">{placed.node.name}</span>
    </div>
  );
}

/** An expanded directory, file or class: a frame around its children. */
function ContainerNode({ data }: NodeProps<Node<CardData, "container">>) {
  const { placed, state, changes, onToggle } = data;
  const node = placed.node;
  const color = KIND_COLOR[node.kind];
  return (
    <div
      className={[
        "h-full w-full rounded-xl border transition-opacity duration-150",
        state === "selected" ? "ring-2 ring-info" : "",
      ].join(" ")}
      style={{
        opacity: state === "dimmed" ? 0.45 : 1,
        borderColor: `color-mix(in srgb, ${color} 30%, var(--color-border))`,
        background: `color-mix(in srgb, ${color} ${node.kind === "directory" ? 3 : 5}%, transparent)`,
      }}
    >
      <Handles />
      <div className="flex h-9 items-center gap-2 px-3">
        <KindGlyph kind={node.kind} name={node.name} open size={15} />
        <span className="truncate text-xs font-semibold">{node.name}</span>
        <span className="text-2xs text-muted-foreground">
          {node.kind === "directory" ? `${node.fileCount} files` : `${node.childIds.length} inside`}
        </span>
        <ChangeBadge changes={changes} />
        <span className="ml-auto">
          <ExpandButton id={node.id} open onToggle={onToggle} />
        </span>
      </div>
    </div>
  );
}

const nodeTypes = {
  card: CardNode,
  symbol: SymbolNode,
  decision: DecisionNode,
  container: ContainerNode,
};
const edgeTypes = { relation: RelationEdge };

type FlowNode =
  | Node<CardData, "card">
  | Node<CardData, "symbol">
  | Node<CardData, "decision">
  | Node<CardData, "container">;

const nodeTypeOf = (placed: PlacedNode): FlowNode["type"] => {
  if (placed.expanded) return "container";
  if (placed.node.kind === "decision") return "decision";
  if (placed.node.kind === "directory" || placed.node.kind === "file") return "card";
  return "symbol";
};
// Explorer
/** Relation groups that occur anywhere in the graph, for the legend. */
const relationGroupsPresent = (model: ExplorerModel): ReadonlySet<RelationGroup> =>
  new Set(
    model.edges
      .filter((edge) => edge.relation !== "contains" && edge.relation !== "method")
      .map((edge) => relationGroupOf(edge.relation)),
  );

const HIDEABLE_KINDS: ReadonlyArray<{ readonly kind: ExplorerKind; readonly label: string }> = [
  { kind: "function", label: "Functions" },
  { kind: "class", label: "Classes" },
  { kind: "method", label: "Methods" },
  { kind: "rationale", label: "WHY notes" },
  { kind: "decision", label: "Decisions" },
  { kind: "package", label: "Packages" },
];

export function KnowledgeExplorer(props: {
  readonly nodes: ReadonlyArray<GoAgentGraphNode>;
  readonly edges: ReadonlyArray<GoAgentGraphEdge>;
  readonly delta: GoAgentGraphDelta | null;
  readonly stats: string;
}) {
  return (
    <ReactFlowProvider>
      <Explorer {...props} />
    </ReactFlowProvider>
  );
}

function Explorer({
  nodes: graphNodes,
  edges: graphEdges,
  delta,
  stats: statsLine,
}: {
  readonly nodes: ReadonlyArray<GoAgentGraphNode>;
  readonly edges: ReadonlyArray<GoAgentGraphEdge>;
  readonly delta: GoAgentGraphDelta | null;
  readonly stats: string;
}) {
  const flow = useReactFlow();
  const model = buildExplorerModel(graphNodes, graphEdges, delta);
  const stats = nodeStats(model);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<ExplorerKind>>(
    () => new Set<ExplorerKind>(["package", "method"]),
  );
  const [hiddenRelations, setHiddenRelations] = useState<ReadonlySet<RelationGroup>>(
    () => new Set(),
  );
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [hover, setHover] = useState<{
    readonly id: string;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const [pendingFit, setPendingFit] = useState<"all" | string | null>("all");
  const canvasRef = useRef<HTMLDivElement>(null);

  const filters: ExplorerFilters = { hiddenKinds, hiddenRelations };
  const edges = aggregateEdges(model, expanded, filters, delta);
  const placed = layoutExplorer(model, expanded, filters, edges);
  const selectedRep =
    selectedId === null ? null : visibleRepresentative(model, selectedId, expanded, filters);
  const focus = selectedRep === null ? null : focusOf(edges, selectedRep);

  const toggle = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        // Collapsing also folds everything inside, so reopening starts tidy.
        for (const other of previous)
          if (other === id || revealIds(model, other).includes(id)) next.delete(other);
      } else next.add(id);
      return next;
    });
    setPendingFit(id);
  };

  const select = (id: string | null) => {
    setSelectedId(id);
    if (id === null) return;
    // Reveal the selection in the graph (its containers open), then centre it.
    const reveal = revealIds(model, id).filter((a) => a !== ROOT_ID);
    setExpanded((previous) => {
      if (reveal.every((a) => previous.has(a))) return previous;
      const next = new Set(previous);
      for (const a of reveal) next.add(a);
      return next;
    });
    setPendingFit(id);
  };

  const reset = () => {
    setExpanded(new Set());
    setSelectedId(null);
    setFocusMode(false);
    setPendingFit("all");
  };

  // Centre on what changed once React Flow has the new layout.
  useEffect(() => {
    if (pendingFit === null) return;
    const handle = requestAnimationFrame(() => {
      if (pendingFit === "all") void flow.fitView({ padding: 0.12, duration: 300 });
      else {
        const rep = visibleRepresentative(model, pendingFit, expanded, filters) ?? pendingFit;
        void flow.fitView({ nodes: [{ id: rep }], padding: 0.6, duration: 300, maxZoom: 1.25 });
      }
      setPendingFit(null);
    });
    return () => cancelAnimationFrame(handle);
  });

  const visibleIds = new Set(placed.map((p) => p.id));
  const shownPlaced =
    focusMode && focus !== null
      ? placed.filter(
          (p) =>
            focus.nodeIds.has(p.id) ||
            // Keep the frames that hold focused nodes so context stays readable.
            (p.expanded && [...focus.nodeIds].some((id) => revealIds(model, id).includes(p.id))),
        )
      : placed;
  const shownIds = new Set(shownPlaced.map((p) => p.id));

  const flowNodes: Array<FlowNode> = shownPlaced.map((p) => {
    const state: CardState =
      p.id === selectedRep
        ? "selected"
        : focus === null
          ? "normal"
          : focus.nodeIds.has(p.id)
            ? "related"
            : p.expanded
              ? "normal"
              : "dimmed";
    return {
      id: p.id,
      type: nodeTypeOf(p),
      position: { x: p.x, y: p.y },
      width: p.width,
      height: p.height,
      style: { width: p.width, height: p.height },
      zIndex: p.expanded ? p.depth : 1000 + p.depth,
      selectable: true,
      data: {
        placed: p,
        state,
        stats: stats.get(p.id),
        changes: delta === null ? { added: 0, removed: 0 } : changeCount(model, p.id),
        onToggle: toggle,
      },
    } as FlowNode;
  });

  const flowEdges: Array<Edge<RelationEdgeData, "relation">> = edges
    .filter((edge) => shownIds.has(edge.source) && shownIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "relation",
      zIndex: 500,
      // Flow animation only where it helps: calls leaving the selection, in small graphs.
      animated:
        focus !== null &&
        focus.outgoing.has(edge.id) &&
        edge.group === "calls" &&
        edges.length < 150,
      data: {
        edge,
        showLabel: showLabels,
        state:
          focus === null
            ? "normal"
            : focus.outgoing.has(edge.id)
              ? "outgoing"
              : focus.incoming.has(edge.id)
                ? "incoming"
                : "dimmed",
      },
    }));

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("input, textarea")) {
      if (event.key === "Escape") (event.target as HTMLElement).blur();
      return;
    }
    if (event.key === "f" || event.key === "F") void flow.fitView({ padding: 0.12, duration: 300 });
    else if (event.key === "Escape") select(null);
    else if (event.key === "r" || event.key === "R") reset();
    else if (event.key === "/") {
      event.preventDefault();
      document.querySelector<HTMLInputElement>("[data-explorer-search]")?.focus();
    } else if ((event.key === "Enter" || event.key === "e") && selectedId !== null) {
      const node = model.nodes.get(selectedId);
      if (node !== undefined && isContainerKind(node.kind) && node.childIds.length > 0)
        toggle(selectedId);
    } else if (event.key === "Backspace" && selectedId !== null) {
      const parent = model.nodes.get(selectedId)?.parentId;
      if (parent !== null && parent !== undefined && parent !== ROOT_ID) select(parent);
    } else if (event.key === "m") setFocusMode((value) => !value);
  };

  const hovered = hover === null ? undefined : model.nodes.get(hover.id);

  return (
    <div
      className="flex h-full min-h-0 bg-background outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <ExplorerTree
        model={model}
        selectedId={selectedId}
        onSelect={select}
        collapsed={treeCollapsed}
        onCollapsedChange={setTreeCollapsed}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar
          model={model}
          selectedId={selectedId}
          onSelect={select}
          focusMode={focusMode}
          onFocusMode={setFocusMode}
          showLabels={showLabels}
          onShowLabels={setShowLabels}
          hiddenKinds={hiddenKinds}
          onHiddenKinds={setHiddenKinds}
        />
        <div ref={canvasRef} className="relative min-h-0 flex-1">
          <EdgeMarkers />
          {placed.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
              <EmptyGraphIllustration />
              <p className="text-sm">Nothing to show with the current filters.</p>
            </div>
          ) : (
            <ReactFlow<FlowNode, Edge<RelationEdgeData, "relation">>
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              minZoom={0.08}
              maxZoom={2}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              onlyRenderVisibleElements={placed.length > 250}
              onNodeClick={(_, node) => select(node.id)}
              onNodeDoubleClick={(_, node) => {
                const tree = model.nodes.get(node.id);
                if (tree !== undefined && isContainerKind(tree.kind) && tree.childIds.length > 0)
                  toggle(node.id);
              }}
              onNodeMouseEnter={(event, node) => {
                const rect = canvasRef.current?.getBoundingClientRect();
                if (rect !== undefined)
                  setHover({
                    id: node.id,
                    x: event.clientX - rect.left,
                    y: event.clientY - rect.top,
                  });
              }}
              onNodeMouseLeave={() => setHover(null)}
              onPaneClick={() => select(null)}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="var(--color-border)"
              />
              <MiniMap
                pannable
                zoomable
                position="bottom-right"
                className="rounded-lg! border! bg-card!"
                maskColor="color-mix(in srgb, var(--color-background) 72%, transparent)"
                nodeColor={(node) => {
                  const kind = (node.data as CardData).placed.node.kind;
                  return (node.data as CardData).placed.expanded ? "transparent" : KIND_COLOR[kind];
                }}
                nodeStrokeColor={(node) =>
                  (node.data as CardData).placed.expanded ? "var(--color-border)" : "transparent"
                }
                nodeBorderRadius={4}
              />
            </ReactFlow>
          )}
          <ZoomControls
            onReset={reset}
            canFocus={selectedRep !== null}
            onFocusSelection={() => selectedId !== null && setPendingFit(selectedId)}
          />
          <Legend
            hidden={hiddenRelations}
            onToggle={(group) =>
              setHiddenRelations((previous) => {
                const next = new Set(previous);
                if (next.has(group)) next.delete(group);
                else next.add(group);
                return next;
              })
            }
            present={relationGroupsPresent(model)}
            statsLine={`${statsLine} · ${visibleIds.size} shown`}
          />
          {hovered !== undefined && hover !== null ? (
            <Tooltip node={hovered} stats={stats.get(hovered.id)} x={hover.x} y={hover.y} />
          ) : null}
        </div>
      </div>
      <ExplorerInspector model={model} selectedId={selectedId} onSelect={select} />
    </div>
  );
}

function Toolbar({
  model,
  selectedId,
  onSelect,
  focusMode,
  onFocusMode,
  showLabels,
  onShowLabels,
  hiddenKinds,
  onHiddenKinds,
}: {
  readonly model: ExplorerModel;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly focusMode: boolean;
  readonly onFocusMode: (value: boolean) => void;
  readonly showLabels: boolean;
  readonly onShowLabels: (value: boolean) => void;
  readonly hiddenKinds: ReadonlySet<ExplorerKind>;
  readonly onHiddenKinds: (value: ReadonlySet<ExplorerKind>) => void;
}) {
  const crumbs = selectedId === null ? [] : ancestorsOf(model, selectedId);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <nav className="flex min-w-0 flex-1 items-center gap-1 text-xs" aria-label="Breadcrumb">
        <button
          type="button"
          className="rounded px-1.5 py-0.5 font-medium hover:bg-accent"
          onClick={() => onSelect(null)}
        >
          Project
        </button>
        {crumbs.slice(1).map((crumb, index) => (
          <span key={crumb.id} className="flex min-w-0 items-center gap-1">
            <ChevronGlyph size={10} className="shrink-0 text-muted-foreground" />
            <button
              type="button"
              className={`flex min-w-0 items-center gap-1 truncate rounded px-1.5 py-0.5 hover:bg-accent ${index === crumbs.length - 2 ? "font-semibold text-foreground" : "text-muted-foreground"}`}
              onClick={() => onSelect(crumb.id)}
            >
              <KindGlyph kind={crumb.kind} name={crumb.name} size={12} />
              <span className="truncate">{crumb.name}</span>
            </button>
          </span>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-1">
        {HIDEABLE_KINDS.map(({ kind, label }) => (
          <Toggle
            key={kind}
            size="segmented"
            variant="outline"
            pressed={!hiddenKinds.has(kind)}
            onPressedChange={(pressed) => {
              const next = new Set(hiddenKinds);
              if (pressed) next.delete(kind);
              else next.add(kind);
              onHiddenKinds(next);
            }}
          >
            <KindGlyph kind={kind} name="" size={12} />
            {label}
          </Toggle>
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        <Toggle
          size="segmented"
          variant="outline"
          pressed={showLabels}
          onPressedChange={onShowLabels}
        >
          Labels
        </Toggle>
        <Toggle
          size="segmented"
          variant="outline"
          pressed={focusMode}
          onPressedChange={onFocusMode}
          disabled={selectedId === null}
          aria-label="Focus: show only the selection and its links (M)"
        >
          <Crosshair className="size-3" />
          Focus
        </Toggle>
      </div>
    </div>
  );
}

function ZoomControls({
  onReset,
  canFocus,
  onFocusSelection,
}: {
  readonly onReset: () => void;
  readonly canFocus: boolean;
  readonly onFocusSelection: () => void;
}) {
  const flow = useReactFlow();
  const button =
    "flex size-8 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40";
  return (
    <div className="absolute bottom-3 left-3 z-10 flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
      <HintButton
        label="Zoom in"
        className={button}
        onClick={() => void flow.zoomIn({ duration: 150 })}
      >
        <Plus className="size-4" />
      </HintButton>
      <HintButton
        label="Zoom out"
        className={button}
        onClick={() => void flow.zoomOut({ duration: 150 })}
      >
        <Minus className="size-4" />
      </HintButton>
      <span className="h-px bg-border" />
      <HintButton
        label="Fit to view (F)"
        className={button}
        onClick={() => void flow.fitView({ padding: 0.12, duration: 300 })}
      >
        <Maximize className="size-4" />
      </HintButton>
      <HintButton
        label="Centre the selection"
        className={button}
        onClick={onFocusSelection}
        disabled={!canFocus}
      >
        <Crosshair className="size-4" />
      </HintButton>
      <HintButton label="Reset to overview (R)" className={button} onClick={onReset}>
        <RotateCcw className="size-4" />
      </HintButton>
    </div>
  );
}

function LegendLine({ group }: { readonly group: RelationGroup }) {
  const style = RELATION_STYLE[group];
  return (
    <svg width="34" height="10" viewBox="0 0 34 10" aria-hidden="true" className="shrink-0">
      <path
        d="M2 5h26"
        style={{ stroke: style.color }}
        strokeWidth={style.width + 0.25}
        strokeDasharray={style.dash}
        markerEnd={`url(#${style.marker}-${GROUP_MARKER_COLOR[group]})`}
        fill="none"
      />
    </svg>
  );
}

function Legend({
  hidden,
  onToggle,
  present,
  statsLine,
}: {
  readonly hidden: ReadonlySet<RelationGroup>;
  readonly onToggle: (group: RelationGroup) => void;
  readonly present: ReadonlySet<RelationGroup>;
  readonly statsLine: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="absolute top-3 right-3 z-10 w-60 rounded-lg border bg-card/95 text-xs shadow-sm backdrop-blur">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 font-semibold"
        onClick={() => setOpen(!open)}
      >
        Legend
        <span className="truncate font-normal text-muted-foreground">{statsLine}</span>
        <ChevronGlyph size={11} open={open} className="ml-auto shrink-0" />
      </button>
      {open ? (
        <div className="flex flex-col gap-0.5 border-t px-2 py-2">
          {RELATION_GROUPS.filter(({ group }) => present.has(group)).map(({ group, label }) => (
            <button
              key={group}
              type="button"
              className={`flex items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent ${hidden.has(group) ? "opacity-40 line-through" : ""}`}
              onClick={() => onToggle(group)}
              aria-label={hidden.has(group) ? `Show ${label} links` : `Hide ${label} links`}
            >
              <LegendLine group={group} />
              {label}
            </button>
          ))}
          <span className="flex items-center gap-2 px-1.5 py-1 text-muted-foreground">
            <svg width="34" height="10" aria-hidden="true">
              <path
                d="M2 5h26"
                style={{ stroke: MARKER_COLORS.muted }}
                strokeWidth={1.25}
                strokeDasharray="6 4"
              />
            </svg>
            inferred, not proven
          </span>
          <span className="flex items-center gap-2 px-1.5 py-1 text-muted-foreground">
            <span className="h-0.5 w-8 rounded" style={{ background: MARKER_COLORS.cyan }} /> uses
            (from selection)
          </span>
          <span className="flex items-center gap-2 px-1.5 py-1 text-muted-foreground">
            <span className="h-0.5 w-8 rounded" style={{ background: MARKER_COLORS.violet }} /> used
            by (into selection)
          </span>
          <span className="mt-1 border-t px-1.5 pt-2 text-muted-foreground">
            Lines are Graphify links read from source; nesting shows containment.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function Tooltip({
  node,
  stats,
  x,
  y,
}: {
  readonly node: NonNullable<ReturnType<ExplorerModel["nodes"]["get"]>>;
  readonly stats: NodeStats | undefined;
  readonly x: number;
  readonly y: number;
}) {
  const detail =
    node.kind === "directory"
      ? `${node.fileCount} files`
      : node.kind === "file"
        ? `${node.childIds.length} symbols · uses ${stats?.uses ?? 0} · used by ${stats?.usedBy ?? 0}`
        : node.kind === "decision"
          ? "Applies to the files its text names"
          : node.kind === "function" || node.kind === "method"
            ? `calls ${stats?.calls ?? 0} · called by ${stats?.calledBy ?? 0}`
            : null;
  return (
    <div
      className="pointer-events-none absolute z-20 max-w-72 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
      style={{ left: x + 14, top: y + 14 }}
    >
      <div className="flex items-center gap-1.5 font-medium">
        <KindGlyph kind={node.kind} name={node.name} size={13} />
        <span className="truncate">{node.name}</span>
      </div>
      <div className="text-muted-foreground">
        {node.kind === "file" ? fileTypeOf(node.name).label : KIND_LABEL[node.kind]}
        {node.path !== null && node.kind !== "file" && node.kind !== "directory"
          ? ` · ${node.path}${node.sourceLocation === null ? "" : `:${node.sourceLocation.replace(/^L/, "")}`}`
          : node.path !== null
            ? ` · ${node.path}`
            : ""}
      </div>
      {detail === null ? null : <div className="text-muted-foreground">{detail}</div>}
    </div>
  );
}
