import "@xyflow/react/dist/style.css";

import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  GoAgentGraphDelta,
  GoAgentMissionSnapshot,
  GoAgentScanId,
  ProjectId,
} from "@t3tools/contracts";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { goagent } from "../../state/goagent";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Toggle } from "../ui/toggle";
import {
  buildFileGraph,
  focusOf,
  GRAPH_NODE_WIDTH,
  matchesQuery,
  type FileGraphEdge,
  type FileGraphNode,
  type GraphArea,
  type GraphLane,
} from "./goagentLayout";

const EVIDENCE_LABEL = {
  verified_static: "verified from source",
  inferred: "inferred (unverified)",
  ambiguous: "ambiguous",
  explicit_human: "authored by a person",
} as const;

/** One accent per app area; hex so the minimap can use it too. */
const AREA_COLOR: Record<GraphArea, string> = {
  decision: "#f59e0b",
  server: "#8b5cf6",
  tests: "#14b8a6",
  client: "#0ea5e9",
  other: "#71717a",
};

type Selection =
  | { readonly type: "node"; readonly node: FileGraphNode }
  | { readonly type: "edge"; readonly edge: FileGraphEdge }
  | null;

export function GoAgentGraphView({
  environmentId,
  projectId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly snapshot: GoAgentMissionSnapshot | null;
}) {
  const taskScans = (snapshot?.tasks ?? []).filter((task) => task.scanId !== null);
  const integrationScan = snapshot?.mission.integration.scanId ?? null;
  const views = [
    { key: "base", label: "Base", scanId: snapshot?.mission.baseScanId ?? null },
    ...taskScans.map((task) => ({
      key: task.key,
      label: `After ${task.key}`,
      scanId: task.scanId,
    })),
    ...(integrationScan === null
      ? []
      : [{ key: "integration", label: "Integrated", scanId: integrationScan }]),
  ];
  const [viewKey, setViewKey] = useState("base");
  const view = views.find((v) => v.key === viewKey) ?? views[0]!;
  const baseScanId = snapshot?.mission.baseScanId ?? null;
  const showDelta = view.key !== "base" && baseScanId !== null && view.scanId !== null;

  return (
    <div className="flex h-full flex-col">
      {views.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1 border-b px-4 py-2">
          <span className="mr-2 text-xs text-muted-foreground">Graph after:</span>
          {views.map((candidate) => (
            <Button
              key={candidate.key}
              size="compact"
              variant={candidate.key === view.key ? "secondary" : "ghost-muted"}
              onClick={() => setViewKey(candidate.key)}
            >
              {candidate.label}
            </Button>
          ))}
          {showDelta ? (
            <span className="ml-auto text-xs text-muted-foreground">
              Green = added by this step · red = removed
            </span>
          ) : null}
        </div>
      ) : null}
      <GraphCanvas
        key={view.key}
        environmentId={environmentId}
        projectId={projectId}
        scanId={view.scanId ?? undefined}
        deltaFrom={showDelta ? baseScanId : null}
      />
    </div>
  );
}

function GraphCanvas({
  environmentId,
  projectId,
  scanId,
  deltaFrom,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly scanId: GoAgentScanId | undefined;
  readonly deltaFrom: GoAgentScanId | null;
}) {
  const graphResult = useAtomValue(
    goagent.graph({
      environmentId,
      input: scanId === undefined ? { projectId } : { projectId, scanId },
    }),
  );
  const graph = Option.getOrNull(AsyncResult.value(graphResult));

  if (graph === null)
    return (
      <div className="flex h-full items-center justify-center p-6">
        {graphResult._tag === "Failure" ? (
          <p className="text-sm text-destructive-foreground">
            The knowledge graph could not be loaded.
          </p>
        ) : graphResult.waiting ? (
          <Spinner />
        ) : (
          <p className="text-sm text-muted-foreground">
            Index the repository to build its knowledge graph.
          </p>
        )}
      </div>
    );

  return deltaFrom === null || scanId === undefined ? (
    <GraphExplorer graph={graph} delta={null} />
  ) : (
    <DeltaGraph
      environmentId={environmentId}
      graph={graph}
      baseScanId={deltaFrom}
      scanId={scanId}
    />
  );
}

interface GraphData {
  readonly scan: {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly graphifyVersion: string | null;
  };
  readonly truncated: boolean;
  readonly nodes: Parameters<typeof buildFileGraph>[0];
  readonly edges: Parameters<typeof buildFileGraph>[1];
}

function DeltaGraph({
  environmentId,
  graph,
  baseScanId,
  scanId,
}: {
  readonly environmentId: EnvironmentId;
  readonly graph: GraphData;
  readonly baseScanId: GoAgentScanId;
  readonly scanId: GoAgentScanId;
}) {
  const deltaResult = useAtomValue(
    goagent.graphDelta({ environmentId, input: { baseScanId, scanId } }),
  );
  return <GraphExplorer graph={graph} delta={Option.getOrNull(AsyncResult.value(deltaResult))} />;
}

type FileNodeData = {
  readonly node: FileGraphNode;
  readonly dimmed: boolean;
  readonly highlighted: boolean;
  readonly selected: boolean;
};
type LaneNodeData = { readonly lane: GraphLane };
type FlowNode = Node<FileNodeData, "file"> | Node<LaneNodeData, "lane">;

const nodeTypes = { file: FileNodeCard, lane: LaneBackdrop };

function GraphExplorer({
  graph,
  delta,
}: {
  readonly graph: GraphData;
  readonly delta: GoAgentGraphDelta | null;
}) {
  const [showConcepts, setShowConcepts] = useState(false);
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const [query, setQuery] = useState("");
  const [hiddenRelations, setHiddenRelations] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<Selection>(null);

  const fileGraph = buildFileGraph(graph.nodes, graph.edges, { delta, showConcepts });
  const relations = [...new Set(fileGraph.edges.map((edge) => edge.relation))].toSorted();
  const shownEdges = fileGraph.edges.filter((edge) => !hiddenRelations.has(edge.relation));
  const focus =
    selected?.type === "node"
      ? focusOf(shownEdges, selected.node.id)
      : selected?.type === "edge"
        ? {
            nodeIds: new Set([selected.edge.source, selected.edge.target]),
            edgeIds: new Set([selected.edge.id]),
          }
        : null;
  const searching = query.trim().length > 0;
  const matches = searching
    ? new Set(fileGraph.nodes.filter((n) => matchesQuery(n, query)).map((n) => n.id))
    : null;

  const nodes: Array<FlowNode> = [
    ...fileGraph.lanes.map((lane): FlowNode => ({
      id: `lane:${lane.area}`,
      type: "lane",
      position: { x: lane.x, y: lane.y },
      data: { lane },
      style: { width: lane.width, height: lane.height },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
    })),
    ...fileGraph.nodes.map((node): FlowNode => ({
      id: node.id,
      type: "file",
      position: { x: node.x, y: node.y },
      data: {
        node,
        selected: selected?.type === "node" && selected.node.id === node.id,
        highlighted: matches?.has(node.id) === true,
        dimmed:
          (focus !== null && !focus.nodeIds.has(node.id)) ||
          (matches !== null && !matches.has(node.id)),
      },
    })),
  ];

  const edges: Array<Edge> = shownEdges.map((edge) => {
    const unverified = edge.evidence !== "verified_static" && edge.evidence !== "explicit_human";
    const inFocus = focus?.edgeIds.has(edge.id) === true;
    const dimmed = (focus !== null && !inFocus) || matches !== null;
    const color =
      edge.changed === "added"
        ? "var(--color-success)"
        : edge.changed === "removed"
          ? "var(--color-destructive)"
          : edge.evidence === "explicit_human"
            ? AREA_COLOR.decision
            : unverified
              ? "var(--color-warning)"
              : inFocus
                ? "var(--color-foreground)"
                : "var(--color-muted-foreground)";
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label:
        showEdgeLabels || inFocus
          ? edge.count > 1
            ? `${edge.relation} ×${edge.count}`
            : edge.relation
          : undefined,
      labelStyle: { fontSize: 11, fill: "var(--color-foreground)" },
      labelBgStyle: { fill: "var(--color-background)" },
      labelBgPadding: [4, 2] as [number, number],
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      animated: edge.changed === "added",
      zIndex: inFocus ? 10 : 0,
      style: {
        stroke: color,
        strokeWidth: inFocus || edge.changed !== null ? 2.5 : 1.25,
        strokeDasharray: unverified
          ? "6 4"
          : edge.evidence === "explicit_human"
            ? "2 4"
            : undefined,
        opacity: dimmed ? 0.12 : 1,
      },
    };
  });

  const nodeById = new Map(fileGraph.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(fileGraph.edges.map((e) => [e.id, e]));
  const added = fileGraph.nodes.filter((n) => n.changed === "added").length;

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        <ReactFlow<FlowNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.1}
          maxZoom={2}
          nodesDraggable
          nodesConnectable={false}
          edgesFocusable
          onNodeClick={(_, node) => {
            const found = nodeById.get(node.id);
            setSelected(found === undefined ? null : { type: "node", node: found });
          }}
          onEdgeClick={(_, edge) => {
            const found = edgeById.get(edge.id);
            setSelected(found === undefined ? null : { type: "edge", edge: found });
          }}
          onPaneClick={() => setSelected(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            className="rounded-md! border! bg-card!"
            maskColor="color-mix(in srgb, var(--color-background) 70%, transparent)"
            nodeColor={(node) =>
              node.type === "lane"
                ? "transparent"
                : AREA_COLOR[(node.data as FileNodeData).node.area]
            }
            nodeStrokeWidth={0}
          />
          <Panel position="top-left" className="m-3!">
            <div className="flex max-w-[44rem] flex-wrap items-center gap-2 rounded-lg border bg-background/95 p-2 shadow-sm backdrop-blur">
              <Input
                type="search"
                size="compact"
                className="w-56"
                placeholder="Find a file or function…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {searching ? (
                <span className="text-xs text-muted-foreground">
                  {matches?.size ?? 0} match{matches?.size === 1 ? "" : "es"}
                </span>
              ) : null}
              <span className="mx-1 h-5 w-px bg-border" />
              {relations.map((relation) => (
                <Toggle
                  key={relation}
                  size="segmented"
                  variant="outline"
                  pressed={!hiddenRelations.has(relation)}
                  onPressedChange={(pressed) =>
                    setHiddenRelations((previous) => {
                      const next = new Set(previous);
                      if (pressed) next.delete(relation);
                      else next.add(relation);
                      return next;
                    })
                  }
                >
                  {relation}
                </Toggle>
              ))}
              <span className="mx-1 h-5 w-px bg-border" />
              <Toggle
                size="segmented"
                variant="outline"
                pressed={showEdgeLabels}
                onPressedChange={setShowEdgeLabels}
              >
                Edge labels
              </Toggle>
              <Toggle
                size="segmented"
                variant="outline"
                pressed={showConcepts}
                onPressedChange={setShowConcepts}
              >
                Packages
              </Toggle>
            </div>
          </Panel>
          <Panel position="top-right" className="m-3!">
            <Legend
              stats={`${graph.scan.nodeCount} nodes · ${graph.scan.edgeCount} edges${graph.truncated ? " · trimmed" : ""}`}
              graphify={graph.scan.graphifyVersion}
              added={delta === null ? null : added}
            />
          </Panel>
        </ReactFlow>
      </div>
      <GraphInspector
        selected={selected}
        edges={fileGraph.edges}
        nodeById={nodeById}
        onSelect={setSelected}
      />
    </div>
  );
}

function FileNodeCard({ data }: NodeProps<Node<FileNodeData, "file">>) {
  const { node, dimmed, highlighted, selected } = data;
  const folder =
    node.sourceFile === null ? null : node.sourceFile.split("/").slice(0, -1).join("/") || ".";
  return (
    <div
      style={{
        width: GRAPH_NODE_WIDTH,
        borderLeftColor: AREA_COLOR[node.area],
        opacity: dimmed ? 0.25 : 1,
      }}
      className={[
        "flex flex-col gap-1 rounded-lg border border-l-4 bg-card px-3 py-2 text-card-foreground shadow-sm transition-opacity",
        selected ? "ring-2 ring-ring" : "",
        highlighted ? "ring-2 ring-info" : "",
        node.changed === "added" ? "border-success! shadow-md shadow-success/30" : "",
        node.changed === "removed" ? "border-destructive! opacity-60" : "",
      ].join(" ")}
    >
      <Handle type="target" position={Position.Left} className="opacity-0!" />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{node.label}</span>
        {node.changed === null ? null : (
          <span
            className={[
              "shrink-0 rounded px-1.5 text-3xs font-medium uppercase",
              node.changed === "added"
                ? "bg-success/15 text-success-foreground"
                : "bg-destructive/15 text-destructive-foreground",
            ].join(" ")}
          >
            {node.changed}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {node.kind === "decision"
            ? "project decision"
            : node.kind === "file"
              ? folder
              : node.kind}
        </span>
        {node.kind === "file" && node.symbols.length > 0 ? (
          <span className="shrink-0 rounded bg-muted px-1.5 text-3xs">
            {node.symbols.length} symbol{node.symbols.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0!" />
    </div>
  );
}

function LaneBackdrop({ data }: NodeProps<Node<LaneNodeData, "lane">>) {
  const color = AREA_COLOR[data.lane.area];
  return (
    <div
      className="pointer-events-none h-full w-full rounded-xl border"
      style={{
        borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 6%, transparent)`,
      }}
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className="size-2.5 rounded-full" style={{ background: color }} />
        <span className="text-sm font-semibold">{data.lane.label}</span>
        <span className="text-xs text-muted-foreground">{data.lane.count}</span>
      </div>
    </div>
  );
}

function Legend({
  stats,
  graphify,
  added,
}: {
  readonly stats: string;
  readonly graphify: string | null;
  readonly added: number | null;
}) {
  return (
    <div className="flex w-56 flex-col gap-1.5 rounded-lg border bg-background/95 p-3 text-xs shadow-sm backdrop-blur">
      <span className="font-medium">{stats}</span>
      <span className="text-muted-foreground">Built by Graphify {graphify ?? "?"} from source</span>
      {added === null ? null : (
        <span className="text-success-foreground">{added} file(s) changed in this step</span>
      )}
      <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1">
        {(Object.keys(AREA_COLOR) as Array<GraphArea>).map((area) => (
          <span key={area} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: AREA_COLOR[area] }} />
            {area}
          </span>
        ))}
      </div>
      <div className="mt-1 flex flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-6 bg-muted-foreground" /> verified from source
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-0 w-6 border-t-2 border-dashed border-warning" />
          inferred / ambiguous
        </span>
        <span className="flex items-center gap-2">
          <span
            className="inline-block h-0 w-6 border-t-2 border-dotted"
            style={{ borderColor: AREA_COLOR.decision }}
          />
          decision governs
        </span>
      </div>
      <span className="mt-1 text-muted-foreground">Click a file to focus on its links.</span>
    </div>
  );
}

const cite = (file: string | null, location: string | null) =>
  file === null
    ? "no source location"
    : `${file}${location === null ? "" : `:${location.replace(/^L/, "")}`}`;

function GraphInspector({
  selected,
  edges,
  nodeById,
  onSelect,
}: {
  readonly selected: Selection;
  readonly edges: ReadonlyArray<FileGraphEdge>;
  readonly nodeById: ReadonlyMap<string, FileGraphNode>;
  readonly onSelect: (selection: Selection) => void;
}) {
  if (selected === null)
    return (
      <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l p-4 text-sm">
        <span className="font-medium">Inspector</span>
        <p className="text-muted-foreground">
          Click a file to see its symbols and what it connects to, or click a link to see the exact
          source lines it was read from.
        </p>
      </aside>
    );
  if (selected.type === "edge") {
    const source = nodeById.get(selected.edge.source);
    const target = nodeById.get(selected.edge.target);
    return (
      <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l p-4 text-sm">
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase text-muted-foreground">Link</span>
          <span className="font-medium">
            {source?.label ?? selected.edge.source}{" "}
            <span className="text-muted-foreground">{selected.edge.relation}</span>{" "}
            {target?.label ?? selected.edge.target}
          </span>
          <span className="text-xs">Evidence: {EVIDENCE_LABEL[selected.edge.evidence]}</span>
          <span className="text-xs text-muted-foreground">
            {selected.edge.count} source relationship{selected.edge.count === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex flex-col gap-2">
          {selected.edge.examples.map((example) => (
            <div
              key={`${example.source}:${example.target}:${example.relation}`}
              className="flex flex-col rounded-md border p-2"
            >
              <code className="text-xs">
                {example.source} → {example.target}
              </code>
              <code className="text-xs text-muted-foreground">
                {cite(example.sourceFile, example.sourceLocation)} ·{" "}
                {EVIDENCE_LABEL[example.evidence]}
                {example.evidence === "verified_static"
                  ? ""
                  : ` · score ${example.confidenceScore}`}
              </code>
            </div>
          ))}
        </div>
      </aside>
    );
  }
  const node = selected.node;
  const linkList = (
    title: string,
    list: ReadonlyArray<FileGraphEdge>,
    otherEnd: (edge: FileGraphEdge) => string,
  ) => (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase text-muted-foreground">
        {title} ({list.length})
      </span>
      {list.length === 0 ? (
        <span className="text-xs text-muted-foreground">None</span>
      ) : (
        list.map((edge) => {
          const other = nodeById.get(otherEnd(edge));
          return (
            <button
              key={edge.id}
              type="button"
              className="flex items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
              onClick={() => onSelect({ type: "edge", edge })}
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: other === undefined ? undefined : AREA_COLOR[other.area] }}
              />
              <span className="min-w-0 flex-1 truncate">{other?.label ?? otherEnd(edge)}</span>
              <span className="text-muted-foreground">
                {edge.relation}
                {edge.count > 1 ? ` ×${edge.count}` : ""}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l p-4 text-sm">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="size-2.5 rounded-sm" style={{ background: AREA_COLOR[node.area] }} />
          <span className="font-medium">{node.label}</span>
        </span>
        <code className="text-xs text-muted-foreground">
          {cite(node.sourceFile, node.sourceLocation)}
        </code>
        {node.changed === null ? null : (
          <span className="text-xs">Changed in this view: {node.changed}</span>
        )}
      </div>
      {linkList(
        "Uses",
        edges.filter((edge) => edge.source === node.id),
        (edge) => edge.target,
      )}
      {linkList(
        "Used by",
        edges.filter((edge) => edge.target === node.id),
        (edge) => edge.source,
      )}
      {node.symbols.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase text-muted-foreground">
            Symbols ({node.symbols.length})
          </span>
          {node.symbols.map((symbol) => (
            <code key={symbol.id} className="text-xs">
              {symbol.label} <span className="text-muted-foreground">{symbol.sourceLocation}</span>
            </code>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
