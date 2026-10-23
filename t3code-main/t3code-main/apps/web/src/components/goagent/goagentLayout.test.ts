import type { GoAgentMissionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentActivity, buildMissionDag, nextStep } from "./goagentLayout";

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
