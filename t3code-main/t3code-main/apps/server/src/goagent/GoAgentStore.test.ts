import {
  GoAgentEventId,
  GoAgentMissionId,
  GoAgentProjectDecisionId,
  GoAgentScanId,
  ProjectId,
  ThreadId,
  type GoAgentGraphScan,
  type GoAgentMission,
  type GoAgentTask,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as GoAgentStore from "./GoAgentStore.ts";

const layer = GoAgentStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const projectId = ProjectId.make("project-1");
const missionId = GoAgentMissionId.make("mission-1");

const scan = (scanId: string, startedAt: string, commitSha: string): GoAgentGraphScan => ({
  scanId: GoAgentScanId.make(scanId),
  projectId,
  scope: "base",
  missionId: null,
  taskKey: null,
  commitSha,
  status: "completed",
  graphifyVersion: "0.9.93",
  schemaVersion: 1,
  nodeCount: 2,
  edgeCount: 1,
  startedAt,
  finishedAt: startedAt,
  failure: null,
});

const mission: GoAgentMission = {
  missionId,
  projectId,
  title: "Edit profile",
  request: "Add edit profile",
  state: "planned",
  plan: {
    title: "Edit profile",
    constraints: [],
    contract: null,
    tasks: [],
    verificationCommandIds: [],
  },
  planVersion: 1,
  baseSha: null,
  baseScanId: null,
  integration: {
    status: "not_started",
    worktreePath: null,
    headSha: null,
    appliedTasks: [],
    conflictFiles: [],
    failure: null,
    scanId: null,
  },
  failureReason: null,
  createdAt: "2026-10-22T10:00:00.000Z",
  updatedAt: "2026-10-22T10:00:00.000Z",
};

const event = (id: string) => ({
  eventId: GoAgentEventId.make(id),
  missionId,
  type: "mission.created" as const,
  actor: "user",
  causedBy: null,
  summary: id,
  payload: { id },
  occurredAt: "2026-10-22T10:00:00.000Z",
});

describe("GoAgentStore", () => {
  it.effect("stores a scan graph and replaces it on re-completion without duplicates", () =>
    Effect.gen(function* () {
      const store = yield* GoAgentStore.GoAgentStore;
      const base = scan("scan-1", "2026-10-22T10:00:00.000Z", "abc");
      const graph = {
        nodes: [
          {
            id: "a",
            label: "a.ts",
            kind: "file" as const,
            sourceFile: "a.ts",
            sourceLocation: "L1",
            community: 0,
          },
          {
            id: "b",
            label: "b.ts",
            kind: "file" as const,
            sourceFile: "b.ts",
            sourceLocation: "L1",
            community: 0,
          },
        ],
        edges: [
          {
            source: "a",
            target: "b",
            relation: "imports",
            evidence: "verified_static" as const,
            confidenceScore: 1,
            sourceFile: "a.ts",
            sourceLocation: "L2",
          },
        ],
      };
      yield* store.putScan({ ...base, status: "running" });
      yield* store.completeScan(base, graph);
      yield* store.completeScan(base, graph);
      const rows = yield* store.getScanGraph(base.scanId);
      assert.deepStrictEqual(rows, graph);
      assert.deepStrictEqual(yield* store.getScan(base.scanId), Option.some(base));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns the latest completed scan per scope", () =>
    Effect.gen(function* () {
      const store = yield* GoAgentStore.GoAgentStore;
      yield* store.putScan(scan("old", "2026-10-22T09:00:00.000Z", "aaa"));
      yield* store.putScan(scan("new", "2026-10-22T11:00:00.000Z", "bbb"));
      yield* store.putScan({
        ...scan("failed", "2026-10-22T12:00:00.000Z", "ccc"),
        status: "failed",
      });
      const latest = yield* store.latestScan({ projectId, scope: "base", status: "completed" });
      assert.strictEqual(Option.getOrNull(latest)?.scanId, "new");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("assigns per-mission event sequences and rejects duplicate event ids", () =>
    Effect.gen(function* () {
      const store = yield* GoAgentStore.GoAgentStore;
      yield* store.putMission(mission);
      const first = yield* store.appendEvent(event("e1"));
      const second = yield* store.appendEvent(event("e2"));
      assert.deepStrictEqual([first.sequence, second.sequence], [1, 2]);
      const duplicate = yield* Effect.exit(store.appendEvent(event("e1")));
      assert.isTrue(Exit.isFailure(duplicate));
      const events = yield* store.listEvents(missionId, 1);
      assert.deepStrictEqual(
        events.map((e) => e.eventId),
        ["e2"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists active project decisions and retires one only in its own project", () =>
    Effect.gen(function* () {
      const store = yield* GoAgentStore.GoAgentStore;
      const decision = (id: string, createdAt: string) => ({
        decisionId: GoAgentProjectDecisionId.make(id),
        projectId,
        text: `Rule ${id}`,
        author: "user" as const,
        sourceFile: null,
        createdAt,
      });
      yield* store.putProjectDecision(decision("b", "2026-10-22T10:00:00.000Z"));
      yield* store.putProjectDecision(decision("a", "2026-10-22T09:00:00.000Z"));
      const other = ProjectId.make("project-2");
      assert.isFalse(
        yield* store.retireProjectDecision({
          projectId: other,
          decisionId: GoAgentProjectDecisionId.make("a"),
          retiredAt: "2026-10-22T11:00:00.000Z",
        }),
      );
      assert.isTrue(
        yield* store.retireProjectDecision({
          projectId,
          decisionId: GoAgentProjectDecisionId.make("a"),
          retiredAt: "2026-10-22T11:00:00.000Z",
        }),
      );
      const active = yield* store.listProjectDecisions(projectId);
      assert.deepStrictEqual(
        active.map((d) => d.decisionId),
        ["b"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds a task by its agent thread", () =>
    Effect.gen(function* () {
      const store = yield* GoAgentStore.GoAgentStore;
      yield* store.putMission(mission);
      const task: GoAgentTask = {
        missionId,
        key: "backend",
        title: "Server",
        role: "backend",
        state: "running",
        blockedOn: [],
        threadId: ThreadId.make("thread-1"),
        worktreePath: null,
        branch: null,
        headSha: null,
        changedFiles: [],
        scanId: null,
        failureReason: null,
        startedAt: null,
        finishedAt: null,
      };
      yield* store.putTask(task);
      yield* store.putTask({ ...task, state: "completed" });
      const found = yield* store.findTaskByThread(ThreadId.make("thread-1"));
      assert.strictEqual(Option.getOrNull(found)?.state, "completed");
      assert.strictEqual((yield* store.listTasks(missionId)).length, 1);
    }).pipe(Effect.provide(layer)),
  );
});
