import {
  GOAGENT_CONTRACT_DEPENDENCY,
  type GoAgentEvidence,
  type GoAgentGraphDelta,
  type GoAgentGraphEdge,
  type GoAgentGraphNode,
  type GoAgentMissionSnapshot,
} from "@t3tools/contracts";

export interface FileGraphNode {
  readonly id: string;
  readonly label: string;
  readonly kind: GoAgentGraphNode["kind"];
  readonly sourceFile: string | null;
  readonly sourceLocation: string | null;
  readonly community: number | null;
  readonly symbols: ReadonlyArray<GoAgentGraphNode>;
  readonly changed: "added" | "removed" | null;
  readonly x: number;
  readonly y: number;
}

export interface FileGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly relation: string;
  /** Weakest evidence among the merged symbol-level edges, so a merged edge never looks surer than its parts. */
  readonly evidence: GoAgentEvidence;
  readonly count: number;
  readonly examples: ReadonlyArray<GoAgentGraphEdge>;
  readonly changed: "added" | "removed" | null;
}

const EVIDENCE_RANK: Record<GoAgentEvidence, number> = {
  explicit_human: 3,
  verified_static: 2,
  inferred: 1,
  ambiguous: 0,
};

const COLUMN_WIDTH = 260;
const ROW_HEIGHT = 90;

/**
 * Collapses Graphify's symbol graph to one node per file (plus rationale and concept nodes),
 * merging symbol edges into file-to-file edges. `delta` marks what a mission task added or removed.
 */
export function buildFileGraph(
  nodes: ReadonlyArray<GoAgentGraphNode>,
  edges: ReadonlyArray<GoAgentGraphEdge>,
  options: { readonly delta?: GoAgentGraphDelta | null; readonly showConcepts?: boolean } = {},
): { readonly nodes: ReadonlyArray<FileGraphNode>; readonly edges: ReadonlyArray<FileGraphEdge> } {
  const delta = options.delta ?? null;
  const allNodes =
    delta === null
      ? nodes
      : [...nodes, ...delta.removedNodes.filter((n) => !nodes.some((m) => m.id === n.id))];
  const addedIds = new Set(delta?.addedNodes.map((n) => n.id) ?? []);
  const removedIds = new Set(delta?.removedNodes.map((n) => n.id) ?? []);
  const fileNodes = allNodes.filter((n) => n.kind === "file");
  const fileByPath = new Map(fileNodes.map((n) => [n.sourceFile ?? n.id, n]));
  // Each node is shown as itself (file, rationale, concept) or folded into the file that contains it.
  const ownerOf = new Map<string, string>();
  for (const node of allNodes) {
    if (node.kind === "file" || node.kind === "rationale") ownerOf.set(node.id, node.id);
    else if (node.kind === "concept") {
      if (options.showConcepts === true) ownerOf.set(node.id, node.id);
    } else {
      const owner = node.sourceFile === null ? undefined : fileByPath.get(node.sourceFile);
      if (owner !== undefined) ownerOf.set(node.id, owner.id);
    }
  }
  const visible = allNodes.filter((n) => ownerOf.get(n.id) === n.id);
  const symbolsByOwner = new Map<string, Array<GoAgentGraphNode>>();
  for (const node of allNodes) {
    const owner = ownerOf.get(node.id);
    if (owner === undefined || owner === node.id) continue;
    symbolsByOwner.set(owner, [...(symbolsByOwner.get(owner) ?? []), node]);
  }
  const changedOf = (node: GoAgentGraphNode): FileGraphNode["changed"] => {
    if (addedIds.has(node.id)) return "added";
    if (removedIds.has(node.id)) return "removed";
    const symbols = symbolsByOwner.get(node.id) ?? [];
    if (symbols.some((s) => addedIds.has(s.id))) return "added";
    return null;
  };

  const addedEdgeKeys = new Set(delta?.addedEdges.map(edgeKey) ?? []);
  const removedEdgeKeys = new Set(delta?.removedEdges.map(edgeKey) ?? []);
  const merged = new Map<
    string,
    { edge: Omit<FileGraphEdge, "count" | "examples">; examples: Array<GoAgentGraphEdge> }
  >();
  const edgeSource = delta === null ? edges : [...edges, ...delta.removedEdges];
  for (const edge of edgeSource) {
    const source = ownerOf.get(edge.source);
    const target = ownerOf.get(edge.target);
    if (source === undefined || target === undefined || source === target) continue;
    if (edge.relation === "contains") continue;
    const id = `${source}->${target}:${edge.relation}`;
    const changed = addedEdgeKeys.has(edgeKey(edge))
      ? "added"
      : removedEdgeKeys.has(edgeKey(edge))
        ? "removed"
        : null;
    const existing = merged.get(id);
    if (existing === undefined) {
      merged.set(id, {
        edge: { id, source, target, relation: edge.relation, evidence: edge.evidence, changed },
        examples: [edge],
      });
    } else {
      existing.examples.push(edge);
      if (EVIDENCE_RANK[edge.evidence] < EVIDENCE_RANK[existing.edge.evidence])
        existing.edge = { ...existing.edge, evidence: edge.evidence };
      if (changed === "added" && existing.edge.changed === null)
        existing.edge = { ...existing.edge, changed };
    }
  }

  // Columns by Graphify community (subsystem), rows by path within a column.
  const communities = [...new Set(visible.map((n) => n.community ?? -1))].toSorted((a, b) => a - b);
  const positioned = communities.flatMap((community, column) =>
    visible
      .filter((n) => (n.community ?? -1) === community)
      .toSorted((a, b) => (a.sourceFile ?? a.label).localeCompare(b.sourceFile ?? b.label))
      .map((node, row): FileGraphNode => ({
        id: node.id,
        label: node.label,
        kind: node.kind,
        sourceFile: node.sourceFile,
        sourceLocation: node.sourceLocation,
        community: node.community,
        symbols: symbolsByOwner.get(node.id) ?? [],
        changed: changedOf(node),
        x: column * COLUMN_WIDTH,
        y: row * ROW_HEIGHT,
      })),
  );
  return {
    nodes: positioned,
    edges: [...merged.values()].map(({ edge, examples }) => ({
      ...edge,
      count: examples.length,
      examples: examples.slice(0, 10),
    })),
  };
}

const edgeKey = (edge: Pick<GoAgentGraphEdge, "source" | "target" | "relation">) =>
  `${edge.source}\u0000${edge.target}\u0000${edge.relation}`;

export type DagNodeKind = "route" | "plan" | "contract" | "task" | "integrate" | "verify";

export interface DagNode {
  readonly id: string;
  readonly kind: DagNodeKind;
  readonly label: string;
  readonly state: string;
  readonly detail: string | null;
  readonly taskKey: string | null;
  readonly x: number;
  readonly y: number;
}

export interface DagEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string | null;
}

/** The mission as a left-to-right DAG; every state shown comes from the snapshot, nothing is inferred. */
export function buildMissionDag(snapshot: GoAgentMissionSnapshot): {
  readonly nodes: ReadonlyArray<DagNode>;
  readonly edges: ReadonlyArray<DagEdge>;
} {
  const { mission, tasks, contracts, decisions, verificationRuns } = snapshot;
  const route = decisions.find((d) => d.key === "mission.route");
  const contract = contracts.at(-1) ?? null;
  const usesContract = mission.plan.tasks.some(
    (t) => t.proposesContract || t.dependsOn.includes(GOAGENT_CONTRACT_DEPENDENCY),
  );
  const lastRun = verificationRuns.at(-1) ?? null;
  const nodes: Array<DagNode> = [];
  const edges: Array<DagEdge> = [];
  const column = (index: number) => index * 240;

  nodes.push({
    id: "route",
    kind: "route",
    label: "Route",
    state: route === undefined ? "pending" : route.answer,
    detail:
      route === undefined
        ? null
        : `${route.source}${route.confidence === null ? "" : ` · ${Math.round(route.confidence * 100)}%`}`,
    taskKey: null,
    x: column(0),
    y: 0,
  });
  nodes.push({
    id: "plan",
    kind: "plan",
    label: `Plan v${mission.planVersion}`,
    state: mission.state === "planned" ? "draft" : "approved",
    detail: `${mission.plan.tasks.length} task(s)`,
    taskKey: null,
    x: column(1),
    y: 0,
  });
  edges.push({ id: "route-plan", source: "route", target: "plan", label: null });

  // Columns: route, plan, independent tasks, contract, tasks that wait for the contract.
  if (usesContract) {
    const acked =
      contract === null ? 0 : contract.acks.filter((a) => a.version === contract.version).length;
    nodes.push({
      id: "contract",
      kind: "contract",
      label: contract === null ? "Contract" : `Contract v${contract.version}`,
      state: contract === null ? "not proposed" : acked > 0 ? "acknowledged" : "proposed",
      detail: contract === null ? null : `${contract.spec.method} ${contract.spec.path}`,
      taskKey: null,
      x: column(3),
      y: 0,
    });
  }

  const planTasks = mission.plan.tasks;
  planTasks.forEach((planTask, index) => {
    const task = tasks.find((t) => t.key === planTask.key);
    const depth = planTask.dependsOn.some((d) => d !== GOAGENT_CONTRACT_DEPENDENCY) ? 1 : 0;
    const waitsForContract = planTask.dependsOn.includes(GOAGENT_CONTRACT_DEPENDENCY);
    const id = `task:${planTask.key}`;
    nodes.push({
      id,
      kind: "task",
      label: planTask.title,
      state:
        task?.state ??
        (mission.state === "planned" || mission.state === "approved" ? "draft" : "queued"),
      detail:
        task === undefined || task.blockedOn.length === 0
          ? planTask.key
          : `waits for ${task.blockedOn.join(", ")}`,
      taskKey: planTask.key,
      x: column((waitsForContract ? 4 : 2) + depth),
      y: index * 140 - ((planTasks.length - 1) * 140) / 2,
    });
    edges.push({ id: `plan-${id}`, source: "plan", target: id, label: null });
    if (planTask.proposesContract)
      edges.push({ id: `${id}-contract`, source: id, target: "contract", label: "proposes" });
    if (planTask.dependsOn.includes(GOAGENT_CONTRACT_DEPENDENCY))
      edges.push({ id: `contract-${id}`, source: "contract", target: id, label: "unblocks" });
    for (const dependency of planTask.dependsOn) {
      if (dependency === GOAGENT_CONTRACT_DEPENDENCY) continue;
      edges.push({
        id: `task:${dependency}-${id}`,
        source: `task:${dependency}`,
        target: id,
        label: "then",
      });
    }
  });

  const lastTaskColumn = Math.max(...nodes.map((n) => n.x)) / 240;
  nodes.push({
    id: "integrate",
    kind: "integrate",
    label: "Integrate",
    state: mission.integration.status,
    detail:
      mission.integration.conflictFiles.length > 0
        ? `conflicts: ${mission.integration.conflictFiles.join(", ")}`
        : null,
    taskKey: null,
    x: column(lastTaskColumn + 1),
    y: 0,
  });
  for (const planTask of planTasks)
    edges.push({
      id: `task:${planTask.key}-integrate`,
      source: `task:${planTask.key}`,
      target: "integrate",
      label: null,
    });
  nodes.push({
    id: "verify",
    kind: "verify",
    label: "Verify",
    state: lastRun === null ? "not run" : lastRun.status,
    detail:
      lastRun === null
        ? null
        : `${lastRun.commandId}${lastRun.exitCode === null ? "" : ` · exit ${lastRun.exitCode}`}`,
    taskKey: null,
    x: column(lastTaskColumn + 2),
    y: 0,
  });
  edges.push({ id: "integrate-verify", source: "integrate", target: "verify", label: null });
  return { nodes, edges };
}
