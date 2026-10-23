import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE goagent_project_settings (
    project_id TEXT PRIMARY KEY,
    verification_commands_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  // A scan is an immutable snapshot of one Graphify run; deltas compare two scans.
  yield* sql`CREATE TABLE goagent_graph_scans (
    scan_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    mission_id TEXT,
    task_key TEXT,
    commit_sha TEXT,
    status TEXT NOT NULL,
    graphify_version TEXT,
    schema_version INTEGER,
    node_count INTEGER NOT NULL DEFAULT 0,
    edge_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    failure TEXT
  )`;
  yield* sql`CREATE INDEX idx_goagent_scans_project ON goagent_graph_scans(project_id, scope, started_at)`;
  yield* sql`CREATE TABLE goagent_graph_nodes (
    scan_id TEXT NOT NULL REFERENCES goagent_graph_scans(scan_id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_file TEXT,
    source_location TEXT,
    community INTEGER,
    PRIMARY KEY (scan_id, node_id)
  )`;
  yield* sql`CREATE TABLE goagent_graph_edges (
    scan_id TEXT NOT NULL REFERENCES goagent_graph_scans(scan_id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    evidence TEXT NOT NULL,
    confidence_score REAL NOT NULL,
    source_file TEXT,
    source_location TEXT,
    PRIMARY KEY (scan_id, source_id, target_id, relation)
  )`;
  yield* sql`CREATE TABLE goagent_missions (
    mission_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    state TEXT NOT NULL,
    mission_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_goagent_missions_project ON goagent_missions(project_id, created_at)`;
  yield* sql`CREATE TABLE goagent_tasks (
    mission_id TEXT NOT NULL REFERENCES goagent_missions(mission_id) ON DELETE CASCADE,
    task_key TEXT NOT NULL,
    thread_id TEXT,
    task_json TEXT NOT NULL,
    PRIMARY KEY (mission_id, task_key)
  )`;
  yield* sql`CREATE INDEX idx_goagent_tasks_thread ON goagent_tasks(thread_id)`;
  yield* sql`CREATE TABLE goagent_contracts (
    contract_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES goagent_missions(mission_id) ON DELETE CASCADE,
    contract_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE goagent_decisions (
    decision_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES goagent_missions(mission_id) ON DELETE CASCADE,
    decision_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE goagent_verification_runs (
    run_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES goagent_missions(mission_id) ON DELETE CASCADE,
    run_json TEXT NOT NULL,
    started_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE goagent_events (
    event_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES goagent_missions(mission_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    UNIQUE (mission_id, sequence)
  )`;
});
