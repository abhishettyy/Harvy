import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  GoAgentGraphSnapshot,
  GoAgentMissionSnapshot,
  GoAgentScanId,
  ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { goagent } from "../../state/goagent";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { EmptyGraphIllustration } from "./explorer/ExplorerIcons";
import { KnowledgeExplorer } from "./explorer/KnowledgeExplorer";

/**
 * The knowledge graph explorer for a project, optionally as it looked after a mission step
 * (with what that step added and removed highlighted).
 */
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
        <div className="flex shrink-0 items-center gap-1 border-b px-4 py-1.5">
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
              <span className="text-success-foreground">+ added</span> /{" "}
              <span className="text-destructive-foreground">− removed</span> by this step
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <GraphData
          key={view.key}
          environmentId={environmentId}
          projectId={projectId}
          scanId={view.scanId ?? undefined}
          deltaFrom={showDelta ? baseScanId : null}
        />
      </div>
    </div>
  );
}

function GraphData({
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
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-muted-foreground">
        {graphResult._tag === "Failure" ? (
          <p className="text-sm text-destructive-foreground">
            The knowledge graph could not be loaded.
          </p>
        ) : graphResult.waiting ? (
          <>
            <Spinner />
            <p className="text-sm">Loading the knowledge graph…</p>
          </>
        ) : (
          <>
            <EmptyGraphIllustration />
            <p className="text-sm">Index the repository to build its knowledge graph.</p>
          </>
        )}
      </div>
    );

  return deltaFrom === null || scanId === undefined ? (
    <KnowledgeExplorer
      nodes={graph.nodes}
      edges={graph.edges}
      delta={null}
      stats={statsOf(graph)}
    />
  ) : (
    <DeltaExplorer
      environmentId={environmentId}
      graph={graph}
      baseScanId={deltaFrom}
      scanId={scanId}
    />
  );
}

const statsOf = (graph: GoAgentGraphSnapshot) =>
  `${graph.scan.nodeCount} nodes · ${graph.scan.edgeCount} links${graph.truncated ? " (trimmed)" : ""}`;

function DeltaExplorer({
  environmentId,
  graph,
  baseScanId,
  scanId,
}: {
  readonly environmentId: EnvironmentId;
  readonly graph: GoAgentGraphSnapshot;
  readonly baseScanId: GoAgentScanId;
  readonly scanId: GoAgentScanId;
}) {
  const deltaResult = useAtomValue(
    goagent.graphDelta({ environmentId, input: { baseScanId, scanId } }),
  );
  return (
    <KnowledgeExplorer
      nodes={graph.nodes}
      edges={graph.edges}
      delta={Option.getOrNull(AsyncResult.value(deltaResult))}
      stats={statsOf(graph)}
    />
  );
}
