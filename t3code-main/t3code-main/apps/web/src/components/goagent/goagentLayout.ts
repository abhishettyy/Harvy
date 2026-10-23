import { GOAGENT_CONTRACT_DEPENDENCY, type GoAgentMissionSnapshot } from "@t3tools/contracts";

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
