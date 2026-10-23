import {
  CommandId,
  GOAGENT_CONTRACT_DEPENDENCY,
  GoAgentContractId,
  GoAgentDecisionId,
  GoAgentError,
  GoAgentEventId,
  GoAgentMissionId,
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
  riskDecision,
  routeDecision,
} from "./goagentDecisions.ts";
import {
  buildPlan,
  collapseToSingle,
  integrationOrder,
  parseTestSummary,
  renderContractUpdateMessage,
  renderGraphContext,
  renderTaskPrompt,
  suggestVerificationCommands,
  validatePlan,
} from "./goagentPlanner.ts";

const EVENT_TAIL = 300;
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const OUTPUT_EXCERPT_BYTES = 12_000;
const CONTEXT_NODE_CAP = 60;
const CONTEXT_LINE_CAP = 40;
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
    readonly subscribeMission: (
      missionId: GoAgentMissionId,
    ) => Stream.Stream<GoAgentMissionSnapshot, GoAgentError>;

    readonly agentTaskStatus: (
      caller: AgentCaller,
    ) => Effect.Effect<
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
  ) {
    const outcome = yield* decisions.decide(request);
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
    };
    return decision;
  });

  const persistDecision = Effect.fn("GoAgentMissionService.persistDecision")(function* (
    decision: GoAgentDecision,
    causedBy: GoAgentEventId | null = null,
  ) {
    yield* store.putDecision(decision).pipe(Effect.mapError(storage));
    const percent =
      decision.confidence === null ? "" : ` (${Math.round(decision.confidence * 100)}%)`;
    yield* emit({
      missionId: decision.missionId,
      type: "decision.made",
      actor: decision.source === "jev" ? "jev" : "goagent",
      summary: `${decision.key} → ${decision.answer}${percent}${decision.source === "fallback" ? " [fallback]" : ""}`,
      payload: { decisionId: decision.decisionId },
      causedBy,
    });
  });

  const readSuggestions = Effect.fn("GoAgentMissionService.readSuggestions")(function* (
    root: string,
  ) {
    const packageJson = yield* fileSystem.readFileString(path.join(root, "package.json")).pipe(
      Effect.flatMap(decodeJson),
      Effect.orElseSucceed((): unknown => null),
    );
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
    return suggestVerificationCommands(packageJson, lockfiles);
  });

  const projectState = Effect.fn("GoAgentMissionService.projectState")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* requireProject(projectId);
    const [graphify, latestBaseScan, verificationCommands, missions, suggested] = yield* Effect.all(
      [
        graph.status,
        graph.latestBaseScan(projectId),
        store.getVerificationCommands(projectId).pipe(Effect.mapError(storage)),
        store.listMissions(projectId).pipe(Effect.mapError(storage)),
        readSuggestions(project.workspaceRoot),
      ],
      { concurrency: "unbounded" },
    );
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
    } satisfies GoAgentProjectState;
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
          payload: { planVersion: 1, tasks: plan.tasks.map((t) => t.key) },
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
        yield* saveMission({ ...mission, plan: input.plan, title: input.plan.title, planVersion });
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
    yield* requireState(mission, ["planned"], "approve");
    if (mission.planVersion !== input.planVersion)
      return yield* fail(
        "plan_version_mismatch",
        "The plan changed since you loaded it. Reload and retry.",
      );
    const problems = validatePlan(mission.plan, yield* approvedCommandIds(mission.projectId));
    if (problems.length > 0) return yield* fail("plan_invalid", problems.join(" "));
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
    const commandId = CommandId.make(`goagent:${mission.missionId}:${task.key}:${yield* uuid}`);
    const threadId = ThreadId.make(yield* uuid);
    const text = renderTaskPrompt({
      request: mission.request,
      plan: mission.plan,
      task: planTask,
      graphContext: context.text,
      contract,
    });
    const contextEvent = yield* emit({
      missionId: mission.missionId,
      type: "context.built",
      actor: "goagent",
      summary: `Context for ${task.key}: ${context.nodeIds.length} graph nodes`,
      payload: {
        taskKey: task.key,
        nodeIds: context.nodeIds.slice(0, 100),
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
            yield* launchTask(running, task, contract, started.eventId);
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
      yield* launchTask(mission, task, contract, unblocked.eventId);
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
        if (decision.key === "mission.route" && mission.state === "planned") {
          const files = mission.plan.tasks.flatMap((t) => t.ownsPaths);
          const project = yield* requireProject(mission.projectId);
          const plan =
            input.answer === "single_agent"
              ? collapseToSingle(mission.plan, mission.request, files)
              : buildPlan({
                  request: mission.request,
                  files: yield* trackedFiles(project.workspaceRoot),
                  verificationCommandIds: mission.plan.verificationCommandIds,
                });
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
          if (self !== undefined && self.blockedOn.length > 0) {
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
    yield* indexTaskWorktree(
      mission,
      task.key,
      worktreePath,
      (completedEvent as GoAgentEvent).eventId,
    ).pipe(
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
        ).pipe(Effect.ignore),
      ),
    );
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
  });

  const integrateMission = Effect.fn("GoAgentMissionService.integrateMission")(function* (
    missionId: GoAgentMissionId,
  ) {
    const mission = yield* requireMission(missionId);
    yield* requireState(mission, ["running", "needs_review"], "integrate");
    const tasks = yield* store.listTasks(missionId).pipe(Effect.mapError(storage));
    const unfinished = tasks.filter((t) => t.state !== "completed");
    if (unfinished.length > 0)
      return yield* fail(
        "invalid_state",
        `Waiting for: ${unfinished.map((t) => `${t.key} (${t.state})`).join(", ")}.`,
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
          actor: "user",
          summary: "Integration started in a dedicated worktree",
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
      const task = tasks.find((t) => t.key === key)!;
      if (task.headSha === null || task.headSha === mission.baseSha) {
        applied.push(key);
        continue;
      }
      const pick = yield* gitRun("cherryPick", integrationPath, [
        ...GOAGENT_GIT_IDENTITY,
        "cherry-pick",
        "--allow-empty",
        "--keep-redundant-commits",
        `${mission.baseSha}..${task.headSha}`,
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
      onRunSettled(event.payload as OrchestrationV2Run).pipe(
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
          yield* onRunSettled(latest).pipe(Effect.ignore);
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
    projectState,
    indexProject,
    getGraph: Effect.fn("GoAgentMissionService.getGraph")(function* (input) {
      yield* requireProject(input.projectId);
      if (input.scanId !== undefined) {
        const snap = yield* graph.snapshot(input.scanId);
        if (snap.scan.projectId !== input.projectId)
          return yield* fail("scan_not_found", "The graph scan does not belong to this project.");
        return snap;
      }
      const latest = yield* graph.latestBaseScan(input.projectId);
      return Option.isNone(latest) ? null : yield* graph.snapshot(latest.value.scanId);
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
    integrateMission,
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
      callerScan(caller).pipe(Effect.flatMap((scanId) => graph.search(scanId, query, 25))),
    agentGraphNeighbours: (caller, nodeIds, hops) =>
      callerScan(caller).pipe(
        Effect.flatMap((scanId) =>
          graph.neighbours(scanId, nodeIds, { hops: Math.min(Math.max(hops, 1), 3), maxNodes: 80 }),
        ),
      ),
  });
});

export const layer = Layer.effect(GoAgentMissionService, make);
