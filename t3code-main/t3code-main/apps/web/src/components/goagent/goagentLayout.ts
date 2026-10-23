import {
  GOAGENT_CONTRACT_DEPENDENCY,
  type GoAgentEvidence,
  type GoAgentGraphDelta,
  type GoAgentGraphEdge,
  type GoAgentGraphNode,
  type GoAgentMissionSnapshot,
} from "@t3tools/contracts";

/** Which part of the app a node belongs to; the graph is laid out in one lane per area. */
export type GraphArea = "decision" | "server" | "tests" | "client" | "other";

/** Lane order, left to right: decisions govern the server, tests sit between server and client. */
export const GRAPH_AREAS: ReadonlyArray<{ readonly area: GraphArea; readonly label: string }> = [
  { area: "decision", label: "Project decisions" },
  { area: "server", label: "Server" },
  { area: "tests", label: "Tests" },
  { area: "client", label: "Client" },
  { area: "other", label: "Config & other" },
];

const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "e2e"]);
const SERVER_SEGMENTS = new Set(["server", "api", "backend", "routes", "db", "services"]);
const CLIENT_SEGMENTS = new Set(["web", "client", "frontend", "ui", "components", "pages", "app"]);

export function graphAreaOf(node: Pick<GoAgentGraphNode, "kind" | "sourceFile">): GraphArea {
  if (node.kind === "decision") return "decision";
  const path = (node.sourceFile ?? "").toLowerCase();
  const dirs = path.split("/").slice(0, -1);
  if (dirs.some((d) => TEST_SEGMENTS.has(d)) || /\.(test|spec)\.[a-z]+$/.test(path)) return "tests";
  // The outermost directory decides: web/src/api/x.ts is client code that calls an API.
  for (const dir of dirs) {
    if (SERVER_SEGMENTS.has(dir)) return "server";
    if (CLIENT_SEGMENTS.has(dir)) return "client";
  }
  if (/\.(tsx|jsx|vue|svelte|css)$/.test(path)) return "client";
  return "other";
}

export interface GraphLane {
  readonly area: GraphArea;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly count: number;
}

export interface FileGraphNode {
  readonly id: string;
  readonly label: string;
  readonly kind: GoAgentGraphNode["kind"];
  readonly area: GraphArea;
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

export const GRAPH_NODE_WIDTH = 230;
const COLUMN_WIDTH = 260;
const ROW_HEIGHT = 86;
const ROWS_PER_COLUMN = 9;
const LANE_GAP = 70;
const LANE_PADDING = 20;
const LANE_HEADER = 44;

/**
 * Collapses Graphify's symbol graph to one node per file (plus rationale and concept nodes),
 * merging symbol edges into file-to-file edges. `delta` marks what a mission task added or removed.
 */
export function buildFileGraph(
  nodes: ReadonlyArray<GoAgentGraphNode>,
  edges: ReadonlyArray<GoAgentGraphEdge>,
  options: { readonly delta?: GoAgentGraphDelta | null; readonly showConcepts?: boolean } = {},
): {
  readonly nodes: ReadonlyArray<FileGraphNode>;
  readonly edges: ReadonlyArray<FileGraphEdge>;
  readonly lanes: ReadonlyArray<GraphLane>;
} {
  const delta = options.delta ?? null;
  const allNodes =
    delta === null
      ? nodes
      : [...nodes, ...delta.removedNodes.filter((n) => !nodes.some((m) => m.id === n.id))];
  const addedIds = new Set(delta?.addedNodes.map((n) => n.id) ?? []);
  const removedIds = new Set(delta?.removedNodes.map((n) => n.id) ?? []);
  const fileNodes = allNodes.filter((n) => n.kind === "file");
  const fileByPath = new Map(fileNodes.map((n) => [n.sourceFile ?? n.id, n]));
  // Each node is shown as itself (file, rationale, decision, concept) or folded into the file that
  // contains it.
  const ownerOf = new Map<string, string>();
  for (const node of allNodes) {
    if (node.kind === "file" || node.kind === "rationale" || node.kind === "decision")
      ownerOf.set(node.id, node.id);
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

  // One lane per app area, left to right; within a lane, files sorted by path, wrapping into
  // sub-columns so a big area stays readable without scrolling forever.
  const positioned: Array<FileGraphNode> = [];
  const lanes: Array<GraphLane> = [];
  let laneX = 0;
  for (const { area, label } of GRAPH_AREAS) {
    const members = visible
      .filter((n) => graphAreaOf(n) === area)
      .toSorted((a, b) => (a.sourceFile ?? a.label).localeCompare(b.sourceFile ?? b.label));
    if (members.length === 0) continue;
    const columns = Math.ceil(members.length / ROWS_PER_COLUMN);
    const rows = Math.min(members.length, ROWS_PER_COLUMN);
    members.forEach((node, index) => {
      positioned.push({
        id: node.id,
        label: node.label,
        kind: node.kind,
        area,
        sourceFile: node.sourceFile,
        sourceLocation: node.sourceLocation,
        community: node.community,
        symbols: symbolsByOwner.get(node.id) ?? [],
        changed: changedOf(node),
        x: laneX + LANE_PADDING + Math.floor(index / ROWS_PER_COLUMN) * COLUMN_WIDTH,
        y: LANE_HEADER + (index % ROWS_PER_COLUMN) * ROW_HEIGHT,
      });
    });
    const width = (columns - 1) * COLUMN_WIDTH + GRAPH_NODE_WIDTH + LANE_PADDING * 2;
    lanes.push({
      area,
      label,
      x: laneX,
      y: 0,
      width,
      height: LANE_HEADER + rows * ROW_HEIGHT + LANE_PADDING,
      count: members.length,
    });
    laneX += width + LANE_GAP;
  }
  return {
    lanes,
    nodes: positioned,
    edges: [...merged.values()].map(({ edge, examples }) => ({
      ...edge,
      count: examples.length,
      examples: examples.slice(0, 10),
    })),
  };
}

/** A node, its direct neighbours, and the edges between them: what focus mode keeps bright. */
export function focusOf(
  edges: ReadonlyArray<Pick<FileGraphEdge, "id" | "source" | "target">>,
  nodeId: string,
): { readonly nodeIds: ReadonlySet<string>; readonly edgeIds: ReadonlySet<string> } {
  const nodeIds = new Set([nodeId]);
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    edgeIds.add(edge.id);
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }
  return { nodeIds, edgeIds };
}

/** Case-insensitive match on a node's label or path; empty queries match nothing. */
export function matchesQuery(
  node: Pick<FileGraphNode, "label" | "sourceFile">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return false;
  return node.label.toLowerCase().includes(q) || (node.sourceFile ?? "").toLowerCase().includes(q);
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

export interface AgentActivity {
  readonly taskKey: string;
  readonly title: string;
  readonly role: string;
  readonly state: string;
  readonly threadId: GoAgentMissionSnapshot["tasks"][number]["threadId"];
  /** Design decisions the agent recorded itself (goagent_record_decision). */
  readonly recorded: ReadonlyArray<{
    readonly eventId: string;
    readonly decision: string;
    readonly reason: string;
  }>;
  /** Jev coordination decisions about this agent's work or about switching work to it. */
  readonly coordination: ReadonlyArray<GoAgentMissionSnapshot["decisions"][number]>;
  readonly handoffsOut: ReadonlyArray<{
    readonly eventId: string;
    readonly to: string;
    readonly summary: string;
  }>;
  readonly handoffsIn: ReadonlyArray<{
    readonly eventId: string;
    readonly from: string;
    readonly summary: string;
  }>;
  readonly graphLookups: ReadonlyArray<{ readonly eventId: string; readonly summary: string }>;
  /** Knowledge-graph coupling to other agents, e.g. `uses backend (3 graph links)`. */
  readonly coupling: ReadonlyArray<string>;
}

const textOf = (value: unknown) => (typeof value === "string" ? value : "");
const links = (count: number) => `${count} graph link${count === 1 ? "" : "s"}`;

/** Groups a mission's events and decisions by the agent they concern, one entry per task. */
export function agentActivity(snapshot: GoAgentMissionSnapshot): ReadonlyArray<AgentActivity> {
  const coupling = snapshot.mission.plan.coupling ?? [];
  const handoffs = snapshot.events.filter((e) => e.type === "handoff.sent");
  return snapshot.tasks.map((task) => {
    const actor = `task:${task.key}`;
    return {
      taskKey: task.key,
      title: task.title,
      role: task.role,
      state: task.state,
      threadId: task.threadId,
      recorded: snapshot.events
        .filter((e) => e.type === "agent.decision" && e.actor === actor)
        .map((e) => ({
          eventId: e.eventId,
          decision: textOf(e.payload.decision),
          reason: textOf(e.payload.reason),
        })),
      coordination: snapshot.decisions.filter(
        (d) => d.taskKey === task.key || d.targetTaskKey === task.key,
      ),
      handoffsOut: handoffs
        .filter((e) => e.payload.from === task.key)
        .map((e) => ({ eventId: e.eventId, to: textOf(e.payload.to), summary: e.summary })),
      handoffsIn: handoffs
        .filter((e) => e.payload.to === task.key)
        .map((e) => ({ eventId: e.eventId, from: textOf(e.payload.from), summary: e.summary })),
      graphLookups: snapshot.events
        .filter((e) => e.type === "graph.queried" && e.actor === actor)
        .map((e) => ({ eventId: e.eventId, summary: e.summary })),
      coupling: coupling.flatMap((c) =>
        c.from === task.key
          ? [`uses ${c.to} (${links(c.edgeCount)})`]
          : c.to === task.key
            ? [`used by ${c.from} (${links(c.edgeCount)})`]
            : [],
      ),
    };
  });
}

export interface NextStep {
  readonly tone: "action" | "waiting" | "done" | "problem";
  readonly title: string;
  readonly detail: string;
}

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "" : ` (${Math.round(value * 100)}%)`;

/** What the user should do next on a mission, in plain words, derived only from its state. */
export function nextStep(
  snapshot: GoAgentMissionSnapshot,
  options: { readonly agentModelMissing?: boolean } = {},
): NextStep {
  const { mission, tasks } = snapshot;
  const planned = mission.plan.tasks.length;
  const risk = snapshot.decisions.findLast((d) => d.key === "mission.risk");
  const lastRun = snapshot.verificationRuns.at(-1);
  const owner = snapshot.decisions.findLast((d) => d.key === "failure.owner");
  switch (mission.state) {
    case "planned":
      return {
        tone: "action",
        title: "Review the plan, then click Approve plan",
        detail: `${planned} agent${planned === 1 ? "" : "s"} will work in parallel. Edit what each one owns below if needed.`,
      };
    case "approved":
      if (options.agentModelMissing === true)
        return {
          tone: "problem",
          title: "Set a default model before starting",
          detail:
            "This project has no default model, so no agent can launch. Choose one in Settings → Projects, then click Start agents.",
        };
      return {
        tone: "action",
        title: "Click Start agents",
        detail: `Launches ${planned} agent${planned === 1 ? "" : "s"}, each in its own git worktree from the current commit.`,
      };
    case "running": {
      if (snapshot.coordinating === true)
        return {
          tone: "waiting",
          title: "Coordinating agents…",
          detail:
            "GoAgent is updating the knowledge graph and deciding handoffs for a finished agent.",
        };
      const done = tasks.filter((t) => t.state === "completed").length;
      if (tasks.length > 0 && done === tasks.length)
        return {
          tone: "action",
          title: "All agents finished — click Integrate",
          detail:
            "Their commits are combined in a separate integration worktree; your checkout is not touched.",
        };
      const blocked = tasks.filter((t) => t.state === "blocked").map((t) => t.key);
      const active = tasks.filter((t) => t.state === "running").map((t) => t.key);
      const failed = tasks.filter((t) => t.state === "failed").map((t) => t.key);
      if (failed.length > 0)
        return {
          tone: "problem",
          title: `${failed.join(", ")} failed`,
          detail: "Open the agent's thread to see why, or cancel the mission.",
        };
      return {
        tone: "waiting",
        title: `${active.length} agent${active.length === 1 ? "" : "s"} working (${done}/${tasks.length} done)`,
        detail:
          blocked.length > 0
            ? `${blocked.join(", ")} wait${blocked.length === 1 ? "s" : ""} for the API contract from the backend agent.`
            : "Follow each agent in Agent decisions or open its thread.",
      };
    }
    case "integrating":
      return {
        tone: "waiting",
        title: "Integrating…",
        detail: "Applying each agent's commits in order.",
      };
    case "verifying":
      return {
        tone: "action",
        title: "Integrated — click Run verification",
        detail: "Runs the approved commands on the combined code.",
      };
    case "needs_review":
      if (mission.baseSha === null)
        return {
          tone: "action",
          title: "High risk — review, then click Approve despite high risk",
          detail: `Jev rated this plan ${risk?.answer ?? "high"} risk${pct(risk?.confidence)}. Check the agents and the paths they own below, then approve to continue, or cancel.`,
        };
      if (mission.integration.status === "conflict")
        return {
          tone: "problem",
          title: "Integration conflict",
          detail: `Conflicting files: ${mission.integration.conflictFiles.join(", ") || "see the audit"}. Fix them in the agent's worktree, commit, then Integrate again.`,
        };
      if (lastRun !== undefined && lastRun.status !== "passed" && lastRun.status !== "running")
        return {
          tone: "problem",
          title: `Verification ${lastRun.status.replace("_", " ")}`,
          detail:
            owner !== undefined && owner.answer !== "unknown"
              ? `Likely owner: ${owner.answer}${pct(owner.confidence)}. Click Send repair to let that agent fix it.`
              : "See the Verify tab for the output.",
        };
      return {
        tone: "problem",
        title: "Needs your review",
        detail: mission.failureReason ?? "See the Audit tab for what happened.",
      };
    case "completed":
      return {
        tone: "done",
        title: "Mission complete",
        detail:
          "All approved checks passed on the integrated code. Agent worktrees are kept for you to review or merge.",
      };
    case "cancelled":
      return {
        tone: "done",
        title: "Cancelled",
        detail: "Agents were stopped; worktrees are kept.",
      };
    case "failed":
    case "interrupted":
      return {
        tone: "problem",
        title: mission.state === "failed" ? "Mission failed" : "Interrupted",
        detail: mission.failureReason ?? "See the Audit tab.",
      };
  }
}
