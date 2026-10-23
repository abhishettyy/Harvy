import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const GoAgentMissionId = TrimmedNonEmptyString.pipe(Schema.brand("GoAgentMissionId"));
export type GoAgentMissionId = typeof GoAgentMissionId.Type;
export const GoAgentScanId = TrimmedNonEmptyString.pipe(Schema.brand("GoAgentScanId"));
export type GoAgentScanId = typeof GoAgentScanId.Type;
export const GoAgentDecisionId = TrimmedNonEmptyString.pipe(Schema.brand("GoAgentDecisionId"));
export type GoAgentDecisionId = typeof GoAgentDecisionId.Type;
export const GoAgentContractId = TrimmedNonEmptyString.pipe(Schema.brand("GoAgentContractId"));
export type GoAgentContractId = typeof GoAgentContractId.Type;
export const GoAgentEventId = TrimmedNonEmptyString.pipe(Schema.brand("GoAgentEventId"));
export const GoAgentProjectDecisionId = TrimmedNonEmptyString.pipe(
  Schema.brand("GoAgentProjectDecisionId"),
);
export type GoAgentProjectDecisionId = typeof GoAgentProjectDecisionId.Type;
export type GoAgentEventId = typeof GoAgentEventId.Type;
export const GoAgentVerificationRunId = TrimmedNonEmptyString.pipe(
  Schema.brand("GoAgentVerificationRunId"),
);
export type GoAgentVerificationRunId = typeof GoAgentVerificationRunId.Type;

/** A plan-local task key such as `backend`; unique within one mission. */
export const GoAgentTaskKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/),
);
export type GoAgentTaskKey = typeof GoAgentTaskKey.Type;

/**
 * `verified_static` is read straight from source by Graphify's AST pass, `inferred` is resolved by
 * Graphify, `ambiguous` needs review, and `explicit_human` was authored by the user.
 */
export const GoAgentEvidence = Schema.Literals([
  "verified_static",
  "inferred",
  "ambiguous",
  "explicit_human",
]);
export type GoAgentEvidence = typeof GoAgentEvidence.Type;

/** `decision` nodes are project decisions the user recorded, not read from source by Graphify. */
export const GoAgentGraphNodeKind = Schema.Literals([
  "file",
  "symbol",
  "rationale",
  "concept",
  "decision",
]);
export type GoAgentGraphNodeKind = typeof GoAgentGraphNodeKind.Type;

export const GoAgentGraphNode = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
  kind: GoAgentGraphNodeKind,
  sourceFile: Schema.NullOr(Schema.String),
  sourceLocation: Schema.NullOr(Schema.String),
  community: Schema.NullOr(Schema.Int),
});
export type GoAgentGraphNode = typeof GoAgentGraphNode.Type;

export const GoAgentGraphEdge = Schema.Struct({
  source: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  relation: TrimmedNonEmptyString,
  evidence: GoAgentEvidence,
  confidenceScore: Schema.Number,
  sourceFile: Schema.NullOr(Schema.String),
  sourceLocation: Schema.NullOr(Schema.String),
});
export type GoAgentGraphEdge = typeof GoAgentGraphEdge.Type;

export const GoAgentScanScope = Schema.Literals(["base", "task", "integration"]);
export type GoAgentScanScope = typeof GoAgentScanScope.Type;

export const GoAgentScanStatus = Schema.Literals(["running", "completed", "failed"]);
export type GoAgentScanStatus = typeof GoAgentScanStatus.Type;

export const GoAgentGraphScan = Schema.Struct({
  scanId: GoAgentScanId,
  projectId: ProjectId,
  scope: GoAgentScanScope,
  missionId: Schema.NullOr(GoAgentMissionId),
  taskKey: Schema.NullOr(GoAgentTaskKey),
  commitSha: Schema.NullOr(Schema.String),
  status: GoAgentScanStatus,
  graphifyVersion: Schema.NullOr(Schema.String),
  schemaVersion: Schema.NullOr(Schema.Int),
  nodeCount: NonNegativeInt,
  edgeCount: NonNegativeInt,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  failure: Schema.NullOr(Schema.String),
});
export type GoAgentGraphScan = typeof GoAgentGraphScan.Type;

export const GoAgentGraphSnapshot = Schema.Struct({
  scan: GoAgentGraphScan,
  nodes: Schema.Array(GoAgentGraphNode),
  edges: Schema.Array(GoAgentGraphEdge),
  truncated: Schema.Boolean,
});
export type GoAgentGraphSnapshot = typeof GoAgentGraphSnapshot.Type;

export const GoAgentGraphDelta = Schema.Struct({
  baseScanId: GoAgentScanId,
  scanId: GoAgentScanId,
  addedNodes: Schema.Array(GoAgentGraphNode),
  removedNodes: Schema.Array(GoAgentGraphNode),
  addedEdges: Schema.Array(GoAgentGraphEdge),
  removedEdges: Schema.Array(GoAgentGraphEdge),
});
export type GoAgentGraphDelta = typeof GoAgentGraphDelta.Type;

export const GoAgentDecisionKey = Schema.Literals([
  "mission.route",
  "mission.risk",
  "contract.match",
  "failure.owner",
  // Coordination micro-decisions taken while agents run (switching work between agents).
  "handoff.notify",
  "handoff.route",
]);
export type GoAgentDecisionKey = typeof GoAgentDecisionKey.Type;

export const GoAgentDecisionSource = Schema.Literals(["jev", "fallback", "human_override"]);
export type GoAgentDecisionSource = typeof GoAgentDecisionSource.Type;

export const GoAgentDecision = Schema.Struct({
  decisionId: GoAgentDecisionId,
  missionId: GoAgentMissionId,
  key: GoAgentDecisionKey,
  question: Schema.String,
  criteria: Schema.Array(Schema.String),
  answer: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.NullOr(Schema.Number),
  model: Schema.NullOr(Schema.String),
  source: GoAgentDecisionSource,
  fallbackReason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  /** The agent the decision is about (for handoffs: the agent whose work triggered it). */
  taskKey: Schema.optionalKey(GoAgentTaskKey),
  /** For handoffs: the agent the work was switched to, when one was chosen. */
  targetTaskKey: Schema.optionalKey(GoAgentTaskKey),
});
export type GoAgentDecision = typeof GoAgentDecision.Type;

export const GoAgentContractSpec = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: TrimmedNonEmptyString,
  request: Schema.String,
  response: Schema.String,
  notes: Schema.String,
});
export type GoAgentContractSpec = typeof GoAgentContractSpec.Type;

export const GoAgentTaskRole = Schema.Literals(["backend", "frontend", "tests", "fullstack"]);
export type GoAgentTaskRole = typeof GoAgentTaskRole.Type;

/** A dependency is another task key, or `contract` for "the current contract version is acked". */
export const GOAGENT_CONTRACT_DEPENDENCY = "contract" as const;

export const GoAgentPlanTask = Schema.Struct({
  key: GoAgentTaskKey,
  title: TrimmedNonEmptyString,
  role: GoAgentTaskRole,
  brief: TrimmedNonEmptyString,
  ownsPaths: Schema.Array(TrimmedNonEmptyString),
  dependsOn: Schema.Array(TrimmedNonEmptyString),
  proposesContract: Schema.Boolean,
});
export type GoAgentPlanTask = typeof GoAgentPlanTask.Type;

/**
 * How strongly two tasks' code is linked in the knowledge graph: Graphify edges (imports, calls)
 * between files one task owns and files the other owns. Drives who is told about whose changes.
 */
export const GoAgentTaskCoupling = Schema.Struct({
  from: GoAgentTaskKey,
  to: GoAgentTaskKey,
  edgeCount: NonNegativeInt,
  /** A few `file -> file (relation)` links, read from the graph, as evidence. */
  examples: Schema.Array(Schema.String),
});
export type GoAgentTaskCoupling = typeof GoAgentTaskCoupling.Type;

export const GoAgentPlan = Schema.Struct({
  title: TrimmedNonEmptyString,
  constraints: Schema.Array(Schema.String),
  contract: Schema.NullOr(GoAgentContractSpec),
  tasks: Schema.Array(GoAgentPlanTask),
  verificationCommandIds: Schema.Array(TrimmedNonEmptyString),
  coupling: Schema.optionalKey(Schema.Array(GoAgentTaskCoupling)),
});
export type GoAgentPlan = typeof GoAgentPlan.Type;

export const GoAgentTaskState = Schema.Literals([
  "queued",
  "blocked",
  "running",
  "completed",
  "failed",
  "cancelled",
  "needs_review",
  "interrupted",
]);
export type GoAgentTaskState = typeof GoAgentTaskState.Type;

export const GoAgentTask = Schema.Struct({
  missionId: GoAgentMissionId,
  key: GoAgentTaskKey,
  title: Schema.String,
  role: GoAgentTaskRole,
  state: GoAgentTaskState,
  blockedOn: Schema.Array(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  changedFiles: Schema.Array(Schema.String),
  scanId: Schema.NullOr(GoAgentScanId),
  failureReason: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type GoAgentTask = typeof GoAgentTask.Type;

export const GoAgentContractAck = Schema.Struct({
  taskKey: GoAgentTaskKey,
  version: PositiveInt,
  acknowledgedAt: IsoDateTime,
  note: Schema.String,
});
export type GoAgentContractAck = typeof GoAgentContractAck.Type;

export const GoAgentContract = Schema.Struct({
  contractId: GoAgentContractId,
  missionId: GoAgentMissionId,
  version: PositiveInt,
  spec: GoAgentContractSpec,
  proposedBy: Schema.String,
  proposedAt: IsoDateTime,
  acks: Schema.Array(GoAgentContractAck),
});
export type GoAgentContract = typeof GoAgentContract.Type;

export const GoAgentVerificationCommand = Schema.Struct({
  id: GoAgentTaskKey,
  label: TrimmedNonEmptyString,
  argv: Schema.NonEmptyArray(TrimmedNonEmptyString),
  timeoutMs: PositiveInt,
});
export type GoAgentVerificationCommand = typeof GoAgentVerificationCommand.Type;

export const GoAgentIntegrationStatus = Schema.Literals([
  "not_started",
  "running",
  "completed",
  "conflict",
  "failed",
]);
export type GoAgentIntegrationStatus = typeof GoAgentIntegrationStatus.Type;

export const GoAgentIntegration = Schema.Struct({
  status: GoAgentIntegrationStatus,
  worktreePath: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  appliedTasks: Schema.Array(GoAgentTaskKey),
  conflictFiles: Schema.Array(Schema.String),
  failure: Schema.NullOr(Schema.String),
  scanId: Schema.NullOr(GoAgentScanId),
});
export type GoAgentIntegration = typeof GoAgentIntegration.Type;

export const GoAgentVerificationStatus = Schema.Literals([
  "running",
  "passed",
  "failed",
  "timed_out",
  "not_run",
]);
export type GoAgentVerificationStatus = typeof GoAgentVerificationStatus.Type;

export const GoAgentTestSummary = Schema.Struct({
  total: NonNegativeInt,
  passed: NonNegativeInt,
  failed: NonNegativeInt,
  skipped: NonNegativeInt,
});
export type GoAgentTestSummary = typeof GoAgentTestSummary.Type;

export const GoAgentVerificationRun = Schema.Struct({
  runId: GoAgentVerificationRunId,
  missionId: GoAgentMissionId,
  commandId: Schema.String,
  argv: Schema.Array(Schema.String),
  status: GoAgentVerificationStatus,
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  outputExcerpt: Schema.String,
  testSummary: Schema.NullOr(GoAgentTestSummary),
});
export type GoAgentVerificationRun = typeof GoAgentVerificationRun.Type;

export const GoAgentMissionState = Schema.Literals([
  "planned",
  "approved",
  "running",
  "integrating",
  "verifying",
  "completed",
  "failed",
  "needs_review",
  "cancelled",
  "interrupted",
]);
export type GoAgentMissionState = typeof GoAgentMissionState.Type;

export const GoAgentMission = Schema.Struct({
  missionId: GoAgentMissionId,
  projectId: ProjectId,
  title: Schema.String,
  request: Schema.String,
  state: GoAgentMissionState,
  plan: GoAgentPlan,
  planVersion: PositiveInt,
  baseSha: Schema.NullOr(Schema.String),
  baseScanId: Schema.NullOr(GoAgentScanId),
  integration: GoAgentIntegration,
  failureReason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GoAgentMission = typeof GoAgentMission.Type;

export const GoAgentEventType = Schema.Literals([
  "mission.created",
  "decision.made",
  "decision.overridden",
  "plan.proposed",
  "plan.updated",
  "plan.approved",
  "plan.review_required",
  "mission.started",
  "task.started",
  "task.blocked",
  "task.unblocked",
  "task.completed",
  "task.failed",
  "context.built",
  "contract.proposed",
  "contract.acknowledged",
  "graph.indexed",
  "graph.delta",
  "graph.queried",
  "agent.decision",
  "handoff.sent",
  "integration.started",
  "integration.conflict",
  "integration.completed",
  "integration.failed",
  "verification.started",
  "verification.finished",
  "repair.requested",
  "mission.completed",
  "mission.failed",
  "mission.cancelled",
  "mission.interrupted",
]);
export type GoAgentEventType = typeof GoAgentEventType.Type;

export const GoAgentEvent = Schema.Struct({
  eventId: GoAgentEventId,
  missionId: GoAgentMissionId,
  sequence: PositiveInt,
  type: GoAgentEventType,
  /** `user`, `goagent`, `jev`, or `task:<key>`. */
  actor: Schema.String,
  causedBy: Schema.NullOr(GoAgentEventId),
  summary: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  occurredAt: IsoDateTime,
});
export type GoAgentEvent = typeof GoAgentEvent.Type;

export const GoAgentMissionSnapshot = Schema.Struct({
  mission: GoAgentMission,
  tasks: Schema.Array(GoAgentTask),
  contracts: Schema.Array(GoAgentContract),
  decisions: Schema.Array(GoAgentDecision),
  verificationRuns: Schema.Array(GoAgentVerificationRun),
  events: Schema.Array(GoAgentEvent),
  /**
   * True while GoAgent is still reacting to a finished agent (graph re-index, handoff decisions).
   * Integration waits for it so no agent is switched back on after its work was merged.
   */
  coordinating: Schema.optionalKey(Schema.Boolean),
});
export type GoAgentMissionSnapshot = typeof GoAgentMissionSnapshot.Type;

export const GoAgentMissionSummary = Schema.Struct({
  missionId: GoAgentMissionId,
  title: Schema.String,
  state: GoAgentMissionState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GoAgentMissionSummary = typeof GoAgentMissionSummary.Type;

export const GoAgentToolStatus = Schema.Struct({
  available: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
});
export type GoAgentToolStatus = typeof GoAgentToolStatus.Type;

/**
 * A rule the user wants every mission agent to follow ("use the existing JWT auth"). `seeded`
 * decisions were imported from a file in the repository and say which one.
 */
export const GoAgentProjectDecision = Schema.Struct({
  decisionId: GoAgentProjectDecisionId,
  projectId: ProjectId,
  text: TrimmedNonEmptyString,
  author: Schema.Literals(["user", "seeded"]),
  sourceFile: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type GoAgentProjectDecision = typeof GoAgentProjectDecision.Type;

export const GoAgentProjectState = Schema.Struct({
  projectId: ProjectId,
  graphify: GoAgentToolStatus,
  jev: GoAgentToolStatus,
  latestBaseScan: Schema.NullOr(GoAgentGraphScan),
  verificationCommands: Schema.Array(GoAgentVerificationCommand),
  suggestedVerificationCommands: Schema.Array(GoAgentVerificationCommand),
  missions: Schema.Array(GoAgentMissionSummary),
  projectDecisions: Schema.Array(GoAgentProjectDecision),
  /** A DECISIONS.md at the project root that can be imported as seeded decisions. */
  decisionsFile: Schema.NullOr(Schema.String),
});
export type GoAgentProjectState = typeof GoAgentProjectState.Type;

export const GoAgentProjectInput = Schema.Struct({ projectId: ProjectId });
export type GoAgentProjectInput = typeof GoAgentProjectInput.Type;

export const GoAgentGetGraphInput = Schema.Struct({
  projectId: ProjectId,
  scanId: Schema.optional(GoAgentScanId),
});
export type GoAgentGetGraphInput = typeof GoAgentGetGraphInput.Type;

export const GoAgentGraphDeltaInput = Schema.Struct({
  baseScanId: GoAgentScanId,
  scanId: GoAgentScanId,
});
export type GoAgentGraphDeltaInput = typeof GoAgentGraphDeltaInput.Type;

export const GoAgentSetVerificationCommandsInput = Schema.Struct({
  projectId: ProjectId,
  commands: Schema.Array(GoAgentVerificationCommand),
});
export type GoAgentSetVerificationCommandsInput = typeof GoAgentSetVerificationCommandsInput.Type;

export const GoAgentCreateMissionInput = Schema.Struct({
  projectId: ProjectId,
  request: TrimmedNonEmptyString,
});
export type GoAgentCreateMissionInput = typeof GoAgentCreateMissionInput.Type;

export const GoAgentMissionInput = Schema.Struct({ missionId: GoAgentMissionId });
export type GoAgentMissionInput = typeof GoAgentMissionInput.Type;

export const GoAgentUpdatePlanInput = Schema.Struct({
  missionId: GoAgentMissionId,
  planVersion: PositiveInt,
  plan: GoAgentPlan,
});
export type GoAgentUpdatePlanInput = typeof GoAgentUpdatePlanInput.Type;

export const GoAgentApproveMissionInput = Schema.Struct({
  missionId: GoAgentMissionId,
  planVersion: PositiveInt,
});
export type GoAgentApproveMissionInput = typeof GoAgentApproveMissionInput.Type;

export const GoAgentOverrideDecisionInput = Schema.Struct({
  decisionId: GoAgentDecisionId,
  answer: TrimmedNonEmptyString,
});
export type GoAgentOverrideDecisionInput = typeof GoAgentOverrideDecisionInput.Type;

/** Without `commandId`, every approved command runs in order and stops at the first failure. */
export const GoAgentVerifyMissionInput = Schema.Struct({
  missionId: GoAgentMissionId,
  commandId: Schema.optional(TrimmedNonEmptyString),
});
export type GoAgentVerifyMissionInput = typeof GoAgentVerifyMissionInput.Type;

/** Add one decision, import the project's DECISIONS.md as seeded decisions, or retire one. */
export const GoAgentProjectDecisionChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("add"), text: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("import") }),
  Schema.Struct({ type: Schema.Literal("retire"), decisionId: GoAgentProjectDecisionId }),
]);
export type GoAgentProjectDecisionChange = typeof GoAgentProjectDecisionChange.Type;

export const GoAgentUpdateProjectDecisionsInput = Schema.Struct({
  projectId: ProjectId,
  change: GoAgentProjectDecisionChange,
});
export type GoAgentUpdateProjectDecisionsInput = typeof GoAgentUpdateProjectDecisionsInput.Type;

/** Without `taskKey`, the repair goes to the owner chosen by the latest `failure.owner` decision. */
export const GoAgentRequestRepairInput = Schema.Struct({
  missionId: GoAgentMissionId,
  taskKey: Schema.optional(GoAgentTaskKey),
});
export type GoAgentRequestRepairInput = typeof GoAgentRequestRepairInput.Type;

export const GoAgentErrorCode = Schema.Literals([
  "project_not_found",
  "mission_not_found",
  "scan_not_found",
  "decision_not_found",
  "graphify_unavailable",
  "graphify_schema_unsupported",
  "graph_index_failed",
  "plan_invalid",
  "plan_version_mismatch",
  "invalid_state",
  "worktree_dirty_base",
  "not_a_git_repository",
  "worktree_failed",
  "provider_unavailable",
  "contract_version_mismatch",
  "integration_conflict",
  "verification_not_approved",
  "storage_failed",
]);
export type GoAgentErrorCode = typeof GoAgentErrorCode.Type;

export class GoAgentError extends Schema.TaggedError<GoAgentError>()("GoAgentError", {
  code: GoAgentErrorCode,
  message: Schema.String,
}) {}
