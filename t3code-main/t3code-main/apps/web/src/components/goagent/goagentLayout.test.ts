import type {
  GoAgentGraphEdge,
  GoAgentGraphNode,
  GoAgentMissionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildFileGraph, buildMissionDag } from "./goagentLayout";

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
