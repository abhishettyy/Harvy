import "@xyflow/react/dist/style.css";

import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  GoAgentGraphDelta,
  GoAgentMissionSnapshot,
  GoAgentScanId,
  ProjectId,
} from "@t3tools/contracts";
import { Background, Controls, MarkerType, ReactFlow } from "@xyflow/react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { goagent } from "../../state/goagent";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { buildFileGraph, type FileGraphEdge, type FileGraphNode } from "./goagentLayout";

const EVIDENCE_LABEL = {
  verified_static: "verified from source",
  inferred: "inferred (unverified)",
  ambiguous: "ambiguous",
  explicit_human: "authored by a person",
} as const;

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
        <div className="flex shrink-0 gap-1 border-b px-4 py-2">
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
  const [showConcepts, setShowConcepts] = useState(false);
  const [selected, setSelected] = useState<
    | { readonly type: "node"; readonly node: FileGraphNode }
    | { readonly type: "edge"; readonly edge: FileGraphEdge }
    | null
  >(null);

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

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        {deltaFrom === null || scanId === undefined ? (
          <FileGraphFlow
            graph={graph}
            delta={null}
            showConcepts={showConcepts}
            onSelect={setSelected}
          />
        ) : (
          <DeltaGraph
            environmentId={environmentId}
            graph={graph}
            baseScanId={deltaFrom}
            scanId={scanId}
            showConcepts={showConcepts}
            onSelect={setSelected}
          />
        )}
        <div className="absolute top-3 left-3 flex flex-col gap-1 rounded-md border bg-background/90 p-2 text-xs">
          <span>
            {graph.scan.nodeCount} nodes · {graph.scan.edgeCount} edges · Graphify{" "}
            {graph.scan.graphifyVersion ?? "?"}
            {graph.truncated ? " · trimmed for display" : ""}
          </span>
          <span className="flex items-center gap-2">
            <span className="inline-block h-0.5 w-6 bg-foreground" /> verified from source
          </span>
          <span className="flex items-center gap-2">
            <span className="inline-block h-0 w-6 border-t-2 border-dashed border-warning" />{" "}
            inferred / ambiguous
          </span>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showConcepts}
              onChange={(e) => setShowConcepts(e.target.checked)}
            />
            show packages
          </label>
        </div>
      </div>
      <GraphInspector selected={selected} />
    </div>
  );
}

function DeltaGraph({
  environmentId,
  graph,
  baseScanId,
  scanId,
  showConcepts,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly graph: NonNullable<Parameters<typeof FileGraphFlow>[0]["graph"]>;
  readonly baseScanId: GoAgentScanId;
  readonly scanId: GoAgentScanId;
  readonly showConcepts: boolean;
  readonly onSelect: Parameters<typeof FileGraphFlow>[0]["onSelect"];
}) {
  const deltaResult = useAtomValue(
    goagent.graphDelta({ environmentId, input: { baseScanId, scanId } }),
  );
  const delta = Option.getOrNull(AsyncResult.value(deltaResult));
  return (
    <FileGraphFlow graph={graph} delta={delta} showConcepts={showConcepts} onSelect={onSelect} />
  );
}

function FileGraphFlow({
  graph,
  delta,
  showConcepts,
  onSelect,
}: {
  readonly graph: {
    readonly nodes: Parameters<typeof buildFileGraph>[0];
    readonly edges: Parameters<typeof buildFileGraph>[1];
  };
  readonly delta: GoAgentGraphDelta | null;
  readonly showConcepts: boolean;
  readonly onSelect: (
    selection:
      | { readonly type: "node"; readonly node: FileGraphNode }
      | { readonly type: "edge"; readonly edge: FileGraphEdge }
      | null,
  ) => void;
}) {
  const fileGraph = buildFileGraph(graph.nodes, graph.edges, { delta, showConcepts });
  const nodes = fileGraph.nodes.map((node) => ({
    id: node.id,
    position: { x: node.x, y: node.y },
    data: {
      label: (
        <div className="flex flex-col gap-0.5 text-left">
          <span className="truncate text-xs font-medium">{node.label}</span>
          <span className="truncate text-3xs text-muted-foreground">
            {node.kind === "file" ? `${node.symbols.length} symbols` : node.kind}
            {node.changed === null ? "" : ` · ${node.changed}`}
          </span>
        </div>
      ),
    },
    className: [
      "rounded-md! border! bg-card! text-card-foreground! w-56!",
      node.changed === "added" ? "border-success! ring-2 ring-success/40" : "",
      node.changed === "removed" ? "border-destructive! opacity-60" : "",
      node.kind === "rationale" ? "border-info!" : "",
    ].join(" "),
  }));
  const edges = fileGraph.edges.map((edge) => {
    const unverified = edge.evidence !== "verified_static" && edge.evidence !== "explicit_human";
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.count > 1 ? `${edge.relation} ×${edge.count}` : edge.relation,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        strokeDasharray: unverified ? "6 4" : undefined,
        stroke:
          edge.changed === "added"
            ? "var(--color-success)"
            : edge.changed === "removed"
              ? "var(--color-destructive)"
              : unverified
                ? "var(--color-warning)"
                : undefined,
        strokeWidth: edge.changed === null ? 1 : 2,
      },
    };
  });
  const nodeById = new Map(fileGraph.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(fileGraph.edges.map((e) => [e.id, e]));
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      minZoom={0.1}
      nodesDraggable
      nodesConnectable={false}
      edgesFocusable
      onNodeClick={(_, node) => {
        const found = nodeById.get(node.id);
        onSelect(found === undefined ? null : { type: "node", node: found });
      }}
      onEdgeClick={(_, edge) => {
        const found = edgeById.get(edge.id);
        onSelect(found === undefined ? null : { type: "edge", edge: found });
      }}
      onPaneClick={() => onSelect(null)}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

const cite = (file: string | null, location: string | null) =>
  file === null
    ? "no source location"
    : `${file}${location === null ? "" : `:${location.replace(/^L/, "")}`}`;

function GraphInspector({
  selected,
}: {
  readonly selected:
    | { readonly type: "node"; readonly node: FileGraphNode }
    | { readonly type: "edge"; readonly edge: FileGraphEdge }
    | null;
}) {
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l p-4 text-sm">
      {selected === null ? (
        <p className="text-muted-foreground">
          Select a node or an edge to see its source evidence.
        </p>
      ) : selected.type === "node" ? (
        <>
          <div className="flex flex-col gap-1">
            <span className="font-medium">{selected.node.label}</span>
            <code className="text-xs text-muted-foreground">
              {cite(selected.node.sourceFile, selected.node.sourceLocation)}
            </code>
            {selected.node.changed === null ? null : (
              <span className="text-xs">Changed in this view: {selected.node.changed}</span>
            )}
          </div>
          {selected.node.symbols.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase text-muted-foreground">Symbols</span>
              {selected.node.symbols.map((symbol) => (
                <code key={symbol.id} className="text-xs">
                  {symbol.label}{" "}
                  <span className="text-muted-foreground">{symbol.sourceLocation}</span>
                </code>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="font-medium">{selected.edge.relation}</span>
            <span className="text-xs">Evidence: {EVIDENCE_LABEL[selected.edge.evidence]}</span>
            <span className="text-xs text-muted-foreground">
              {selected.edge.count} source relationship{selected.edge.count === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {selected.edge.examples.map((example) => (
              <div
                key={`${example.source}:${example.target}:${example.relation}`}
                className="flex flex-col"
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
        </>
      )}
    </aside>
  );
}
