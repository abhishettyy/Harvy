import type {
  GoAgentGraphEdge,
  GoAgentGraphNode,
  GoAgentMissionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentActivity,
  buildFileGraph,
  buildMissionDag,
  focusOf,
  graphAreaOf,
  matchesQuery,
  nextStep,
} from "./goagentLayout";

const node = (
  id: string,
  kind: GoAgentGraphNode["kind"],
  sourceFile: string,
  label = id,
  community = 0,
): GoAgentGraphNode => ({
  id,
  label,
  kind,
  sourceFile,
  sourceLocation: "L1",
  community,
});

const edge = (
  source: string,
  target: string,
  relation: string,
  evidence: GoAgentGraphEdge["evidence"] = "verified_static",
): GoAgentGraphEdge => ({
  source,
  target,
  relation,
  evidence,
  confidenceScore: evidence === "verified_static" ? 1 : 0.7,
  sourceFile: null,
  sourceLocation: null,
});

const nodes = [
  node("app", "file", "server/app.ts", "app.ts"),
  node("app_create", "symbol", "server/app.ts", "createApp()"),
  node("profile", "file", "server/routes/profile.ts", "profile.ts", 1),
  node("profile_router", "symbol", "server/routes/profile.ts", "profileRouter()", 1),
  node("profile_get", "symbol", "server/routes/profile.ts", "getProfile()", 1),
  node("ref_express", "concept", "package.json", "express"),
];

describe("buildFileGraph", () => {
  it("folds symbols into their files and merges edges with the weakest evidence", () => {
    const graph = buildFileGraph(nodes, [
      edge("app", "profile_router", "imports"),
      edge("app_create", "profile_router", "calls"),
      edge("app_create", "profile_get", "calls", "inferred"),
      edge("profile", "profile_router", "contains"),
    ]);
    expect(graph.nodes.map((n) => [n.id, n.symbols.length])).toEqual([
      ["app", 1],
      ["profile", 2],
    ]);
    expect(graph.edges.map((e) => [e.id, e.count, e.evidence])).toEqual([
      ["app->profile:imports", 1, "verified_static"],
      ["app->profile:calls", 2, "inferred"],
    ]);
  });

  it("shows project decisions as their own nodes with governs edges", () => {
    const decision: GoAgentGraphNode = {
      id: "decision:d1",
      label: "Use the existing JWT auth",
      kind: "decision",
      sourceFile: "DECISIONS.md",
      sourceLocation: null,
      community: null,
    };
    const graph = buildFileGraph(
      [...nodes, decision],
      [edge("decision:d1", "app", "governs", "explicit_human")],
    );
    expect(graph.nodes.some((n) => n.id === "decision:d1")).toBe(true);
    expect(graph.edges.map((e) => [e.id, e.evidence])).toEqual([
      ["decision:d1->app:governs", "explicit_human"],
    ]);
  });

  it("marks files whose symbols a task added", () => {
    const added = node("profile_patch", "symbol", "server/routes/profile.ts", "updateProfile()", 1);
    const graph = buildFileGraph([...nodes, added], [], {
      delta: {
        baseScanId: "a" as never,
        scanId: "b" as never,
        addedNodes: [added],
        removedNodes: [],
        addedEdges: [],
        removedEdges: [],
      },
    });
    expect(graph.nodes.find((n) => n.id === "profile")?.changed).toBe("added");
    expect(graph.nodes.find((n) => n.id === "app")?.changed).toBeNull();
  });

  it("hides package concepts unless asked", () => {
    expect(buildFileGraph(nodes, []).nodes.some((n) => n.kind === "concept")).toBe(false);
    expect(
      buildFileGraph(nodes, [], { showConcepts: true }).nodes.some((n) => n.kind === "concept"),
    ).toBe(true);
  });
});

describe("buildMissionDag", () => {
  const snapshot = {
    mission: {
      missionId: "m",
      projectId: "p",
      title: "Edit profile",
      request: "Add edit profile",
      state: "running",
      planVersion: 2,
      baseSha: "abc",
      baseScanId: null,
      failureReason: null,
      createdAt: "",
      updatedAt: "",
      integration: {
        status: "not_started",
        worktreePath: null,
        headSha: null,
        appliedTasks: [],
        conflictFiles: [],
        failure: null,
        scanId: null,
      },
      plan: {
        title: "Edit profile",
        constraints: [],
        contract: null,
        verificationCommandIds: [],
        tasks: [
          {
            key: "backend",
            title: "Server",
            role: "backend",
            brief: "",
            ownsPaths: [],
            dependsOn: [],
            proposesContract: true,
          },
          {
            key: "frontend",
            title: "Client",
            role: "frontend",
            brief: "",
            ownsPaths: [],
            dependsOn: ["contract"],
            proposesContract: false,
          },
        ],
      },
    },
    tasks: [
      { key: "backend", state: "running", blockedOn: [] },
      { key: "frontend", state: "blocked", blockedOn: ["contract"] },
    ],
    contracts: [],
    decisions: [],
    verificationRuns: [],
    events: [],
  } as unknown as GoAgentMissionSnapshot;

  it("shows real task states and the contract gate between tasks", () => {
    const dag = buildMissionDag(snapshot);
    const byId = new Map(dag.nodes.map((n) => [n.id, n]));
    expect(byId.get("task:backend")?.state).toBe("running");
    expect(byId.get("task:frontend")?.state).toBe("blocked");
    expect(byId.get("task:frontend")?.detail).toBe("waits for contract");
    expect(byId.get("contract")?.state).toBe("not proposed");
    expect(byId.get("verify")?.state).toBe("not run");
    expect(dag.edges.map((e) => e.id)).toContain("contract-task:frontend");
    expect(byId.get("contract")!.x).toBeGreaterThan(byId.get("task:backend")!.x);
    expect(byId.get("task:frontend")!.x).toBeGreaterThan(byId.get("contract")!.x);
  });
});

describe("agentActivity", () => {
  it("gives each agent its own decisions, coordination, handoffs and graph coupling", () => {
    const event = (type: string, actor: string, summary: string, payload: object) => ({
      eventId: `${type}-${actor}-${summary}`,
      missionId: "m",
      sequence: 1,
      type,
      actor,
      causedBy: null,
      summary,
      payload,
      occurredAt: "",
    });
    const snapshot = {
      mission: {
        plan: { coupling: [{ from: "tests", to: "backend", edgeCount: 3, examples: [] }] },
      },
      tasks: [
        { key: "backend", title: "Server", role: "backend", state: "completed", threadId: "t1" },
        { key: "tests", title: "Tests", role: "tests", state: "running", threadId: "t2" },
      ],
      decisions: [
        {
          decisionId: "d1",
          key: "handoff.notify",
          answer: "notify",
          taskKey: "backend",
          targetTaskKey: "tests",
        },
      ],
      events: [
        event("agent.decision", "task:backend", "x", {
          decision: "Validate displayName on the server",
          reason: "Clients cannot be trusted",
        }),
        event("handoff.sent", "goagent", "Switched to tests", { from: "backend", to: "tests" }),
        event("graph.queried", "task:tests", "tests searched the graph", {}),
      ],
    } as unknown as GoAgentMissionSnapshot;
    const [backend, tests] = agentActivity(snapshot);
    expect(backend!.recorded.map((r) => r.decision)).toEqual([
      "Validate displayName on the server",
    ]);
    expect(backend!.handoffsOut.map((h) => [h.to, h.summary])).toEqual([
      ["tests", "Switched to tests"],
    ]);
    expect(backend!.coupling).toEqual(["used by tests (3 graph links)"]);
    expect(tests!.coordination.map((d) => d.decisionId)).toEqual(["d1"]);
    expect(tests!.handoffsIn.map((h) => [h.from, h.summary])).toEqual([
      ["backend", "Switched to tests"],
    ]);
    expect(tests!.graphLookups.map((l) => l.summary)).toEqual(["tests searched the graph"]);
    expect(tests!.recorded).toEqual([]);
  });
});

describe("knowledge graph lanes", () => {
  it("assigns each file to the part of the app it belongs to", () => {
    expect(graphAreaOf({ kind: "file", sourceFile: "server/routes/profile.ts" })).toBe("server");
    expect(graphAreaOf({ kind: "file", sourceFile: "web/src/api/profile.ts" })).toBe("client");
    expect(graphAreaOf({ kind: "file", sourceFile: "tests/server/profile.test.ts" })).toBe("tests");
    expect(graphAreaOf({ kind: "file", sourceFile: "vitest.config.ts" })).toBe("other");
    expect(graphAreaOf({ kind: "decision", sourceFile: "DECISIONS.md" })).toBe("decision");
  });

  it("lays files out in one lane per area, left to right, without overlap", () => {
    const graph = buildFileGraph(
      [
        node("web", "file", "web/src/App.tsx"),
        node("srv", "file", "server/app.ts"),
        node("tst", "file", "tests/server/app.test.ts"),
      ],
      [],
    );
    expect(graph.lanes.map((lane) => [lane.area, lane.count])).toEqual([
      ["server", 1],
      ["tests", 1],
      ["client", 1],
    ]);
    const x = (id: string) => graph.nodes.find((n) => n.id === id)!.x;
    expect(x("srv")).toBeLessThan(x("tst"));
    expect(x("tst")).toBeLessThan(x("web"));
    for (const [a, b] of [
      [graph.lanes[0]!, graph.lanes[1]!],
      [graph.lanes[1]!, graph.lanes[2]!],
    ] as const)
      expect(a.x + a.width).toBeLessThan(b.x);
  });

  it("focuses a file on its direct links and finds files by name or path", () => {
    const edges = [
      { id: "a->b", source: "a", target: "b" },
      { id: "c->a", source: "c", target: "a" },
      { id: "c->d", source: "c", target: "d" },
    ];
    const focus = focusOf(edges, "a");
    expect([...focus.nodeIds].toSorted()).toEqual(["a", "b", "c"]);
    expect([...focus.edgeIds].toSorted()).toEqual(["a->b", "c->a"]);
    expect(
      matchesQuery({ label: "profile.ts", sourceFile: "server/routes/profile.ts" }, "ROUTES"),
    ).toBe(true);
    expect(matchesQuery({ label: "app.ts", sourceFile: "server/app.ts" }, "  ")).toBe(false);
  });
});

describe("nextStep", () => {
  const base = {
    mission: {
      state: "needs_review",
      baseSha: null,
      plan: { tasks: [{ key: "backend" }, { key: "frontend" }, { key: "tests" }] },
      integration: { status: "not_started", conflictFiles: [] },
      failureReason: "Rated high risk by Jev; approve again to start.",
    },
    tasks: [],
    decisions: [{ key: "mission.risk", answer: "high", confidence: 1 }],
    verificationRuns: [],
    events: [],
  };

  it("tells the user to approve a plan held for high risk", () => {
    const step = nextStep(base as unknown as GoAgentMissionSnapshot);
    expect(step.tone).toBe("action");
    expect(step.title).toContain("Approve despite high risk");
    expect(step.detail).toContain("high risk (100%)");
  });

  it("tells the user to start an approved mission", () => {
    const step = nextStep({
      ...base,
      mission: { ...base.mission, state: "approved" },
    } as unknown as GoAgentMissionSnapshot);
    expect(step.title).toBe("Click Start agents");
    expect(step.detail).toContain("3 agents");
  });

  it("asks for a default model before starting when the project has none", () => {
    const step = nextStep(
      {
        ...base,
        mission: { ...base.mission, state: "approved" },
      } as unknown as GoAgentMissionSnapshot,
      { agentModelMissing: true },
    );
    expect(step.tone).toBe("problem");
    expect(step.title).toBe("Set a default model before starting");
  });
});
