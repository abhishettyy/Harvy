import {
  CommandId,
  GOAGENT_CONTRACT_DEPENDENCY,
  GoAgentContractId,
  GoAgentDecisionId,
  GoAgentError,
  GoAgentEventId,
  GoAgentMissionId,
  GoAgentProjectDecisionId,
  GoAgentVerificationRunId,
  MessageId,
  ThreadId,
  type GoAgentContract,
  type GoAgentContractSpec,
  type GoAgentDecision,
  type GoAgentEvent,
  type GoAgentEventType,
  type GoAgentGraphDelta,
  type GoAgentGraphNode,
  type GoAgentGraphScan,
  type GoAgentGraphSnapshot,
  type GoAgentScanId,
  type GoAgentMission,
  type GoAgentMissionSnapshot,
  type GoAgentPlan,
  type GoAgentProjectDecision,
  type GoAgentProjectDecisionChange,
  type GoAgentProjectState,
  type GoAgentTask,
  type GoAgentVerificationCommand,
  type GoAgentVerificationRun,
  type OrchestrationV2Run,
  type ProjectId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Project from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GoAgentDecisionService from "./GoAgentDecisionService.ts";
import * as GoAgentGraphService from "./GoAgentGraphService.ts";
import * as GoAgentStore from "./GoAgentStore.ts";
import { neighbourhood } from "./graphifyGraph.ts";
import {
  contractMatchDecision,
  failureOwnerDecision,
  handoffNotifyDecision,
  handoffRouteDecision,
  riskDecision,
  routeDecision,
} from "./goagentDecisions.ts";
import {
  buildPlan,
  collapseToSingle,
  decisionGraph,
  impactedTasks,
  integrationOrder,
  ownerOfPath,
  packageManagerFor,
  parseDecisionsFile,
  parseTestSummary,
  renderContractUpdateMessage,
  renderRepairBrief,
  renderGraphContext,
  renderHandoffMessage,
  renderTaskPrompt,
  taskCoupling,
  suggestVerificationCommands,
  validatePlan,
} from "./goagentPlanner.ts";

const EVENT_TAIL = 300;
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const OUTPUT_EXCERPT_BYTES = 12_000;
const CONTEXT_NODE_CAP = 60;
const CONTEXT_LINE_CAP = 40;
const MAX_REPAIR_ROUNDS = 1;
/** GoAgent.md §9.2 budget: past this many Jev calls a mission's decisions use the fallback rules. */
const MAX_JEV_CALLS_PER_MISSION = 24;
const MAX_HANDOFFS_PER_MISSION = 8;
const MAX_AGENT_DECISIONS_PER_TASK = 15;
const MAX_PROJECT_DECISION_CHARS = 1_000;
const DECISIONS_FILE = "DECISIONS.md";
const CONTRACT_REVIEW_PREFIX = "review: contract";
// GoAgent commits in its own worktrees; a fixed identity keeps that working on machines with no
// git identity and makes GoAgent-authored commits recognisable.
const GOAGENT_GIT_IDENTITY = ["-c", "user.name=GoAgent", "-c", "user.email=goagent@localhost"];
const TERMINAL_FAILURE_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);
const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** What a provider agent may do to its own mission through MCP. */
export interface AgentCaller {
  readonly threadId: ThreadId;
}

export class GoAgentMissionService extends Context.Service<
  GoAgentMissionService,
  {
    readonly projectState: (
      projectId: ProjectId,
    ) => Effect.Effect<GoAgentProjectState, GoAgentError>;
    readonly indexProject: (projectId: ProjectId) => Effect.Effect<GoAgentGraphScan, GoAgentError>;
    readonly getGraph: (input: {
      readonly projectId: ProjectId;
      readonly scanId?: GoAgentScanId | undefined;
    }) => Effect.Effect<GoAgentGraphSnapshot | null, GoAgentError>;
    readonly getGraphDelta: (input: {
      readonly baseScanId: GoAgentScanId;
      readonly scanId: GoAgentScanId;
    }) => Effect.Effect<GoAgentGraphDelta, GoAgentError>;
    readonly setVerificationCommands: (
      projectId: ProjectId,
      commands: ReadonlyArray<GoAgentVerificationCommand>,
    ) => Effect.Effect<GoAgentProjectState, GoAgentError>;
    readonly createMission: (input: {
      readonly projectId: ProjectId;
      readonly request: string;
    }) => Effect.Effect<GoAgentMissionSnapshot, GoAgentError>;
    readonly getMission: (
      missionId: GoAgentMissionId,
    ) => Effect.Effect<GoAgentMissionSnapshot, GoAgentError>;
    readonly updatePlan: (input: {
      readonly missionId: GoAgentMissionId;
      readonly planVersion: number;
      readonly plan: GoAgentPlan;
    }) => Effect.Effect<GoAgentMissionSnapshot, GoAgentError>;
    readonly approveMission: (input: {
      readonly missionId: GoAgentMissionId;
      readonly planVersion: number;
    }) => Effect.Effect<GoAgentMissionSnapshot, GoAgentError>;
    readonly startMission: (
      missionId: GoAgentMissionId,
    ) => Effect.Effect<GoAgentMissionSnapshot, GoAgentError>;
    readonly cancelMission: (
      missionId: GoAgentMissionId,
    ) => Effect.Effect<GoAgentMissionSnapshot, GoAgentError>;
    readonly overrideDecision: (input: {
      readonly decisionId: GoAgentDecisionId;
      readonly answer: string;
    }) => Effect.Effect<GoAgentDecision, GoAgentError>;
    readonly integrateMission: (
      missionId: GoAgentMissionId,
    ) => Effect.Effect<GoAgentMissionSnapshot, GoAgentError>;
    readonly verifyMission: (input: {
      readonly missionId: GoAgentMissionId;
      readonly commandId?: string | undefined;
    }) => Effect.Effect<GoAgentMissionSnapshot, GoAgentError>;
    readonly updateProjectDecisions: (
      projectId: ProjectId,
      change: GoAgentProjectDecisionChange,
    ) => Effect.Effect<GoAgentProjectState, GoAgentError>;
    readonly requestRepair: (input: {
      readonly missionId: GoAgentMissionId;
      readonly taskKey?: string | undefined;
    }) => Effect.Effect<GoAgentMissionSnapshot, GoAgentError>;
    readonly subscribeMission: (
      missionId: GoAgentMissionId,
    ) => Stream.Stream<GoAgentMissionSnapshot, GoAgentError>;

    readonly agentTaskStatus: (caller: AgentCaller) => Effect.Effect<
      {
        readonly mission: GoAgentMission;
        readonly task: GoAgentTask;
        readonly tasks: ReadonlyArray<GoAgentTask>;
        readonly contract: GoAgentContract | null;
      },
      GoAgentError
    >;
    readonly agentProposeContract: (
      caller: AgentCaller,
      spec: GoAgentContractSpec,
    ) => Effect.Effect<GoAgentContract, GoAgentError>;
    readonly agentAcknowledgeContract: (
      caller: AgentCaller,
      input: { readonly version: number; readonly note: string },
    ) => Effect.Effect<GoAgentContract, GoAgentError>;
    readonly agentRecordDecision: (
      caller: AgentCaller,
      input: { readonly decision: string; readonly reason: string },
    ) => Effect.Effect<{ readonly recorded: number }, GoAgentError>;
    readonly agentHandoff: (
      caller: AgentCaller,
      input: { readonly note: string; readonly files: ReadonlyArray<string> },
    ) => Effect.Effect<
      {
        readonly routedTo: string | null;
        readonly source: GoAgentDecision["source"];
        readonly confidence: number | null;
      },
      GoAgentError
    >;
    readonly agentProjectDecisions: (
      caller: AgentCaller,
    ) => Effect.Effect<ReadonlyArray<GoAgentProjectDecision>, GoAgentError>;
    readonly agentGraphSearch: (
      caller: AgentCaller,
      query: string,
    ) => Effect.Effect<ReadonlyArray<GoAgentGraphNode>, GoAgentError>;
    readonly agentGraphNeighbours: (
      caller: AgentCaller,
      nodeIds: ReadonlyArray<string>,
      hops: number,
    ) => Effect.Effect<Pick<GoAgentGraphSnapshot, "nodes" | "edges">, GoAgentError>;
  }
>()("t3/goagent/GoAgentMissionService") {}

const fail = (code: GoAgentError["code"], message: string) => new GoAgentError({ code, message });

const storage = (cause: GoAgentStore.GoAgentStoreError) => fail("storage_failed", cause.message);

const make = Effect.gen(function* () {
  const store = yield* GoAgentStore.GoAgentStore;
  const graph = yield* GoAgentGraphService.GoAgentGraphService;
  const decisions = yield* GoAgentDecisionService.GoAgentDecisionService;
  const projects = yield* Project.ProjectService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const { worktreesDir } = yield* ServerConfig.ServerConfig;

  const changes = yield* PubSub.unbounded<GoAgentMissionId>();
  // Mission mutations are short and rare; one lock keeps read-modify-write sequences consistent.
  const lock = Semaphore.makeUnsafe(1);
  // Missions where a finished agent's follow-up (graph delta, handoff decisions) is still running.
  const coordinating = new Map<GoAgentMissionId, number>();
  const whileCoordinating = <A, E, R>(
    missionId: GoAgentMissionId,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => coordinating.set(missionId, (coordinating.get(missionId) ?? 0) + 1)),
      () => effect,
      () =>
        Effect.sync(() => {
          const left = (coordinating.get(missionId) ?? 1) - 1;
          if (left <= 0) coordinating.delete(missionId);
          else coordinating.set(missionId, left);
        }).pipe(Effect.andThen(PubSub.publish(changes, missionId))),
    );

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // The platform RNG failing is not a mission outcome a caller can handle.
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);

  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(() => fail("storage_failed", "The project could not be read.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("project_not_found", "The project was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const requireMission = (missionId: GoAgentMissionId) =>
    store.getMission(missionId).pipe(
      Effect.mapError(storage),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("mission_not_found", "The mission was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const snapshot = Effect.fn("GoAgentMissionService.snapshot")(function* (
    missionId: GoAgentMissionId,
  ) {
    const mission = yield* requireMission(missionId);
    const [tasks, contracts, missionDecisions, verificationRuns, events] = yield* Effect.all([
      store.listTasks(missionId),
      store.listContracts(missionId),
      store.listDecisions(missionId),
      store.listVerificationRuns(missionId),
      store.listEvents(missionId, EVENT_TAIL),
    ]).pipe(Effect.mapError(storage));
    return {
      mission,
      tasks,
      contracts,
      decisions: missionDecisions,
      verificationRuns,
      events,
      coordinating: coordinating.has(missionId),
    } satisfies GoAgentMissionSnapshot;
  });

  const latestContract = (missionId: GoAgentMissionId) =>
    store.listContracts(missionId).pipe(
      Effect.mapError(storage),
      Effect.map((contracts) => contracts.at(-1) ?? null),
    );

  const latestEventOfType = (missionId: GoAgentMissionId, type: GoAgentEventType) =>
    store.listEvents(missionId, EVENT_TAIL).pipe(
      Effect.mapError(storage),
      Effect.map(
        (events) => events.toReversed().find((event) => event.type === type)?.eventId ?? null,
      ),
    );

  const emit = Effect.fn("GoAgentMissionService.emit")(function* (input: {
    readonly missionId: GoAgentMissionId;
    readonly type: GoAgentEventType;
    readonly actor: string;
    readonly summary: string;
    readonly payload?: Record<string, unknown>;
    readonly causedBy?: GoAgentEventId | null;
  }) {
    return yield* store
      .appendEvent({
        eventId: GoAgentEventId.make(yield* uuid),
        missionId: input.missionId,
        type: input.type,
        actor: input.actor,
        causedBy: input.causedBy ?? null,
        summary: input.summary,
        payload: input.payload ?? {},
        occurredAt: yield* nowIso,
      })
      .pipe(Effect.mapError(storage));
  });

  /**
   * Serializes mission read-modify-write sequences, then notifies subscribers. This is not one DB
   * transaction: steps launch T3 threads, which commit through the orchestration event sink, so
   * each GoAgent write commits on its own and the event log records what happened.
   */
  const mutate = <A, R>(missionId: GoAgentMissionId, effect: Effect.Effect<A, GoAgentError, R>) =>
    effect.pipe(lock.withPermits(1), Effect.ensuring(PubSub.publish(changes, missionId)));

  const saveMission = (mission: GoAgentMission) =>
    Effect.flatMap(nowIso, (updatedAt) =>
      store.putMission({ ...mission, updatedAt }).pipe(Effect.mapError(storage)),
    );

  const saveTask = (task: GoAgentTask) => store.putTask(task).pipe(Effect.mapError(storage));

  const recordDecision = Effect.fn("GoAgentMissionService.recordDecision")(function* (
    missionId: GoAgentMissionId,
    request: GoAgentDecisionService.DecisionRequest,
    about: { readonly taskKey?: string; readonly targetTaskKey?: string } = {},
  ) {
    const asked = (yield* store
      .listDecisions(missionId)
      .pipe(Effect.orElseSucceed(() => []))).filter((d) => d.model !== null).length;
    const outcome: GoAgentDecisionService.DecisionOutcome =
      asked >= MAX_JEV_CALLS_PER_MISSION && decisions.status.available
        ? {
            answer: request.fallback.answer,
            probabilities: {},
            confidence: null,
            model: null,
            source: "fallback",
            fallbackReason: `Jev budget of ${MAX_JEV_CALLS_PER_MISSION} calls for this mission is used; ${request.fallback.reason}`,
          }
        : yield* decisions.decide(request);
    const decision: GoAgentDecision = {
      decisionId: GoAgentDecisionId.make(yield* uuid),
      missionId,
      key: request.key,
      question: request.question,
      criteria: request.criteria.map((c) => c.label),
      answer: outcome.answer,
      probabilities: outcome.probabilities,
      confidence: outcome.confidence,
      model: outcome.model,
      source: outcome.source,
      fallbackReason: outcome.fallbackReason,
      createdAt: yield* nowIso,
      ...(about.taskKey === undefined ? {} : { taskKey: about.taskKey as GoAgentTask["key"] }),
      ...(about.targetTaskKey === undefined
        ? {}
        : { targetTaskKey: about.targetTaskKey as GoAgentTask["key"] }),
    };
    return decision;
  });

  const persistDecision = Effect.fn("GoAgentMissionService.persistDecision")(function* (
    decision: GoAgentDecision,
    causedBy: GoAgentEventId | null = null,
  ) {
    yield* store.putDecision(decision).pipe(Effect.mapError(storage));
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    // A fallback's confidence is Jev's confidence in its own (rejected) answer, not in this one.
    const detail =
      decision.confidence === null
        ? decision.source === "fallback"
          ? " [fallback]"
          : ""
        : decision.source === "fallback"
          ? ` [fallback; Jev was ${percent(decision.confidence)} sure]`
          : ` (${percent(decision.confidence)})`;
    yield* emit({
      missionId: decision.missionId,
      type: "decision.made",
      actor: decision.source === "jev" ? "jev" : "goagent",
      summary: `${decision.key} → ${decision.answer}${detail}`,
      payload: { decisionId: decision.decisionId },
      causedBy,
    });
  });

  const readLockfiles = Effect.fn("GoAgentMissionService.readLockfiles")(function* (root: string) {
    const lockfiles = new Set<string>();
    for (const name of [
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
    ]) {
      if (yield* fileSystem.exists(path.join(root, name)).pipe(Effect.orElseSucceed(() => false)))
        lockfiles.add(name);
    }
    return lockfiles;
  });

  const readSuggestions = Effect.fn("GoAgentMissionService.readSuggestions")(function* (
    root: string,
  ) {
    const packageJson = yield* fileSystem.readFileString(path.join(root, "package.json")).pipe(
      Effect.flatMap(decodeJson),
      Effect.orElseSucceed((): unknown => null),
    );
    return suggestVerificationCommands(packageJson, yield* readLockfiles(root));
  });

  const projectState = Effect.fn("GoAgentMissionService.projectState")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* requireProject(projectId);
    const [graphify, latestBaseScan, verificationCommands, missions, suggested, projectDecisions] =
      yield* Effect.all(
        [
          graph.status,
          graph.latestBaseScan(projectId),
          store.getVerificationCommands(projectId).pipe(Effect.mapError(storage)),
          store.listMissions(projectId).pipe(Effect.mapError(storage)),
          readSuggestions(project.workspaceRoot),
          store.listProjectDecisions(projectId).pipe(Effect.mapError(storage)),
        ],
        { concurrency: "unbounded" },
      );
    const decisionsFile = (yield* fileSystem
      .exists(path.join(project.workspaceRoot, DECISIONS_FILE))
      .pipe(Effect.orElseSucceed(() => false)))
      ? DECISIONS_FILE
      : null;
    return {
      projectId,
      graphify,
      jev: decisions.status,
      latestBaseScan: Option.getOrNull(latestBaseScan),
      verificationCommands,
      suggestedVerificationCommands: suggested,
      missions: missions.map((m) => ({
        missionId: m.missionId,
        title: m.title,
        state: m.state,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
      projectDecisions,
      decisionsFile,
    } satisfies GoAgentProjectState;
  });

  const addProjectDecision = Effect.fn("GoAgentMissionService.addProjectDecision")(function* (
    projectId: ProjectId,
    text: string,
  ) {
    yield* requireProject(projectId);
    yield* store
      .putProjectDecision({
        decisionId: GoAgentProjectDecisionId.make(yield* uuid),
        projectId,
        text: text.trim().slice(0, MAX_PROJECT_DECISION_CHARS),
        author: "user",
        sourceFile: null,
        createdAt: yield* nowIso,
      })
      .pipe(Effect.mapError(storage));
    return yield* projectState(projectId);
  });

  /** Imports DECISIONS.md bullets as seeded decisions; text that is already recorded is skipped. */
  const importProjectDecisions = Effect.fn("GoAgentMissionService.importProjectDecisions")(
    function* (projectId: ProjectId) {
      const project = yield* requireProject(projectId);
      const markdown = yield* fileSystem
        .readFileString(path.join(project.workspaceRoot, DECISIONS_FILE))
        .pipe(
          Effect.mapError(() =>
            fail("project_not_found", `${DECISIONS_FILE} was not found at the project root.`),
          ),
        );
      const existing = new Set(
        (yield* store.listProjectDecisions(projectId).pipe(Effect.mapError(storage))).map(
          (d) => d.text,
        ),
      );
      for (const text of parseDecisionsFile(markdown)) {
        if (existing.has(text)) continue;
        existing.add(text);
        yield* store
          .putProjectDecision({
            decisionId: GoAgentProjectDecisionId.make(yield* uuid),
            projectId,
            text,
            author: "seeded",
            sourceFile: DECISIONS_FILE,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.mapError(storage));
      }
      return yield* projectState(projectId);
    },
  );

  const retireProjectDecision = Effect.fn("GoAgentMissionService.retireProjectDecision")(function* (
    projectId: ProjectId,
    decisionId: GoAgentProjectDecisionId,
  ) {
    const retired = yield* store
      .retireProjectDecision({ projectId, decisionId, retiredAt: yield* nowIso })
      .pipe(Effect.mapError(storage));
    if (!retired) return yield* fail("decision_not_found", "The project decision was not found.");
    return yield* projectState(projectId);
  });

  const indexProject = Effect.fn("GoAgentMissionService.indexProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* requireProject(projectId);
    return yield* graph.index({ projectId, root: project.workspaceRoot, scope: "base" });
  });

  const setVerificationCommands = Effect.fn("GoAgentMissionService.setVerificationCommands")(
    function* (projectId: ProjectId, commands: ReadonlyArray<GoAgentVerificationCommand>) {
      yield* requireProject(projectId);
      if (new Set(commands.map((c) => c.id)).size !== commands.length)
        return yield* fail("plan_invalid", "Verification command ids must be unique.");
      yield* store
        .putVerificationCommands(projectId, commands, yield* nowIso)
        .pipe(Effect.mapError(storage));
      return yield* projectState(projectId);
    },
  );

  const gitRun = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: `goagent.${operation}`,
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs: 120_000,
      })
      .pipe(Effect.mapError(() => fail("worktree_failed", `git ${args[0] ?? ""} could not run.`)));

  const headSha = (cwd: string) =>
    gitRun("revParse", cwd, ["rev-parse", "HEAD"]).pipe(
      Effect.map((r) => (r.exitCode === 0 ? r.stdout.trim() : null)),
    );

  const trackedFiles = (cwd: string) =>
    gitRun("lsFiles", cwd, ["ls-files"]).pipe(
      Effect.map((r) =>
        r.exitCode === 0
          ? r.stdout
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
          : [],
      ),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

  const approvedCommandIds = (projectId: ProjectId) =>
    store.getVerificationCommands(projectId).pipe(
      Effect.mapError(storage),
      Effect.map((commands) => commands.map((c) => c.id)),
    );

  /** Adds the knowledge-graph coupling between the plan's tasks (absent without a graph). */
  const withCoupling = (plan: GoAgentPlan, baseScanId: GoAgentScanId | null) =>
    baseScanId === null || plan.tasks.length < 2
      ? Effect.succeed(plan)
      : store.getScanGraph(baseScanId).pipe(
          Effect.map((rows): GoAgentPlan => ({
            ...plan,
            coupling: taskCoupling(plan.tasks, rows),
          })),
          Effect.orElseSucceed(() => plan),
        );

  const createMission = Effect.fn("GoAgentMissionService.createMission")(function* (input: {
    readonly projectId: ProjectId;
    readonly request: string;
  }) {
    const project = yield* requireProject(input.projectId);
    // A missing or failed index degrades planning to the git file list; it never blocks a mission.
    const baseScan = yield* graph.latestBaseScan(input.projectId).pipe(
      Effect.flatMap((latest) =>
        Option.isSome(latest)
          ? Effect.succeed(Option.some(latest.value))
          : graph
              .index({ projectId: input.projectId, root: project.workspaceRoot, scope: "base" })
              .pipe(Effect.map(Option.some)),
      ),
      Effect.orElseSucceed(() => Option.none<GoAgentGraphScan>()),
    );
    const files = Option.isSome(baseScan)
      ? (yield* store.getScanGraph(baseScan.value.scanId).pipe(Effect.mapError(storage))).nodes
          .filter((node) => node.kind === "file" && node.sourceFile !== null)
          .map((node) => node.sourceFile!)
      : yield* trackedFiles(project.workspaceRoot);
    const commandIds = yield* approvedCommandIds(input.projectId);
    let plan = buildPlan({ request: input.request, files, verificationCommandIds: commandIds });
    const missionId = GoAgentMissionId.make(yield* uuid);
    const route = yield* recordDecision(
      missionId,
      routeDecision({ request: input.request, plan, touchedFiles: [] }),
    );
    if (route.answer === "single_agent" && plan.tasks.length > 1)
      plan = collapseToSingle(plan, input.request);
    plan = yield* withCoupling(plan, Option.isSome(baseScan) ? baseScan.value.scanId : null);
    const now = yield* nowIso;
    const mission: GoAgentMission = {
      missionId,
      projectId: input.projectId,
      title: plan.title,
      request: input.request,
      state: "planned",
      plan,
      planVersion: 1,
      baseSha: null,
      baseScanId: Option.isSome(baseScan) ? baseScan.value.scanId : null,
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
      createdAt: now,
      updatedAt: now,
    };
    yield* mutate(
      missionId,
      Effect.gen(function* () {
        yield* store.putMission(mission).pipe(Effect.mapError(storage));
        const created = yield* emit({
          missionId,
          type: "mission.created",
          actor: "user",
          summary: `Mission created: ${mission.title}`,
          payload: {
            request: input.request,
            baseScanId: mission.baseScanId,
            graphAvailable: Option.isSome(baseScan),
          },
        });
        yield* persistDecision(route, created.eventId);
        yield* emit({
          missionId,
          type: "plan.proposed",
          actor: "goagent",
          summary: `Plan v1: ${plan.tasks.map((t) => t.key).join(" ∥ ")}`,
          payload: {
            planVersion: 1,
            tasks: plan.tasks.map((t) => t.key),
            coupling: (plan.coupling ?? []).map((c) => `${c.from} uses ${c.to}: ${c.edgeCount}`),
          },
          causedBy: created.eventId,
        });
      }),
    );
    return yield* snapshot(missionId);
  });

  const requireState = (
    mission: GoAgentMission,
    allowed: ReadonlyArray<GoAgentMission["state"]>,
    action: string,
  ) =>
    allowed.includes(mission.state)
      ? Effect.void
      : Effect.fail(fail("invalid_state", `Cannot ${action} a mission that is ${mission.state}.`));

  const updatePlan = Effect.fn("GoAgentMissionService.updatePlan")(function* (input: {
    readonly missionId: GoAgentMissionId;
    readonly planVersion: number;
    readonly plan: GoAgentPlan;
  }) {
    yield* mutate(
      input.missionId,
      Effect.gen(function* () {
        const mission = yield* requireMission(input.missionId);
        yield* requireState(mission, ["planned"], "edit the plan of");
        if (mission.planVersion !== input.planVersion)
          return yield* fail(
            "plan_version_mismatch",
            "The plan changed since you loaded it. Reload and retry.",
          );
        const problems = validatePlan(input.plan, yield* approvedCommandIds(mission.projectId));
        if (problems.length > 0) return yield* fail("plan_invalid", problems.join(" "));
        const planVersion = mission.planVersion + 1;
        const plan = yield* withCoupling(input.plan, mission.baseScanId);
        yield* saveMission({ ...mission, plan, title: plan.title, planVersion });
        yield* emit({
          missionId: mission.missionId,
          type: "plan.updated",
          actor: "user",
          summary: `Plan v${planVersion}: ${input.plan.tasks.map((t) => t.key).join(" ∥ ")}`,
          payload: { planVersion },
        });
      }),
    );
    return yield* snapshot(input.missionId);
  });

  const approveMission = Effect.fn("GoAgentMissionService.approveMission")(function* (input: {
    readonly missionId: GoAgentMissionId;
    readonly planVersion: number;
  }) {
    const mission = yield* requireMission(input.missionId);
    // A plan held for review after a high risk rating is approved by approving it again.
    const confirmingReview = mission.state === "needs_review" && mission.baseSha === null;
    if (!confirmingReview) yield* requireState(mission, ["planned"], "approve");
    if (mission.planVersion !== input.planVersion)
      return yield* fail(
        "plan_version_mismatch",
        "The plan changed since you loaded it. Reload and retry.",
      );
    const problems = validatePlan(mission.plan, yield* approvedCommandIds(mission.projectId));
    if (problems.length > 0) return yield* fail("plan_invalid", problems.join(" "));
    if (confirmingReview) {
      yield* mutate(
        mission.missionId,
        Effect.gen(function* () {
          const current = yield* requireMission(input.missionId);
          if (current.state !== "needs_review" || current.baseSha !== null)
            return yield* fail(
              "invalid_state",
              `Cannot approve a mission that is ${current.state}.`,
            );
          yield* saveMission({ ...current, state: "approved", failureReason: null });
          yield* emit({
            missionId: current.missionId,
            type: "plan.approved",
            actor: "user",
            summary: `Plan v${current.planVersion} approved after reviewing its high risk rating`,
            payload: { planVersion: current.planVersion, riskAcknowledged: true },
            causedBy: yield* latestEventOfType(current.missionId, "plan.review_required"),
          });
        }),
      );
      return yield* snapshot(input.missionId);
    }
    const hubFiles = mission.baseScanId === null ? [] : yield* hubFilesTouched(mission);
    const risk = yield* recordDecision(
      mission.missionId,
      riskDecision({ plan: mission.plan, hubFiles }),
    );
    yield* mutate(
      mission.missionId,
      Effect.gen(function* () {
        const current = yield* requireMission(input.missionId);
        yield* requireState(current, ["planned"], "approve");
        if (risk.answer === "high") {
          // GoAgent.md §9.1: a high risk rating holds the plan for an explicit second approval.
          const reason = `Rated high risk${risk.source === "jev" ? " by Jev" : ""}; approve again to start.`;
          yield* saveMission({ ...current, state: "needs_review", failureReason: reason });
          const held = yield* emit({
            missionId: current.missionId,
            type: "plan.review_required",
            actor: "goagent",
            summary: `Plan v${current.planVersion} needs review: ${reason}`,
            payload: { planVersion: current.planVersion, decisionId: risk.decisionId },
          });
          yield* persistDecision(risk, held.eventId);
          return;
        }
        yield* saveMission({ ...current, state: "approved" });
        const approved = yield* emit({
          missionId: current.missionId,
          type: "plan.approved",
          actor: "user",
          summary: `Plan v${current.planVersion} approved`,
          payload: { planVersion: current.planVersion },
        });
        yield* persistDecision(risk, approved.eventId);
      }),
    );
    return yield* snapshot(input.missionId);
  });

  /** The most-connected files in the base graph that the plan's owned paths cover. */
  const hubFilesTouched = (mission: GoAgentMission) =>
    store.getScanGraph(mission.baseScanId!).pipe(
      Effect.mapError(storage),
      Effect.map((rows) => {
        const degree = new Map<string, number>();
        for (const edge of rows.edges) {
          degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
          degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
        }
        const owned = mission.plan.tasks.flatMap((task) =>
          task.ownsPaths.map((p) => p.replace(/\*+$/, "")),
        );
        return rows.nodes
          .filter(
            (node) =>
              node.kind === "file" &&
              node.sourceFile !== null &&
              owned.some((p) => node.sourceFile!.startsWith(p)),
          )
          .toSorted((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
          .slice(0, 5)
          .map((node) => `${node.sourceFile} (${degree.get(node.id) ?? 0} links)`);
      }),
    );

  const graphContextFor = Effect.fn("GoAgentMissionService.graphContextFor")(function* (
    mission: GoAgentMission,
    ownsPaths: ReadonlyArray<string>,
  ) {
    if (mission.baseScanId === null) return { text: "", nodeIds: [] as ReadonlyArray<string> };
    const rows = yield* store.getScanGraph(mission.baseScanId).pipe(Effect.mapError(storage));
    const prefixes = ownsPaths.map((p) => p.replace(/\*+$/, ""));
    const seeds = rows.nodes
      .filter(
        (node) =>
          node.kind === "file" &&
          node.sourceFile !== null &&
          prefixes.some((p) => node.sourceFile!.startsWith(p)),
      )
      .map((node) => node.id);
    const context = neighbourhood(rows, seeds, { hops: 2, maxNodes: CONTEXT_NODE_CAP });
    return {
      text: renderGraphContext(context.nodes, context.edges, CONTEXT_LINE_CAP),
      nodeIds: context.nodes.map((node) => node.id),
    };
  });

  const resolveLaunchSettings = Effect.fn("GoAgentMissionService.resolveLaunchSettings")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* requireProject(projectId);
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => fail("storage_failed", "Server settings could not be read.")),
    );
    const resolved = resolveProjectSettings(settings, projectId, project).settings;
    const modelSelection = resolved.defaultModelSelection;
    if (modelSelection == null)
      return yield* fail(
        "provider_unavailable",
        "This project has no default model. Pick one in Settings → Projects (for example an OpenCode model).",
      );
    return { modelSelection, runtimeMode: resolved.defaultRuntimeMode ?? "full-access" } as const;
  });

  /** Launches one task's agent thread in a fresh worktree from the mission base commit. */
  const launchTask = Effect.fn("GoAgentMissionService.launchTask")(function* (
    mission: GoAgentMission,
    task: GoAgentTask,
    contract: GoAgentContract | null,
    causedBy: GoAgentEventId | null,
  ) {
    const planTask = mission.plan.tasks.find((t) => t.key === task.key)!;
    const launch = yield* resolveLaunchSettings(mission.projectId);
    const context = yield* graphContextFor(mission, planTask.ownsPaths);
    const project = yield* requireProject(mission.projectId);
    const packageManager = packageManagerFor(yield* readLockfiles(project.workspaceRoot));
    const projectDecisions = yield* store
      .listProjectDecisions(mission.projectId)
      .pipe(Effect.mapError(storage));
    const commandId = CommandId.make(`goagent:${mission.missionId}:${task.key}:${yield* uuid}`);
    const threadId = ThreadId.make(yield* uuid);
    const text = renderTaskPrompt({
      request: mission.request,
      plan: mission.plan,
      task: planTask,
      graphContext: context.text,
      contract,
      packageManager,
      projectDecisions,
    });
    const contextEvent = yield* emit({
      missionId: mission.missionId,
      type: "context.built",
      actor: "goagent",
      summary: `Context for ${task.key}: ${context.nodeIds.length} graph nodes, ${projectDecisions.length} project decision(s)`,
      payload: {
        taskKey: task.key,
        nodeIds: context.nodeIds.slice(0, 100),
        projectDecisionIds: projectDecisions.map((d) => d.decisionId),
        contractVersion: contract?.version ?? null,
      },
      causedBy,
    });
    const result = yield* launches
      .launch({
        commandId,
        threadId,
        projectId: mission.projectId,
        title: `GoAgent · ${mission.title.slice(0, 40)} · ${task.key}`,
        modelSelection: launch.modelSelection,
        runtimeMode: launch.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef: mission.baseSha! },
        initialMessage: { messageId: MessageId.make(commandId), text, attachments: [] },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.mapError((error) =>
          fail("worktree_failed", `The agent thread could not start: ${error.message}`),
        ),
      );
    const started: GoAgentTask = {
      ...task,
      state: "running",
      blockedOn: [],
      threadId: result.threadId,
      worktreePath: result.projection.thread.worktreePath,
      branch: result.projection.thread.branch,
      startedAt: yield* nowIso,
    };
    yield* saveTask(started);
    yield* emit({
      missionId: mission.missionId,
      type: "task.started",
      actor: "goagent",
      summary: `${task.key} started in its own worktree`,
      payload: { taskKey: task.key, threadId: result.threadId },
      causedBy: contextEvent.eventId,
    });
    return started;
  });

  /**
   * Launches a task; if its agent cannot start, the task is failed and the mission is held for
   * review with the reason, instead of staying "running" with nothing behind it. Runs inside
   * `mutate`.
   */
  const launchOrFail = (
    mission: GoAgentMission,
    task: GoAgentTask,
    contract: GoAgentContract | null,
    causedBy: GoAgentEventId | null,
  ) =>
    launchTask(mission, task, contract, causedBy).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const reason = `${task.key} could not start: ${error.message}`;
          yield* saveTask({
            ...task,
            state: "failed",
            failureReason: error.message,
            finishedAt: yield* nowIso,
          });
          const current = yield* requireMission(mission.missionId);
          yield* saveMission({ ...current, state: "needs_review", failureReason: reason });
          yield* emit({
            missionId: mission.missionId,
            type: "task.failed",
            actor: "goagent",
            summary: reason,
            payload: { taskKey: task.key, code: error.code },
            causedBy,
          });
          return null;
        }),
      ),
    );

  const startMission = Effect.fn("GoAgentMissionService.startMission")(function* (
    missionId: GoAgentMissionId,
  ) {
    yield* mutate(
      missionId,
      Effect.gen(function* () {
        const mission = yield* requireMission(missionId);
        yield* requireState(mission, ["approved"], "start");
        const project = yield* requireProject(mission.projectId);
        const baseSha = yield* headSha(project.workspaceRoot);
        if (baseSha === null)
          return yield* fail(
            "not_a_git_repository",
            "GoAgent needs the project to be a git repository with at least one commit.",
          );
        // Fail before anything changes when agents cannot be launched (e.g. no default model).
        yield* resolveLaunchSettings(mission.projectId);
        const status = yield* gitRun("status", project.workspaceRoot, ["status", "--porcelain"]);
        const dirty = status.stdout.trim().length > 0;
        const running: GoAgentMission = { ...mission, state: "running", baseSha };
        yield* saveMission(running);
        const started = yield* emit({
          missionId,
          type: "mission.started",
          actor: "user",
          summary: `Mission started from ${baseSha.slice(0, 8)}`,
          payload: {
            baseSha,
            // Worktrees start from the commit; uncommitted edits in the main checkout are not included.
            dirtyBaseline: dirty,
          },
        });
        let contract: GoAgentContract | null = null;
        if (mission.plan.contract !== null) {
          contract = {
            contractId: GoAgentContractId.make(`${missionId}:contract`),
            missionId,
            version: 1,
            spec: mission.plan.contract,
            proposedBy: "planner",
            proposedAt: yield* nowIso,
            acks: [],
          };
          yield* store.putContract(contract).pipe(Effect.mapError(storage));
          yield* emit({
            missionId,
            type: "contract.proposed",
            actor: "user",
            summary: `Contract v1 from the plan: ${contract.spec.method} ${contract.spec.path}`,
            payload: { version: 1, spec: contract.spec },
            causedBy: started.eventId,
          });
        }
        for (const planTask of mission.plan.tasks) {
          const task: GoAgentTask = {
            missionId,
            key: planTask.key,
            title: planTask.title,
            role: planTask.role,
            state: "queued",
            blockedOn: [],
            threadId: null,
            worktreePath: null,
            branch: null,
            headSha: null,
            changedFiles: [],
            scanId: null,
            failureReason: null,
            startedAt: null,
            finishedAt: null,
          };
          const blockedOn = blockersFor(planTask.dependsOn, contract, []);
          if (blockedOn.length > 0) {
            yield* saveTask({ ...task, state: "blocked", blockedOn });
            yield* emit({
              missionId,
              type: "task.blocked",
              actor: "goagent",
              summary: `${task.key} waits for ${blockedOn.join(", ")}`,
              payload: { taskKey: task.key, blockedOn },
              causedBy: started.eventId,
            });
          } else {
            yield* launchOrFail(running, task, contract, started.eventId);
          }
        }
      }),
    );
    return yield* snapshot(missionId);
  });

  /** Launch blockers: a contract dependency needs a proposed contract; task deps need completion. */
  const blockersFor = (
    dependsOn: ReadonlyArray<string>,
    contract: GoAgentContract | null,
    completedTasks: ReadonlyArray<string>,
  ) =>
    dependsOn.flatMap((dependency) => {
      if (dependency === GOAGENT_CONTRACT_DEPENDENCY) return contract === null ? ["contract"] : [];
      return completedTasks.includes(dependency) ? [] : [`task:${dependency}`];
    });

  /** Re-evaluates blocked tasks and launches those whose blockers cleared. Runs inside `mutate`. */
  const releaseBlocked = Effect.fn("GoAgentMissionService.releaseBlocked")(function* (
    missionId: GoAgentMissionId,
    causedBy: GoAgentEventId | null,
  ) {
    const mission = yield* requireMission(missionId);
    if (mission.state !== "running") return;
    const tasks = yield* store.listTasks(missionId).pipe(Effect.mapError(storage));
    const contract = yield* latestContract(missionId);
    const completed = tasks.filter((t) => t.state === "completed").map((t) => t.key);
    for (const task of tasks) {
      if (task.state !== "blocked") continue;
      const planTask = mission.plan.tasks.find((t) => t.key === task.key);
      if (planTask === undefined) continue;
      const blockedOn = blockersFor(planTask.dependsOn, contract, completed);
      if (blockedOn.length > 0) continue;
      const unblocked = yield* emit({
        missionId,
        type: "task.unblocked",
        actor: "goagent",
        summary: `${task.key} unblocked`,
        payload: { taskKey: task.key, was: task.blockedOn },
        causedBy,
      });
      yield* launchOrFail(mission, task, contract, unblocked.eventId);
    }
  });

  const cancelMission = Effect.fn("GoAgentMissionService.cancelMission")(function* (
    missionId: GoAgentMissionId,
  ) {
    yield* mutate(
      missionId,
      Effect.gen(function* () {
        const mission = yield* requireMission(missionId);
        yield* requireState(
          mission,
          [
            "planned",
            "approved",
            "running",
            "integrating",
            "verifying",
            "needs_review",
            "interrupted",
          ],
          "cancel",
        );
        const tasks = yield* store.listTasks(missionId).pipe(Effect.mapError(storage));
        for (const task of tasks) {
          if (task.threadId !== null && (task.state === "running" || task.state === "blocked")) {
            yield* threads
              .interruptThread({
                projectId: mission.projectId,
                commandId: CommandId.make(`goagent:cancel:${task.threadId}:${yield* uuid}`),
                threadId: task.threadId,
                reason: "GoAgent mission cancelled",
              })
              .pipe(Effect.ignore);
          }
          if (task.state !== "completed" && task.state !== "failed")
            yield* saveTask({ ...task, state: "cancelled", finishedAt: yield* nowIso });
        }
        yield* saveMission({ ...mission, state: "cancelled" });
        yield* emit({
          missionId,
          type: "mission.cancelled",
          actor: "user",
          summary: "Mission cancelled; worktrees are kept for review",
        });
      }),
    );
    return yield* snapshot(missionId);
  });

  const overrideDecision = Effect.fn("GoAgentMissionService.overrideDecision")(function* (input: {
    readonly decisionId: GoAgentDecisionId;
    readonly answer: string;
  }) {
    const decision = yield* store.getDecision(input.decisionId).pipe(
      Effect.mapError(storage),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("decision_not_found", "The decision was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (!decision.criteria.includes(input.answer))
      return yield* fail(
        "plan_invalid",
        `"${input.answer}" is not one of: ${decision.criteria.join(", ")}.`,
      );
    const overridden: GoAgentDecision = {
      ...decision,
      answer: input.answer,
      source: "human_override",
    };
    yield* mutate(
      decision.missionId,
      Effect.gen(function* () {
        yield* store.putDecision(overridden).pipe(Effect.mapError(storage));
        yield* emit({
          missionId: decision.missionId,
          type: "decision.overridden",
          actor: "user",
          summary: `${decision.key}: ${decision.answer} → ${input.answer}`,
          payload: {
            decisionId: decision.decisionId,
            previousAnswer: decision.answer,
            previousSource: decision.source,
          },
        });
        const mission = yield* requireMission(decision.missionId);
        if (decision.key === "contract.match" && input.answer === "true") {
          const tasks = yield* store.listTasks(mission.missionId).pipe(Effect.mapError(storage));
          for (const reviewed of tasks) {
            const remaining = reviewed.blockedOn.filter(
              (b) => !b.startsWith(CONTRACT_REVIEW_PREFIX),
            );
            if (remaining.length === reviewed.blockedOn.length) continue;
            yield* saveTask({ ...reviewed, blockedOn: remaining });
            yield* emit({
              missionId: mission.missionId,
              type: "task.unblocked",
              actor: "user",
              summary: `${reviewed.key}: contract acknowledgment accepted by the user`,
              payload: { taskKey: reviewed.key, was: reviewed.blockedOn },
            });
          }
        }
        if (decision.key === "mission.route" && mission.state === "planned") {
          const files = mission.plan.tasks.flatMap((t) => t.ownsPaths);
          const project = yield* requireProject(mission.projectId);
          const plan = yield* withCoupling(
            input.answer === "single_agent"
              ? collapseToSingle(mission.plan, mission.request, files)
              : buildPlan({
                  request: mission.request,
                  files: yield* trackedFiles(project.workspaceRoot),
                  verificationCommandIds: mission.plan.verificationCommandIds,
                }),
            mission.baseScanId,
          );
          const planVersion = mission.planVersion + 1;
          yield* saveMission({ ...mission, plan, planVersion });
          yield* emit({
            missionId: mission.missionId,
            type: "plan.updated",
            actor: "goagent",
            summary: `Plan v${planVersion} after route override: ${plan.tasks.map((t) => t.key).join(" ∥ ")}`,
            payload: { planVersion },
          });
        }
      }),
    );
    return overridden;
  });

  const requireCallerTask = (caller: AgentCaller) =>
    store.findTaskByThread(caller.threadId).pipe(
      Effect.mapError(storage),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(fail("mission_not_found", "This thread is not part of a GoAgent mission.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const agentTaskStatus = Effect.fn("GoAgentMissionService.agentTaskStatus")(function* (
    caller: AgentCaller,
  ) {
    const task = yield* requireCallerTask(caller);
    const mission = yield* requireMission(task.missionId);
    const tasks = yield* store.listTasks(task.missionId).pipe(Effect.mapError(storage));
    return { mission, task, tasks, contract: yield* latestContract(task.missionId) };
  });

  const agentProposeContract = Effect.fn("GoAgentMissionService.agentProposeContract")(function* (
    caller: AgentCaller,
    spec: GoAgentContractSpec,
  ) {
    const task = yield* requireCallerTask(caller);
    let contract: GoAgentContract | null = null;
    yield* mutate(
      task.missionId,
      Effect.gen(function* () {
        const mission = yield* requireMission(task.missionId);
        yield* requireState(mission, ["running"], "propose a contract for");
        const planTask = mission.plan.tasks.find((t) => t.key === task.key);
        if (!planTask?.proposesContract && mission.plan.contract === null)
          return yield* fail(
            "invalid_state",
            `Task "${task.key}" is not the contract owner in this plan.`,
          );
        const previous = yield* latestContract(task.missionId);
        const version = (previous?.version ?? 0) + 1;
        contract = {
          contractId: GoAgentContractId.make(`${task.missionId}:contract`),
          missionId: task.missionId,
          version,
          spec,
          proposedBy: `task:${task.key}`,
          proposedAt: yield* nowIso,
          acks: [],
        };
        yield* store.putContract(contract).pipe(Effect.mapError(storage));
        const proposed = yield* emit({
          missionId: task.missionId,
          type: "contract.proposed",
          actor: `task:${task.key}`,
          summary: `Contract v${version}: ${spec.method} ${spec.path}`,
          payload: { version, spec, supersedes: previous?.version ?? null },
        });
        // Dependents already running get the new version and must re-acknowledge it.
        const tasks = yield* store.listTasks(task.missionId).pipe(Effect.mapError(storage));
        for (const dependent of tasks) {
          const dependentPlan = mission.plan.tasks.find((t) => t.key === dependent.key);
          if (!dependentPlan?.dependsOn.includes(GOAGENT_CONTRACT_DEPENDENCY)) continue;
          if (dependent.state !== "running" || dependent.threadId === null) continue;
          const commandId = CommandId.make(`goagent:contract:${dependent.threadId}:${yield* uuid}`);
          yield* threads
            .sendToThread({
              projectId: mission.projectId,
              commandId,
              threadId: dependent.threadId,
              messageId: MessageId.make(commandId),
              text: renderContractUpdateMessage(contract),
              attachments: [],
              mode: "auto",
              createdBy: "system",
              creationSource: "server",
            })
            .pipe(
              Effect.mapError(() =>
                fail(
                  "provider_unavailable",
                  `Could not notify ${dependent.key} of the new contract.`,
                ),
              ),
            );
          yield* saveTask({ ...dependent, blockedOn: [`contract v${version} acknowledgment`] });
        }
        yield* releaseBlocked(task.missionId, proposed.eventId);
      }),
    );
    return contract!;
  });

  const agentAcknowledgeContract = Effect.fn("GoAgentMissionService.agentAcknowledgeContract")(
    function* (caller: AgentCaller, input: { readonly version: number; readonly note: string }) {
      const task = yield* requireCallerTask(caller);
      const current = yield* latestContract(task.missionId);
      if (current === null)
        return yield* fail("invalid_state", "No contract has been proposed yet.");
      if (current.version !== input.version)
        return yield* fail(
          "contract_version_mismatch",
          `The current contract is v${current.version}; acknowledge that version.`,
        );
      const match = yield* recordDecision(
        task.missionId,
        contractMatchDecision({ contract: current.spec, ackNote: input.note }),
      );
      let acknowledged = current;
      yield* mutate(
        task.missionId,
        Effect.gen(function* () {
          const latest = yield* latestContract(task.missionId);
          if (latest === null || latest.version !== input.version)
            return yield* fail(
              "contract_version_mismatch",
              "The contract changed while acknowledging; read it again.",
            );
          acknowledged = {
            ...latest,
            acks: [
              ...latest.acks.filter((ack) => ack.taskKey !== task.key),
              {
                taskKey: task.key,
                version: input.version,
                acknowledgedAt: yield* nowIso,
                note: input.note.slice(0, 1_000),
              },
            ],
          };
          yield* store.putContract(acknowledged).pipe(Effect.mapError(storage));
          const proposedEvent = yield* latestEventOfType(task.missionId, "contract.proposed");
          const ack = yield* emit({
            missionId: task.missionId,
            type: "contract.acknowledged",
            actor: `task:${task.key}`,
            summary: `${task.key} acknowledged contract v${input.version}`,
            payload: { version: input.version, note: input.note.slice(0, 1_000) },
            causedBy: proposedEvent,
          });
          yield* persistDecision(match, ack.eventId);
          const fresh = yield* store.listTasks(task.missionId).pipe(Effect.mapError(storage));
          const self = fresh.find((t) => t.key === task.key);
          // Jev leaning "mismatch" holds integration for a human; it never unblocks anything.
          const doubted = (match.probabilities["true"] ?? 1) < 0.5;
          if (self !== undefined && doubted) {
            const review = `${CONTRACT_REVIEW_PREFIX} v${input.version} acknowledgment may not match`;
            yield* saveTask({ ...self, blockedOn: [review] });
            yield* emit({
              missionId: task.missionId,
              type: "task.blocked",
              actor: "goagent",
              summary: `${task.key}: Jev doubts the acknowledgment matches contract v${input.version}; override the contract.match decision to accept it`,
              payload: { taskKey: task.key, blockedOn: [review], decisionId: match.decisionId },
              causedBy: ack.eventId,
            });
          } else if (self !== undefined && self.blockedOn.length > 0) {
            yield* saveTask({ ...self, blockedOn: [] });
            yield* emit({
              missionId: task.missionId,
              type: "task.unblocked",
              actor: "goagent",
              summary: `${task.key} may integrate against contract v${input.version}`,
              payload: { taskKey: task.key, was: self.blockedOn },
              causedBy: ack.eventId,
            });
          }
        }),
      );
      return acknowledged;
    },
  );

  const agentRecordDecision = Effect.fn("GoAgentMissionService.agentRecordDecision")(function* (
    caller: AgentCaller,
    input: { readonly decision: string; readonly reason: string },
  ) {
    const task = yield* requireCallerTask(caller);
    const events = yield* store
      .listEvents(task.missionId, EVENT_TAIL)
      .pipe(Effect.mapError(storage));
    const mine = events.filter(
      (e) => e.type === "agent.decision" && e.actor === `task:${task.key}`,
    );
    if (mine.length >= MAX_AGENT_DECISIONS_PER_TASK)
      return yield* fail(
        "invalid_state",
        `You have recorded ${MAX_AGENT_DECISIONS_PER_TASK} decisions; record only the significant ones.`,
      );
    yield* mutate(
      task.missionId,
      emit({
        missionId: task.missionId,
        type: "agent.decision",
        actor: `task:${task.key}`,
        summary: `${task.key}: ${input.decision.slice(0, 160)}`,
        payload: {
          taskKey: task.key,
          decision: input.decision.slice(0, 500),
          reason: input.reason.slice(0, 1_000),
        },
      }),
    );
    return { recorded: mine.length + 1 };
  });

  /** An agent hands a note to "whoever needs it"; Jev picks the receiving agent. */
  const agentHandoff = Effect.fn("GoAgentMissionService.agentHandoff")(function* (
    caller: AgentCaller,
    input: { readonly note: string; readonly files: ReadonlyArray<string> },
  ) {
    const task = yield* requireCallerTask(caller);
    const mission = yield* requireMission(task.missionId);
    yield* requireState(mission, ["running"], "hand off work in");
    if ((yield* handoffCount(mission.missionId)).length >= MAX_HANDOFFS_PER_MISSION)
      return yield* fail(
        "invalid_state",
        "This mission's handoff budget is used; finish your part and mention the issue in your summary.",
      );
    const tasks = yield* store.listTasks(mission.missionId).pipe(Effect.mapError(storage));
    const candidates = tasks.filter(
      (t) =>
        t.key !== task.key && t.threadId !== null && ["running", "completed"].includes(t.state),
    );
    const planned = mission.plan.tasks.filter((t) => candidates.some((c) => c.key === t.key));
    const owners = input.files
      .map((file) => ownerOfPath(planned, file))
      .filter((owner): owner is string => owner !== null);
    const fileOwner =
      owners.length === 0
        ? null
        : [...new Set(owners)].toSorted(
            (a, b) => owners.filter((o) => o === b).length - owners.filter((o) => o === a).length,
          )[0]!;
    const strongest = (mission.plan.coupling ?? [])
      .filter(
        (c) =>
          (c.from === task.key && planned.some((t) => t.key === c.to)) ||
          (c.to === task.key && planned.some((t) => t.key === c.from)),
      )
      .toSorted((a, b) => b.edgeCount - a.edgeCount)[0];
    const decision = yield* recordDecision(
      mission.missionId,
      handoffRouteDecision({
        fromTask: task.key,
        note: input.note,
        files: input.files,
        candidates: planned,
        fileOwner,
        strongestCoupling:
          strongest === undefined
            ? null
            : strongest.from === task.key
              ? strongest.to
              : strongest.from,
      }),
      { taskKey: task.key },
    );
    const target = candidates.find((t) => t.key === decision.answer);
    const routed = target === undefined ? decision : { ...decision, targetTaskKey: target.key };
    yield* mutate(
      mission.missionId,
      Effect.gen(function* () {
        yield* persistDecision(routed);
        if (target === undefined) return;
        const current = (yield* store
          .listTasks(mission.missionId)
          .pipe(Effect.mapError(storage))).find((t) => t.key === target.key);
        if (current === undefined || current.threadId === null) return;
        yield* sendHandoff({
          mission,
          from: task.key,
          to: current,
          text: renderHandoffMessage({
            fromTask: task.key,
            changedFiles: input.files,
            links: [],
            note: input.note.slice(0, 1_500),
            contract: yield* latestContract(mission.missionId),
          }),
          summary: `Switched to ${target.key}: note from ${task.key}`,
          decisionId: decision.decisionId,
          causedBy: null,
        });
      }),
    );
    return {
      routedTo: target?.key ?? null,
      source: decision.source,
      confidence: decision.confidence,
    };
  });

  /** Records an agent's graph tool call in the mission audit (GoAgent.md AC-03). */
  const auditGraphQuery = (
    caller: AgentCaller,
    what: string,
    payload: { readonly nodeIds: ReadonlyArray<string> } & Record<string, unknown>,
  ) =>
    requireCallerTask(caller).pipe(
      Effect.flatMap((task) =>
        mutate(
          task.missionId,
          emit({
            missionId: task.missionId,
            type: "graph.queried",
            actor: `task:${task.key}`,
            summary: `${task.key} ${what}: ${payload.nodeIds.length} result(s)`,
            payload: {
              ...payload,
              nodeIds: payload.nodeIds.slice(0, 40),
              resultCount: payload.nodeIds.length,
            },
          }),
        ),
      ),
      Effect.asVoid,
    );

  const callerScan = (caller: AgentCaller) =>
    requireCallerTask(caller).pipe(
      Effect.flatMap((task) => requireMission(task.missionId)),
      Effect.flatMap((mission) =>
        mission.baseScanId === null
          ? Effect.fail(
              fail(
                "scan_not_found",
                "This mission has no knowledge graph; index the project first.",
              ),
            )
          : Effect.succeed(mission.baseScanId),
      ),
    );

  const snapshotCommit = Effect.fn("GoAgentMissionService.snapshotCommit")(function* (
    worktreePath: string,
    taskKey: string,
  ) {
    const status = yield* gitRun("status", worktreePath, ["status", "--porcelain"]);
    if (status.stdout.trim().length === 0) return false;
    yield* gitRun("add", worktreePath, ["add", "-A"]);
    const commit = yield* gitRun("commit", worktreePath, [
      ...GOAGENT_GIT_IDENTITY,
      "commit",
      "--no-verify",
      "-m",
      `goagent: snapshot of uncommitted ${taskKey} work`,
    ]);
    return commit.exitCode === 0;
  });

  const onRunSettled = Effect.fn("GoAgentMissionService.onRunSettled")(function* (
    run: OrchestrationV2Run,
  ) {
    const found = yield* store.findTaskByThread(run.threadId).pipe(Effect.mapError(storage));
    if (Option.isNone(found)) return;
    const task = found.value;
    const missionId = task.missionId;
    if (ACTIVE_RUN_STATUSES.has(run.status)) {
      if (task.state === "completed" || task.state === "failed") {
        yield* mutate(
          missionId,
          Effect.gen(function* () {
            yield* saveTask({ ...task, state: "running", failureReason: null, finishedAt: null });
            yield* emit({
              missionId,
              type: "task.started",
              actor: `task:${task.key}`,
              summary: `${task.key} is working again`,
            });
          }),
        );
      }
      return;
    }
    if (task.state !== "running") return;
    if (TERMINAL_FAILURE_STATUSES.has(run.status)) {
      yield* mutate(
        missionId,
        Effect.gen(function* () {
          yield* saveTask({
            ...task,
            state: "failed",
            failureReason: `Agent run ${run.status}`,
            finishedAt: yield* nowIso,
          });
          yield* emit({
            missionId,
            type: "task.failed",
            actor: `task:${task.key}`,
            summary: `${task.key} ${run.status}`,
            payload: { taskKey: task.key, runStatus: run.status },
          });
        }),
      );
      return;
    }
    if (run.status !== "completed") return;
    const mission = yield* requireMission(missionId);
    const projection = yield* threads.getThreadProjection(run.threadId).pipe(Effect.option);
    const worktreePath =
      Option.flatMapNullishOr(projection, (p) => p.thread.worktreePath).pipe(Option.getOrNull) ??
      task.worktreePath;
    if (worktreePath === null || mission.baseSha === null) {
      yield* mutate(
        missionId,
        Effect.gen(function* () {
          yield* saveTask({
            ...task,
            state: "needs_review",
            failureReason: "The task has no worktree to collect.",
            finishedAt: yield* nowIso,
          });
          yield* emit({
            missionId,
            type: "task.failed",
            actor: "goagent",
            summary: `${task.key}: no worktree found`,
          });
        }),
      );
      return;
    }
    const snapshotted = yield* snapshotCommit(worktreePath, task.key).pipe(
      Effect.orElseSucceed(() => false),
    );
    const head = yield* headSha(worktreePath).pipe(Effect.orElseSucceed(() => null));
    const diff = yield* gitRun("diff", worktreePath, [
      "diff",
      "--name-only",
      `${mission.baseSha}..HEAD`,
    ]).pipe(
      Effect.map((r) =>
        r.exitCode === 0
          ? r.stdout
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
          : [],
      ),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    let completedEvent: GoAgentEvent | null = null;
    yield* mutate(
      missionId,
      Effect.gen(function* () {
        const current = (yield* store.listTasks(missionId).pipe(Effect.mapError(storage))).find(
          (t) => t.key === task.key,
        );
        if (current === undefined || current.state !== "running") return;
        yield* saveTask({
          ...current,
          state: "completed",
          worktreePath,
          headSha: head,
          changedFiles: diff,
          finishedAt: yield* nowIso,
        });
        completedEvent = yield* emit({
          missionId,
          type: "task.completed",
          actor: `task:${task.key}`,
          summary: `${task.key} finished: ${diff.length} file(s) changed${snapshotted ? " (GoAgent committed leftover changes)" : ""}`,
          payload: {
            taskKey: task.key,
            headSha: head,
            changedFiles: diff.slice(0, 200),
            snapshotCommitted: snapshotted,
          },
        });
        yield* releaseBlocked(missionId, completedEvent.eventId);
      }),
    );
    if (completedEvent === null) return;
    // Graph delta runs after the lock is released; it can take seconds.
    const completedEventId = (completedEvent as GoAgentEvent).eventId;
    const taskScanId = yield* indexTaskWorktree(
      mission,
      task.key,
      worktreePath,
      completedEventId,
    ).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        mutate(
          missionId,
          emit({
            missionId,
            type: "graph.indexed",
            actor: "goagent",
            summary: `Graph for ${task.key} could not be built: ${error.message}`,
            payload: { taskKey: task.key, failed: true },
          }),
        ).pipe(Effect.ignore, Effect.as(Option.none<GoAgentScanId>())),
      ),
    );
    yield* handoffAfterCompletion({
      missionId,
      fromTask: task.key,
      changedFiles: diff,
      scanId: Option.getOrNull(taskScanId) ?? mission.baseScanId,
      causedBy: completedEventId,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("GoAgent handoff coordination failed", { error: error.message }),
      ),
    );
    yield* finishRepairRound(missionId);
  });

  /**
   * A completed run is handled while the mission is marked coordinating, from before the task is
   * marked completed until its graph delta and handoff decisions are done, so integration cannot
   * slip in between and merge work an agent is about to be switched back onto.
   */
  const settleRun = (run: OrchestrationV2Run) =>
    run.status !== "completed"
      ? onRunSettled(run)
      : store.findTaskByThread(run.threadId).pipe(
          Effect.mapError(storage),
          Effect.flatMap((found) =>
            Option.isNone(found)
              ? Effect.void
              : whileCoordinating(found.value.missionId, onRunSettled(run)),
          ),
        );

  const handoffCount = (missionId: GoAgentMissionId) =>
    store.listEvents(missionId, EVENT_TAIL).pipe(
      Effect.mapError(storage),
      Effect.map((events) => events.filter((e) => e.type === "handoff.sent")),
    );

  /** Switches work to another agent's thread and records it. Runs inside `mutate`. */
  const sendHandoff = Effect.fn("GoAgentMissionService.sendHandoff")(function* (input: {
    readonly mission: GoAgentMission;
    readonly from: string;
    readonly to: GoAgentTask;
    readonly text: string;
    readonly summary: string;
    readonly decisionId: GoAgentDecisionId;
    readonly causedBy: GoAgentEventId | null;
  }) {
    const threadId = input.to.threadId!;
    const commandId = CommandId.make(`goagent:handoff:${threadId}:${yield* uuid}`);
    yield* threads
      .sendToThread({
        projectId: input.mission.projectId,
        commandId,
        threadId,
        messageId: MessageId.make(commandId),
        text: input.text,
        attachments: [],
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.mapError(() =>
          fail("provider_unavailable", `Could not hand work to ${input.to.key}.`),
        ),
      );
    // A finished agent works again; its run settles into `completed` once more.
    if (input.to.state === "completed")
      yield* saveTask({ ...input.to, state: "running", finishedAt: null });
    yield* emit({
      missionId: input.mission.missionId,
      type: "handoff.sent",
      actor: "goagent",
      summary: input.summary,
      payload: { from: input.from, to: input.to.key, decisionId: input.decisionId },
      causedBy: input.causedBy,
    });
  });

  /**
   * When an agent finishes, every other agent whose code uses the changed files (per the knowledge
   * graph) is a candidate; Jev decides for each whether to switch to it now. Each ordered pair is
   * handed off at most once per mission, and the mission has a handoff budget.
   */
  const handoffAfterCompletion = Effect.fn("GoAgentMissionService.handoffAfterCompletion")(
    function* (input: {
      readonly missionId: GoAgentMissionId;
      readonly fromTask: string;
      readonly changedFiles: ReadonlyArray<string>;
      readonly scanId: GoAgentScanId | null;
      readonly causedBy: GoAgentEventId;
    }) {
      if (input.scanId === null || input.changedFiles.length === 0) return;
      const mission = yield* requireMission(input.missionId);
      if (mission.state !== "running") return;
      const rows = yield* store.getScanGraph(input.scanId).pipe(Effect.mapError(storage));
      const impacted = impactedTasks({
        tasks: mission.plan.tasks,
        fromTask: input.fromTask,
        changedFiles: input.changedFiles,
        graph: rows,
      });
      for (const impact of impacted) {
        const sent = yield* handoffCount(input.missionId);
        if (sent.length >= MAX_HANDOFFS_PER_MISSION) return;
        if (sent.some((e) => e.payload.from === input.fromTask && e.payload.to === impact.taskKey))
          continue;
        const tasks = yield* store.listTasks(input.missionId).pipe(Effect.mapError(storage));
        const target = tasks.find((t) => t.key === impact.taskKey);
        // Agents not started yet get the latest state in their first prompt instead.
        if (target === undefined || target.threadId === null) continue;
        if (!["running", "completed"].includes(target.state)) continue;
        const decision = yield* recordDecision(
          input.missionId,
          handoffNotifyDecision({
            fromTask: input.fromTask,
            toTask: { key: target.key, title: target.title, state: target.state },
            changedFiles: input.changedFiles,
            links: impact.links,
          }),
          { taskKey: input.fromTask, targetTaskKey: target.key },
        );
        yield* mutate(
          input.missionId,
          Effect.gen(function* () {
            yield* persistDecision(decision, input.causedBy);
            if (decision.answer !== "notify") return;
            const current = (yield* store
              .listTasks(input.missionId)
              .pipe(Effect.mapError(storage))).find((t) => t.key === target.key);
            if (current === undefined || current.threadId === null) return;
            yield* sendHandoff({
              mission,
              from: input.fromTask,
              to: current,
              text: renderHandoffMessage({
                fromTask: input.fromTask,
                changedFiles: input.changedFiles,
                links: impact.links,
                note: null,
                contract: yield* latestContract(input.missionId),
              }),
              summary: `Switched to ${target.key}: ${input.fromTask}'s changes touch its code (${impact.links.length} graph link(s))`,
              decisionId: decision.decisionId,
              causedBy: input.causedBy,
            });
          }),
        );
      }
    },
  );

  /**
   * After the repairing agent finishes, re-integrate and re-verify with the already approved
   * commands (GoAgent.md §11). Runs once per repair round: only while that round has not been
   * integrated yet and every task is completed again.
   */
  const finishRepairRound = Effect.fn("GoAgentMissionService.finishRepairRound")(function* (
    missionId: GoAgentMissionId,
  ) {
    const events = yield* store.listEvents(missionId, EVENT_TAIL).pipe(Effect.mapError(storage));
    const lastRepair = events.findLast((event) => event.type === "repair.requested");
    if (lastRepair === undefined) return;
    if (events.some((e) => e.type === "integration.started" && e.sequence > lastRepair.sequence))
      return;
    const mission = yield* requireMission(missionId);
    if (mission.state !== "running") return;
    const tasks = yield* store.listTasks(missionId).pipe(Effect.mapError(storage));
    if (!tasks.every((task) => task.state === "completed")) return;
    const integrated = yield* integrateMission(missionId, "goagent");
    if (integrated.mission.integration.status !== "completed") return;
    yield* verifyMission({ missionId });
  });

  const requestRepair = Effect.fn("GoAgentMissionService.requestRepair")(function* (input: {
    readonly missionId: GoAgentMissionId;
    readonly taskKey?: string | undefined;
  }) {
    const mission = yield* requireMission(input.missionId);
    yield* requireState(mission, ["needs_review"], "repair");
    const runs = yield* store
      .listVerificationRuns(mission.missionId)
      .pipe(Effect.mapError(storage));
    const failed = runs.findLast((run) => run.status === "failed" || run.status === "timed_out");
    if (failed === undefined || mission.integration.status !== "completed")
      return yield* fail(
        "invalid_state",
        "Repair needs a failed verification of the integrated code.",
      );
    const events = yield* store
      .listEvents(mission.missionId, EVENT_TAIL)
      .pipe(Effect.mapError(storage));
    if (events.filter((event) => event.type === "repair.requested").length >= MAX_REPAIR_ROUNDS)
      return yield* fail(
        "invalid_state",
        "The one repair round for this mission is used. Fix the remaining failure by hand.",
      );
    const owner = (yield* store.listDecisions(mission.missionId).pipe(Effect.mapError(storage)))
      .filter((decision) => decision.key === "failure.owner")
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    const taskKey = input.taskKey ?? owner?.answer;
    if (taskKey === undefined || taskKey === "unknown")
      return yield* fail(
        "invalid_state",
        "No agent was identified as the owner of this failure. Choose one to send the repair to.",
      );
    const tasks = yield* store.listTasks(mission.missionId).pipe(Effect.mapError(storage));
    const task = tasks.find((t) => t.key === taskKey);
    const planTask = mission.plan.tasks.find((t) => t.key === taskKey);
    if (task === undefined || planTask === undefined || task.threadId === null)
      return yield* fail("invalid_state", `Task "${taskKey}" has no agent thread to repair with.`);
    const threadId = task.threadId;
    const command = (yield* store
      .getVerificationCommands(mission.projectId)
      .pipe(Effect.mapError(storage))).find((c) => c.id === failed.commandId);
    const reason =
      input.taskKey !== undefined || owner === undefined
        ? "the user chose this task"
        : owner.source === "jev"
          ? `Jev picked this task (${Math.round((owner.confidence ?? 0) * 100)}%)`
          : owner.source === "human_override"
            ? "the user picked this task"
            : (owner.fallbackReason ?? "the fallback rule picked this task");
    const text = renderRepairBrief({
      task: planTask,
      command: command?.label ?? failed.argv.join(" "),
      status: failed.status,
      exitCode: failed.exitCode,
      logExcerpt: failed.outputExcerpt,
      contract: yield* latestContract(mission.missionId),
      reason,
    });
    yield* mutate(
      mission.missionId,
      Effect.gen(function* () {
        const current = yield* requireMission(mission.missionId);
        yield* requireState(current, ["needs_review"], "repair");
        const commandId = CommandId.make(`goagent:repair:${threadId}:${yield* uuid}`);
        yield* threads
          .sendToThread({
            projectId: mission.projectId,
            commandId,
            threadId,
            messageId: MessageId.make(commandId),
            text,
            attachments: [],
            mode: "auto",
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(
            Effect.mapError(() =>
              fail("provider_unavailable", `Could not send the repair brief to ${task.key}.`),
            ),
          );
        yield* saveTask({ ...task, state: "running", failureReason: null, finishedAt: null });
        yield* saveMission({ ...current, state: "running", failureReason: null });
        yield* emit({
          missionId: mission.missionId,
          type: "repair.requested",
          actor: input.taskKey === undefined ? "goagent" : "user",
          summary: `Repair sent to ${task.key} after ${failed.commandId} ${failed.status}`,
          payload: {
            taskKey: task.key,
            runId: failed.runId,
            decisionId: owner?.decisionId ?? null,
          },
          causedBy: yield* latestEventOfType(mission.missionId, "verification.finished"),
        });
      }),
    );
    return yield* snapshot(mission.missionId);
  });

  const indexTaskWorktree = Effect.fn("GoAgentMissionService.indexTaskWorktree")(function* (
    mission: GoAgentMission,
    taskKey: string,
    worktreePath: string,
    causedBy: GoAgentEventId,
  ) {
    const scan = yield* graph.index({
      projectId: mission.projectId,
      root: worktreePath,
      scope: "task",
      missionId: mission.missionId,
      taskKey,
    });
    const delta =
      mission.baseScanId === null ? null : yield* graph.delta(mission.baseScanId, scan.scanId);
    yield* mutate(
      mission.missionId,
      Effect.gen(function* () {
        const current = (yield* store
          .listTasks(mission.missionId)
          .pipe(Effect.mapError(storage))).find((t) => t.key === taskKey);
        if (current !== undefined) yield* saveTask({ ...current, scanId: scan.scanId });
        const indexed = yield* emit({
          missionId: mission.missionId,
          type: "graph.indexed",
          actor: "goagent",
          summary: `Graph for ${taskKey}: ${scan.nodeCount} nodes, ${scan.edgeCount} edges`,
          payload: { taskKey, scanId: scan.scanId },
          causedBy,
        });
        if (delta !== null)
          yield* emit({
            missionId: mission.missionId,
            type: "graph.delta",
            actor: "goagent",
            summary: `${taskKey} changed the graph: +${delta.addedNodes.length}/−${delta.removedNodes.length} nodes, +${delta.addedEdges.length}/−${delta.removedEdges.length} edges`,
            payload: {
              taskKey,
              baseScanId: delta.baseScanId,
              scanId: delta.scanId,
              addedNodes: delta.addedNodes.length,
              removedNodes: delta.removedNodes.length,
              addedEdges: delta.addedEdges.length,
              removedEdges: delta.removedEdges.length,
            },
            causedBy: indexed.eventId,
          });
      }),
    );
    return scan.scanId;
  });

  const integrateMission = Effect.fn("GoAgentMissionService.integrateMission")(function* (
    missionId: GoAgentMissionId,
    actor: "user" | "goagent" = "user",
  ) {
    const mission = yield* requireMission(missionId);
    yield* requireState(mission, ["running", "needs_review"], "integrate");
    const tasks = yield* store.listTasks(missionId).pipe(Effect.mapError(storage));
    if (coordinating.has(missionId))
      return yield* fail(
        "invalid_state",
        "GoAgent is still coordinating a finished agent (graph update and handoffs). Try again in a moment.",
      );
    const unfinished = tasks.filter((t) => t.state !== "completed");
    if (unfinished.length > 0)
      return yield* fail(
        "invalid_state",
        `Waiting for: ${unfinished.map((t) => `${t.key} (${t.state})`).join(", ")}.`,
      );
    const underReview = tasks.filter((t) =>
      t.blockedOn.some((b) => b.startsWith(CONTRACT_REVIEW_PREFIX)),
    );
    if (underReview.length > 0)
      return yield* fail(
        "contract_version_mismatch",
        `Review the contract acknowledgment of ${underReview.map((t) => t.key).join(", ")} first (Decisions panel, contract.match).`,
      );
    const contract = yield* latestContract(missionId);
    for (const planTask of mission.plan.tasks) {
      if (!planTask.dependsOn.includes(GOAGENT_CONTRACT_DEPENDENCY) || contract === null) continue;
      if (
        !contract.acks.some(
          (ack) => ack.taskKey === planTask.key && ack.version === contract.version,
        )
      )
        return yield* fail(
          "contract_version_mismatch",
          `${planTask.key} has not acknowledged contract v${contract.version}; integration would combine incompatible work.`,
        );
    }
    // Integrate what each task worktree holds now, so commits made there after the agent
    // finished (a repair, or a conflict fixed by hand) are not silently dropped.
    const refreshed: Array<{
      readonly key: string;
      readonly from: string | null;
      readonly to: string;
    }> = [];
    const heads = new Map<string, string | null>();
    for (const task of tasks) {
      const current =
        task.worktreePath === null
          ? null
          : yield* headSha(task.worktreePath).pipe(Effect.orElseSucceed(() => null));
      if (current !== null && current !== task.headSha) {
        refreshed.push({ key: task.key, from: task.headSha, to: current });
        yield* mutate(missionId, saveTask({ ...task, headSha: current }));
      }
      heads.set(task.key, current ?? task.headSha);
    }
    const project = yield* requireProject(mission.projectId);
    const integrationPath = path.join(worktreesDir, `goagent-${missionId.slice(0, 8)}-integration`);
    const started = yield* mutate(
      missionId,
      Effect.gen(function* () {
        yield* saveMission({
          ...mission,
          state: "integrating",
          integration: {
            ...mission.integration,
            status: "running",
            worktreePath: integrationPath,
            conflictFiles: [],
            failure: null,
          },
        });
        return yield* emit({
          missionId,
          type: "integration.started",
          actor,
          summary:
            refreshed.length === 0
              ? "Integration started in a dedicated worktree"
              : `Integration started; newer commits found in ${refreshed.map((r) => r.key).join(", ")}`,
          payload: { refreshedHeads: refreshed },
        });
      }),
    );
    const finish = (
      integration: GoAgentMission["integration"],
      state: GoAgentMission["state"],
      type: GoAgentEventType,
      summary: string,
      payload: Record<string, unknown>,
    ) =>
      mutate(
        missionId,
        Effect.gen(function* () {
          const current = yield* requireMission(missionId);
          yield* saveMission({
            ...current,
            state,
            integration,
            failureReason: integration.failure,
          });
          yield* emit({
            missionId,
            type,
            actor: "goagent",
            summary,
            payload,
            causedBy: started.eventId,
          });
        }),
      );

    if (yield* fileSystem.exists(integrationPath).pipe(Effect.orElseSucceed(() => false))) {
      yield* gitRun("worktreeRemove", project.workspaceRoot, [
        "worktree",
        "remove",
        "--force",
        integrationPath,
      ]);
    }
    const added = yield* gitRun("worktreeAdd", project.workspaceRoot, [
      "worktree",
      "add",
      "--detach",
      integrationPath,
      mission.baseSha!,
    ]);
    if (added.exitCode !== 0) {
      yield* finish(
        {
          ...mission.integration,
          status: "failed",
          worktreePath: null,
          failure: "Could not create the integration worktree.",
        },
        "needs_review",
        "integration.failed",
        "Integration worktree could not be created",
        { stderr: added.stderr.slice(0, 2_000) },
      );
      return yield* snapshot(missionId);
    }
    const applied: Array<string> = [];
    for (const key of integrationOrder(mission.plan.tasks)) {
      const head = heads.get(key) ?? null;
      if (head === null || head === mission.baseSha) {
        applied.push(key);
        continue;
      }
      const pick = yield* gitRun("cherryPick", integrationPath, [
        ...GOAGENT_GIT_IDENTITY,
        "cherry-pick",
        "--allow-empty",
        "--keep-redundant-commits",
        `${mission.baseSha}..${head}`,
      ]);
      if (pick.exitCode !== 0) {
        const conflicts = yield* gitRun("conflicts", integrationPath, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]);
        const conflictFiles = conflicts.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        yield* gitRun("cherryPickAbort", integrationPath, ["cherry-pick", "--abort"]).pipe(
          Effect.ignore,
        );
        yield* finish(
          {
            status: "conflict",
            worktreePath: integrationPath,
            headSha: null,
            appliedTasks: applied,
            conflictFiles,
            failure: `Applying ${key} conflicted with ${applied.join(", ") || "the base"}.`,
            scanId: null,
          },
          "needs_review",
          "integration.conflict",
          `Conflict while applying ${key}: ${conflictFiles.join(", ") || "see git output"}`,
          { taskKey: key, conflictFiles, stderr: pick.stderr.slice(0, 2_000) },
        );
        return yield* snapshot(missionId);
      }
      applied.push(key);
    }
    const integratedHead = yield* headSha(integrationPath);
    const scan = yield* graph
      .index({
        projectId: mission.projectId,
        root: integrationPath,
        scope: "integration",
        missionId,
      })
      .pipe(Effect.option);
    yield* finish(
      {
        status: "completed",
        worktreePath: integrationPath,
        headSha: integratedHead,
        appliedTasks: applied,
        conflictFiles: [],
        failure: null,
        scanId: Option.isSome(scan) ? scan.value.scanId : null,
      },
      "verifying",
      "integration.completed",
      `Integrated ${applied.join(" → ")} at ${integratedHead?.slice(0, 8) ?? "unknown"}`,
      {
        appliedTasks: applied,
        headSha: integratedHead,
        scanId: Option.isSome(scan) ? scan.value.scanId : null,
      },
    );
    return yield* snapshot(missionId);
  });

  const verifyMission = Effect.fn("GoAgentMissionService.verifyMission")(function* (input: {
    readonly missionId: GoAgentMissionId;
    readonly commandId?: string | undefined;
  }) {
    const mission = yield* requireMission(input.missionId);
    yield* requireState(mission, ["verifying", "completed", "needs_review"], "verify");
    if (mission.integration.status !== "completed" || mission.integration.worktreePath === null)
      return yield* fail("invalid_state", "Integrate the mission before verifying it.");
    const approved = yield* store
      .getVerificationCommands(mission.projectId)
      .pipe(Effect.mapError(storage));
    const planned = approved.filter((c) => mission.plan.verificationCommandIds.includes(c.id));
    const commands =
      input.commandId === undefined
        ? planned.length > 0
          ? planned
          : approved
        : approved.filter((c) => c.id === input.commandId);
    if (commands.length === 0)
      return yield* fail(
        "verification_not_approved",
        "No approved verification command matches. Approve commands in the Verify panel first.",
      );
    const cwd = mission.integration.worktreePath;
    let allPassed = true;
    let lastFailure: GoAgentVerificationRun | null = null;
    for (const command of commands) {
      const runId = GoAgentVerificationRunId.make(yield* uuid);
      const startedAt = yield* nowIso;
      const running: GoAgentVerificationRun = {
        runId,
        missionId: mission.missionId,
        commandId: command.id,
        argv: command.argv,
        status: "running",
        exitCode: null,
        timedOut: false,
        startedAt,
        finishedAt: null,
        outputExcerpt: "",
        testSummary: null,
      };
      const startedEvent = yield* mutate(
        mission.missionId,
        Effect.gen(function* () {
          yield* store.putVerificationRun(running).pipe(Effect.mapError(storage));
          return yield* emit({
            missionId: mission.missionId,
            type: "verification.started",
            actor: "user",
            summary: `Running ${command.label}`,
            payload: { runId, argv: command.argv },
          });
        }),
      );
      const [executable, ...args] = command.argv;
      const output = yield* runner
        .run({
          command: executable!,
          args,
          cwd,
          timeout: Duration.millis(command.timeoutMs),
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: 400_000,
          outputMode: "truncate",
          env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
        })
        .pipe(Effect.result);
      const finishedAt = yield* nowIso;
      const run: GoAgentVerificationRun =
        output._tag === "Failure"
          ? {
              ...running,
              status: "failed",
              finishedAt,
              outputExcerpt: `Could not start ${executable}: ${output.failure.message}`,
            }
          : (() => {
              const combined = `${output.success.stdout}\n${output.success.stderr}`.trim();
              const status: GoAgentVerificationRun["status"] = output.success.timedOut
                ? "timed_out"
                : output.success.code === 0
                  ? "passed"
                  : "failed";
              return {
                ...running,
                status,
                exitCode: output.success.code,
                timedOut: output.success.timedOut,
                finishedAt,
                outputExcerpt: combined.slice(-OUTPUT_EXCERPT_BYTES),
                testSummary: parseTestSummary(combined),
              };
            })();
      yield* mutate(
        mission.missionId,
        Effect.gen(function* () {
          yield* store.putVerificationRun(run).pipe(Effect.mapError(storage));
          yield* emit({
            missionId: mission.missionId,
            type: "verification.finished",
            actor: "goagent",
            summary: `${command.label}: ${run.status}${run.exitCode === null ? "" : ` (exit ${run.exitCode})`}`,
            payload: {
              runId,
              status: run.status,
              exitCode: run.exitCode,
              testSummary: run.testSummary,
            },
            causedBy: startedEvent.eventId,
          });
        }),
      );
      if (run.status !== "passed") {
        allPassed = false;
        lastFailure = run;
        break;
      }
    }
    const tasks = yield* store.listTasks(mission.missionId).pipe(Effect.mapError(storage));
    const owner =
      lastFailure === null
        ? null
        : yield* recordDecision(
            mission.missionId,
            failureOwnerDecision({
              logExcerpt: lastFailure.outputExcerpt,
              tasks: mission.plan.tasks.filter((t) => tasks.some((x) => x.key === t.key)),
            }),
          );
    yield* mutate(
      mission.missionId,
      Effect.gen(function* () {
        const current = yield* requireMission(mission.missionId);
        if (allPassed) {
          yield* saveMission({ ...current, state: "completed", failureReason: null });
          yield* emit({
            missionId: mission.missionId,
            type: "mission.completed",
            actor: "goagent",
            summary: "All approved checks passed on the integrated code",
          });
        } else {
          const reason = `${lastFailure!.commandId} ${lastFailure!.status}`;
          yield* saveMission({ ...current, state: "needs_review", failureReason: reason });
          if (owner !== null) yield* persistDecision(owner);
          yield* emit({
            missionId: mission.missionId,
            type: "mission.failed",
            actor: "goagent",
            summary: `Verification did not pass: ${reason}${owner === null ? "" : `; likely owner: ${owner.answer}`}`,
          });
        }
      }),
    );
    return yield* snapshot(mission.missionId);
  });

  yield* orchestrator.streamDomainEvents.pipe(
    Stream.filter((event) => event.type === "run.updated" || event.type === "run.created"),
    Stream.runForEach((event) =>
      settleRun(event.payload as OrchestrationV2Run).pipe(
        Effect.catch((error) =>
          Effect.logWarning("GoAgent could not settle a task run", { error: error.message }),
        ),
      ),
    ),
    Effect.catch((error) =>
      Effect.logError("GoAgent run watcher stopped", { error: String(error) }),
    ),
    Effect.forkScoped,
  );

  yield* Effect.gen(function* () {
    const active = yield* store.listActiveMissions.pipe(Effect.orElseSucceed(() => []));
    for (const mission of active) {
      const tasks = yield* store.listTasks(mission.missionId).pipe(Effect.orElseSucceed(() => []));
      for (const task of tasks) {
        if (task.state !== "running" || task.threadId === null) continue;
        const projection = yield* threads.getThreadProjection(task.threadId).pipe(Effect.option);
        const latest = Option.flatMapNullishOr(projection, (p) => p.runs.at(-1)).pipe(
          Option.getOrNull,
        );
        if (latest === null) {
          yield* mutate(
            mission.missionId,
            Effect.gen(function* () {
              yield* saveTask({
                ...task,
                state: "interrupted",
                failureReason: "The agent thread was not found after a restart.",
              });
              yield* emit({
                missionId: mission.missionId,
                type: "mission.interrupted",
                actor: "goagent",
                summary: `${task.key} lost its agent thread`,
              });
            }),
          ).pipe(Effect.ignore);
        } else if (!ACTIVE_RUN_STATUSES.has(latest.status)) {
          yield* settleRun(latest).pipe(Effect.ignore);
        }
      }
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("GoAgent reconcile failed", { error: String(error) }),
    ),
    Effect.forkScoped,
  );

  return GoAgentMissionService.of({
    updateProjectDecisions: (projectId, change) =>
      change.type === "add"
        ? addProjectDecision(projectId, change.text)
        : change.type === "import"
          ? importProjectDecisions(projectId)
          : retireProjectDecision(projectId, change.decisionId),
    agentRecordDecision,
    agentHandoff,
    agentProjectDecisions: (caller) =>
      requireCallerTask(caller).pipe(
        Effect.flatMap((task) => requireMission(task.missionId)),
        Effect.flatMap((mission) =>
          store.listProjectDecisions(mission.projectId).pipe(Effect.mapError(storage)),
        ),
      ),
    requestRepair,
    projectState,
    indexProject,
    getGraph: Effect.fn("GoAgentMissionService.getGraph")(function* (input) {
      yield* requireProject(input.projectId);
      let snap: GoAgentGraphSnapshot;
      if (input.scanId !== undefined) {
        snap = yield* graph.snapshot(input.scanId);
        if (snap.scan.projectId !== input.projectId)
          return yield* fail("scan_not_found", "The graph scan does not belong to this project.");
      } else {
        const latest = yield* graph.latestBaseScan(input.projectId);
        if (Option.isNone(latest)) return null;
        snap = yield* graph.snapshot(latest.value.scanId);
      }
      const decided = decisionGraph(
        yield* store.listProjectDecisions(input.projectId).pipe(Effect.mapError(storage)),
        snap.nodes,
      );
      return {
        ...snap,
        nodes: [...snap.nodes, ...decided.nodes],
        edges: [...snap.edges, ...decided.edges],
      };
    }),
    getGraphDelta: (input) => graph.delta(input.baseScanId, input.scanId),
    setVerificationCommands,
    createMission,
    getMission: snapshot,
    updatePlan,
    approveMission,
    startMission,
    cancelMission,
    overrideDecision,
    integrateMission: (missionId) => integrateMission(missionId),
    verifyMission,
    subscribeMission: (missionId) =>
      Stream.concat(
        Stream.fromEffect(snapshot(missionId)),
        Stream.fromPubSub(changes).pipe(
          Stream.filter((changed) => changed === missionId),
          Stream.mapEffect(() => snapshot(missionId)),
        ),
      ),
    agentTaskStatus,
    agentProposeContract,
    agentAcknowledgeContract,
    agentGraphSearch: (caller, query) =>
      callerScan(caller).pipe(
        Effect.flatMap((scanId) => graph.search(scanId, query, 25)),
        Effect.tap((nodes) =>
          auditGraphQuery(caller, `searched the graph for "${query.slice(0, 80)}"`, {
            query: query.slice(0, 200),
            nodeIds: nodes.map((n) => n.id),
          }),
        ),
      ),
    agentGraphNeighbours: (caller, nodeIds, hops) =>
      callerScan(caller).pipe(
        Effect.flatMap((scanId) =>
          graph.neighbours(scanId, nodeIds, { hops: Math.min(Math.max(hops, 1), 3), maxNodes: 80 }),
        ),
        Effect.tap((result) =>
          auditGraphQuery(caller, `explored ${nodeIds.length} node(s) of the graph`, {
            seeds: nodeIds.slice(0, 20),
            nodeIds: result.nodes.map((n) => n.id),
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(GoAgentMissionService, make);
