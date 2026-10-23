import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Rules the user wants every mission agent to follow. Retired rows are kept for the audit trail.
  yield* sql`CREATE TABLE goagent_project_decisions (
    decision_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    retired_at TEXT
  )`;
  yield* sql`CREATE INDEX idx_goagent_project_decisions_project ON goagent_project_decisions(project_id, created_at)`;
});
