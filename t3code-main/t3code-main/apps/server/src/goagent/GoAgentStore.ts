import {
  GoAgentContract,
  GoAgentDecision,
  GoAgentEvent,
  GoAgentGraphEdge,
  GoAgentGraphNode,
  GoAgentGraphScan,
  GoAgentMission,
  GoAgentProjectDecision,
  GoAgentTask,
  GoAgentVerificationCommand,
  GoAgentVerificationRun,
  type GoAgentDecisionId,
  type GoAgentMissionId,
  type GoAgentProjectDecisionId,
  type GoAgentScanId,
  type GoAgentScanScope,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class GoAgentStoreError extends Schema.TaggedError<GoAgentStoreError>()(
  "GoAgentStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GoAgent storage failed during ${this.operation}.`;
  }
}

type Fail<A> = Effect.Effect<A, GoAgentStoreError>;

export interface GoAgentGraphRows {
  readonly nodes: ReadonlyArray<GoAgentGraphNode>;
  readonly edges: ReadonlyArray<GoAgentGraphEdge>;
}

export class GoAgentStore extends Context.Service<
  GoAgentStore,
  {
    readonly getVerificationCommands: (
      projectId: ProjectId,
    ) => Fail<ReadonlyArray<GoAgentVerificationCommand>>;
    readonly putVerificationCommands: (
      projectId: ProjectId,
      commands: ReadonlyArray<GoAgentVerificationCommand>,
      updatedAt: string,
    ) => Fail<void>;

    readonly putScan: (scan: GoAgentGraphScan) => Fail<void>;
    readonly getScan: (scanId: GoAgentScanId) => Fail<Option.Option<GoAgentGraphScan>>;
    readonly latestScan: (input: {
      readonly projectId: ProjectId;
      readonly scope: GoAgentScanScope;
      readonly status?: GoAgentGraphScan["status"];
    }) => Fail<Option.Option<GoAgentGraphScan>>;
    /** Replaces the scan's graph rows and the scan record in one transaction. */
    readonly completeScan: (scan: GoAgentGraphScan, graph: GoAgentGraphRows) => Fail<void>;
    readonly getScanGraph: (scanId: GoAgentScanId) => Fail<GoAgentGraphRows>;

    readonly putMission: (mission: GoAgentMission) => Fail<void>;
    readonly getMission: (missionId: GoAgentMissionId) => Fail<Option.Option<GoAgentMission>>;
    readonly listMissions: (projectId: ProjectId) => Fail<ReadonlyArray<GoAgentMission>>;
    readonly listActiveMissions: Fail<ReadonlyArray<GoAgentMission>>;

    readonly putTask: (task: GoAgentTask) => Fail<void>;
    readonly listTasks: (missionId: GoAgentMissionId) => Fail<ReadonlyArray<GoAgentTask>>;
    readonly findTaskByThread: (threadId: ThreadId) => Fail<Option.Option<GoAgentTask>>;

    readonly putContract: (contract: GoAgentContract) => Fail<void>;
    readonly listContracts: (missionId: GoAgentMissionId) => Fail<ReadonlyArray<GoAgentContract>>;

    readonly putDecision: (decision: GoAgentDecision) => Fail<void>;
    readonly getDecision: (decisionId: GoAgentDecisionId) => Fail<Option.Option<GoAgentDecision>>;
    readonly listDecisions: (missionId: GoAgentMissionId) => Fail<ReadonlyArray<GoAgentDecision>>;

    readonly putProjectDecision: (decision: GoAgentProjectDecision) => Fail<void>;
    /** Active (not retired) decisions, oldest first. */
    readonly listProjectDecisions: (
      projectId: ProjectId,
    ) => Fail<ReadonlyArray<GoAgentProjectDecision>>;
    readonly retireProjectDecision: (input: {
      readonly projectId: ProjectId;
      readonly decisionId: GoAgentProjectDecisionId;
      readonly retiredAt: string;
    }) => Fail<boolean>;

    readonly putVerificationRun: (run: GoAgentVerificationRun) => Fail<void>;
    readonly listVerificationRuns: (
      missionId: GoAgentMissionId,
    ) => Fail<ReadonlyArray<GoAgentVerificationRun>>;

    /** Assigns the next per-mission sequence; callers serialize appends per mission. */
    readonly appendEvent: (event: Omit<GoAgentEvent, "sequence">) => Fail<GoAgentEvent>;
    readonly listEvents: (
      missionId: GoAgentMissionId,
      limit: number,
    ) => Fail<ReadonlyArray<GoAgentEvent>>;
  }
>()("t3/goagent/GoAgentStore") {}

const json = <S extends Schema.Top>(schema: S) => ({
  encode: Schema.encodeEffect(Schema.fromJsonString(schema)),
  decode: Schema.decodeUnknownEffect(Schema.fromJsonString(schema)),
});

const Commands = json(Schema.Array(GoAgentVerificationCommand));
const MissionJson = json(GoAgentMission);
const TaskJson = json(GoAgentTask);
const ContractJson = json(GoAgentContract);
const DecisionJson = json(GoAgentDecision);
const ProjectDecisionJson = json(GoAgentProjectDecision);
const RunJson = json(GoAgentVerificationRun);
const EventJson = json(GoAgentEvent);

const ScanRow = Schema.Struct({
  scan_id: Schema.String,
  project_id: Schema.String,
  scope: Schema.String,
  mission_id: Schema.NullOr(Schema.String),
  task_key: Schema.NullOr(Schema.String),
  commit_sha: Schema.NullOr(Schema.String),
  status: Schema.String,
  graphify_version: Schema.NullOr(Schema.String),
  schema_version: Schema.NullOr(Schema.Number),
  node_count: Schema.Number,
  edge_count: Schema.Number,
  started_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
});

const decodeScanRow = Schema.decodeUnknownEffect(ScanRow);
const decodeScanRecord = Schema.decodeUnknownEffect(GoAgentGraphScan);

const decodeScan = (row: unknown) =>
  decodeScanRow(row).pipe(
    Effect.flatMap((r) =>
      decodeScanRecord({
        scanId: r.scan_id,
        projectId: r.project_id,
        scope: r.scope,
        missionId: r.mission_id,
        taskKey: r.task_key,
        commitSha: r.commit_sha,
        status: r.status,
        graphifyVersion: r.graphify_version,
        schemaVersion: r.schema_version,
        nodeCount: r.node_count,
        edgeCount: r.edge_count,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        failure: r.failure,
      }),
    ),
  );

const NodeRow = Schema.Struct({
  node_id: Schema.String,
  label: Schema.String,
  kind: Schema.String,
  source_file: Schema.NullOr(Schema.String),
  source_location: Schema.NullOr(Schema.String),
  community: Schema.NullOr(Schema.Number),
});

const EdgeRow = Schema.Struct({
  source_id: Schema.String,
  target_id: Schema.String,
  relation: Schema.String,
  evidence: Schema.String,
  confidence_score: Schema.Number,
  source_file: Schema.NullOr(Schema.String),
  source_location: Schema.NullOr(Schema.String),
});

const decodeNodeRow = Schema.decodeUnknownEffect(NodeRow);
const decodeNode = Schema.decodeUnknownEffect(GoAgentGraphNode);
const decodeEdgeRow = Schema.decodeUnknownEffect(EdgeRow);
const decodeEdge = Schema.decodeUnknownEffect(GoAgentGraphEdge);
const decodeEvent = Schema.decodeUnknownEffect(GoAgentEvent);

// SQLite caps bound parameters per statement; keep multi-row inserts well under it.
const INSERT_CHUNK = 100;

const chunks = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const fail =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.mapError(effect, (cause) => new GoAgentStoreError({ operation, cause }));

  const decodeAll = <A>(
    rows: ReadonlyArray<{ readonly doc: unknown }>,
    decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) => Effect.forEach(rows, (row) => decode(row.doc));

  const putScan = (scan: GoAgentGraphScan) =>
    sql`
      INSERT INTO goagent_graph_scans (
        scan_id, project_id, scope, mission_id, task_key, commit_sha, status, graphify_version,
        schema_version, node_count, edge_count, started_at, finished_at, failure
      ) VALUES (
        ${scan.scanId}, ${scan.projectId}, ${scan.scope}, ${scan.missionId}, ${scan.taskKey},
        ${scan.commitSha}, ${scan.status}, ${scan.graphifyVersion}, ${scan.schemaVersion},
        ${scan.nodeCount}, ${scan.edgeCount}, ${scan.startedAt}, ${scan.finishedAt}, ${scan.failure}
      )
      ON CONFLICT (scan_id) DO UPDATE SET
        commit_sha = excluded.commit_sha,
        status = excluded.status,
        graphify_version = excluded.graphify_version,
        schema_version = excluded.schema_version,
        node_count = excluded.node_count,
        edge_count = excluded.edge_count,
        finished_at = excluded.finished_at,
        failure = excluded.failure
    `.pipe(Effect.asVoid);

  return GoAgentStore.of({
    getVerificationCommands: (projectId) =>
      sql<{ readonly doc: string }>`
        SELECT verification_commands_json AS doc FROM goagent_project_settings
        WHERE project_id = ${projectId}
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed([]) : Commands.decode(rows[0].doc),
        ),
        fail("getVerificationCommands"),
      ),

    putVerificationCommands: (projectId, commands, updatedAt) =>
      Commands.encode(commands).pipe(
        Effect.flatMap(
          (doc) => sql`
            INSERT INTO goagent_project_settings (project_id, verification_commands_json, updated_at)
            VALUES (${projectId}, ${doc}, ${updatedAt})
            ON CONFLICT (project_id) DO UPDATE SET
              verification_commands_json = excluded.verification_commands_json,
              updated_at = excluded.updated_at
          `,
        ),
        Effect.asVoid,
        fail("putVerificationCommands"),
      ),

    putScan: (scan) => putScan(scan).pipe(fail("putScan")),

    getScan: (scanId) =>
      sql`SELECT * FROM goagent_graph_scans WHERE scan_id = ${scanId}`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(Option.none())
            : Effect.map(decodeScan(rows[0]), Option.some),
        ),
        fail("getScan"),
      ),

    latestScan: ({ projectId, scope, status }) =>
      sql`
        SELECT * FROM goagent_graph_scans
        WHERE project_id = ${projectId} AND scope = ${scope}
          ${status === undefined ? sql`` : sql`AND status = ${status}`}
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(Option.none())
            : Effect.map(decodeScan(rows[0]), Option.some),
        ),
        fail("latestScan"),
      ),

    completeScan: Effect.fn("GoAgentStore.completeScan")(
      function* (scan, graph) {
        yield* sql`DELETE FROM goagent_graph_nodes WHERE scan_id = ${scan.scanId}`;
        yield* sql`DELETE FROM goagent_graph_edges WHERE scan_id = ${scan.scanId}`;
        for (const batch of chunks(graph.nodes, INSERT_CHUNK)) {
          yield* sql`INSERT INTO goagent_graph_nodes ${sql.insert(
            batch.map((node) => ({
              scan_id: scan.scanId,
              node_id: node.id,
              label: node.label,
              kind: node.kind,
              source_file: node.sourceFile,
              source_location: node.sourceLocation,
              community: node.community,
            })),
          )}`;
        }
        for (const batch of chunks(graph.edges, INSERT_CHUNK)) {
          yield* sql`INSERT INTO goagent_graph_edges ${sql.insert(
            batch.map((edge) => ({
              scan_id: scan.scanId,
              source_id: edge.source,
              target_id: edge.target,
              relation: edge.relation,
              evidence: edge.evidence,
              confidence_score: edge.confidenceScore,
              source_file: edge.sourceFile,
              source_location: edge.sourceLocation,
            })),
          )}`;
        }
        yield* putScan(scan);
      },
      sql.withTransaction,
      fail("completeScan"),
    ),

    getScanGraph: Effect.fn("GoAgentStore.getScanGraph")(function* (scanId) {
      const nodeRows = yield* sql`
          SELECT node_id, label, kind, source_file, source_location, community
          FROM goagent_graph_nodes WHERE scan_id = ${scanId} ORDER BY node_id
        `;
      const edgeRows = yield* sql`
          SELECT source_id, target_id, relation, evidence, confidence_score, source_file, source_location
          FROM goagent_graph_edges WHERE scan_id = ${scanId}
          ORDER BY source_id, target_id, relation
        `;
      const nodes = yield* Effect.forEach(nodeRows, (row) =>
        decodeNodeRow(row).pipe(
          Effect.flatMap((r) =>
            decodeNode({
              id: r.node_id,
              label: r.label,
              kind: r.kind,
              sourceFile: r.source_file,
              sourceLocation: r.source_location,
              community: r.community,
            }),
          ),
        ),
      );
      const edges = yield* Effect.forEach(edgeRows, (row) =>
        decodeEdgeRow(row).pipe(
          Effect.flatMap((r) =>
            decodeEdge({
              source: r.source_id,
              target: r.target_id,
              relation: r.relation,
              evidence: r.evidence,
              confidenceScore: r.confidence_score,
              sourceFile: r.source_file,
              sourceLocation: r.source_location,
            }),
          ),
        ),
      );
      return { nodes, edges };
    }, fail("getScanGraph")),

    putMission: (mission) =>
      MissionJson.encode(mission).pipe(
        Effect.flatMap(
          (doc) => sql`
            INSERT INTO goagent_missions (mission_id, project_id, state, mission_json, created_at, updated_at)
            VALUES (${mission.missionId}, ${mission.projectId}, ${mission.state}, ${doc},
              ${mission.createdAt}, ${mission.updatedAt})
            ON CONFLICT (mission_id) DO UPDATE SET
              state = excluded.state,
              mission_json = excluded.mission_json,
              updated_at = excluded.updated_at
          `,
        ),
        Effect.asVoid,
        fail("putMission"),
      ),

    getMission: (missionId) =>
      sql<{ readonly doc: string }>`
        SELECT mission_json AS doc FROM goagent_missions WHERE mission_id = ${missionId}
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(Option.none())
            : Effect.map(MissionJson.decode(rows[0].doc), Option.some),
        ),
        fail("getMission"),
      ),

    listMissions: (projectId) =>
      sql<{ readonly doc: string }>`
        SELECT mission_json AS doc FROM goagent_missions
        WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT 50
      `.pipe(
        Effect.flatMap((rows) => decodeAll(rows, MissionJson.decode)),
        fail("listMissions"),
      ),

    listActiveMissions: sql<{ readonly doc: string }>`
      SELECT mission_json AS doc FROM goagent_missions
      WHERE state IN ('running', 'integrating', 'verifying')
    `.pipe(
      Effect.flatMap((rows) => decodeAll(rows, MissionJson.decode)),
      fail("listActiveMissions"),
    ),

    putTask: (task) =>
      TaskJson.encode(task).pipe(
        Effect.flatMap(
          (doc) => sql`
            INSERT INTO goagent_tasks (mission_id, task_key, thread_id, task_json)
            VALUES (${task.missionId}, ${task.key}, ${task.threadId}, ${doc})
            ON CONFLICT (mission_id, task_key) DO UPDATE SET
              thread_id = excluded.thread_id,
              task_json = excluded.task_json
          `,
        ),
        Effect.asVoid,
        fail("putTask"),
      ),

    listTasks: (missionId) =>
      sql<{ readonly doc: string }>`
        SELECT task_json AS doc FROM goagent_tasks WHERE mission_id = ${missionId} ORDER BY rowid
      `.pipe(
        Effect.flatMap((rows) => decodeAll(rows, TaskJson.decode)),
        fail("listTasks"),
      ),

    findTaskByThread: (threadId) =>
      sql<{ readonly doc: string }>`
        SELECT task_json AS doc FROM goagent_tasks WHERE thread_id = ${threadId} LIMIT 1
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(Option.none())
            : Effect.map(TaskJson.decode(rows[0].doc), Option.some),
        ),
        fail("findTaskByThread"),
      ),

    putContract: (contract) =>
      ContractJson.encode(contract).pipe(
        Effect.flatMap(
          (doc) => sql`
            INSERT INTO goagent_contracts (contract_id, mission_id, contract_json)
            VALUES (${contract.contractId}, ${contract.missionId}, ${doc})
            ON CONFLICT (contract_id) DO UPDATE SET contract_json = excluded.contract_json
          `,
        ),
        Effect.asVoid,
        fail("putContract"),
      ),

    listContracts: (missionId) =>
      sql<{ readonly doc: string }>`
        SELECT contract_json AS doc FROM goagent_contracts WHERE mission_id = ${missionId} ORDER BY rowid
      `.pipe(
        Effect.flatMap((rows) => decodeAll(rows, ContractJson.decode)),
        fail("listContracts"),
      ),

    putDecision: (decision) =>
      DecisionJson.encode(decision).pipe(
        Effect.flatMap(
          (doc) => sql`
            INSERT INTO goagent_decisions (decision_id, mission_id, decision_json, created_at)
            VALUES (${decision.decisionId}, ${decision.missionId}, ${doc}, ${decision.createdAt})
            ON CONFLICT (decision_id) DO UPDATE SET decision_json = excluded.decision_json
          `,
        ),
        Effect.asVoid,
        fail("putDecision"),
      ),

    getDecision: (decisionId) =>
      sql<{ readonly doc: string }>`
        SELECT decision_json AS doc FROM goagent_decisions WHERE decision_id = ${decisionId}
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(Option.none())
            : Effect.map(DecisionJson.decode(rows[0].doc), Option.some),
        ),
        fail("getDecision"),
      ),

    listDecisions: (missionId) =>
      sql<{ readonly doc: string }>`
        SELECT decision_json AS doc FROM goagent_decisions
        WHERE mission_id = ${missionId} ORDER BY created_at, rowid
      `.pipe(
        Effect.flatMap((rows) => decodeAll(rows, DecisionJson.decode)),
        fail("listDecisions"),
      ),

    putProjectDecision: (decision) =>
      ProjectDecisionJson.encode(decision).pipe(
        Effect.flatMap(
          (doc) => sql`
            INSERT INTO goagent_project_decisions (decision_id, project_id, decision_json, created_at)
            VALUES (${decision.decisionId}, ${decision.projectId}, ${doc}, ${decision.createdAt})
            ON CONFLICT (decision_id) DO UPDATE SET decision_json = excluded.decision_json
          `,
        ),
        Effect.asVoid,
        fail("putProjectDecision"),
      ),

    listProjectDecisions: (projectId) =>
      sql<{ readonly doc: string }>`
        SELECT decision_json AS doc FROM goagent_project_decisions
        WHERE project_id = ${projectId} AND retired_at IS NULL ORDER BY created_at, rowid
      `.pipe(
        Effect.flatMap((rows) => decodeAll(rows, ProjectDecisionJson.decode)),
        fail("listProjectDecisions"),
      ),

    retireProjectDecision: ({ projectId, decisionId, retiredAt }) =>
      sql<{ readonly decision_id: string }>`
        UPDATE goagent_project_decisions SET retired_at = ${retiredAt}
        WHERE decision_id = ${decisionId} AND project_id = ${projectId} AND retired_at IS NULL
        RETURNING decision_id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        fail("retireProjectDecision"),
      ),

    putVerificationRun: (run) =>
      RunJson.encode(run).pipe(
        Effect.flatMap(
          (doc) => sql`
            INSERT INTO goagent_verification_runs (run_id, mission_id, run_json, started_at)
            VALUES (${run.runId}, ${run.missionId}, ${doc}, ${run.startedAt})
            ON CONFLICT (run_id) DO UPDATE SET run_json = excluded.run_json
          `,
        ),
        Effect.asVoid,
        fail("putVerificationRun"),
      ),

    listVerificationRuns: (missionId) =>
      sql<{ readonly doc: string }>`
        SELECT run_json AS doc FROM goagent_verification_runs
        WHERE mission_id = ${missionId} ORDER BY started_at, rowid
      `.pipe(
        Effect.flatMap((rows) => decodeAll(rows, RunJson.decode)),
        fail("listVerificationRuns"),
      ),

    appendEvent: Effect.fn("GoAgentStore.appendEvent")(function* (input) {
      const rows = yield* sql<{ readonly next: number }>`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM goagent_events
          WHERE mission_id = ${input.missionId}
        `;
      const event = yield* decodeEvent({
        ...input,
        sequence: rows[0]?.next ?? 1,
      });
      const doc = yield* EventJson.encode(event);
      yield* sql`
          INSERT INTO goagent_events (event_id, mission_id, sequence, event_json)
          VALUES (${event.eventId}, ${event.missionId}, ${event.sequence}, ${doc})
        `;
      return event;
    }, fail("appendEvent")),

    listEvents: (missionId, limit) =>
      sql<{ readonly doc: string }>`
        SELECT event_json AS doc FROM (
          SELECT event_json, sequence FROM goagent_events
          WHERE mission_id = ${missionId} ORDER BY sequence DESC LIMIT ${limit}
        ) ORDER BY sequence ASC
      `.pipe(
        Effect.flatMap((rows) => decodeAll(rows, EventJson.decode)),
        fail("listEvents"),
      ),
  });
});

export const layer = Layer.effect(GoAgentStore, make);
