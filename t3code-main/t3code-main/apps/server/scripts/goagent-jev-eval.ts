#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalConsole:off globalConsoleInEffect:off preferSchemaOverJson:off - Host-side evaluation report written to stdout.
// Runs GoAgent's real Jev decisions against a small labelled set and reports observed accuracy
// next to the deterministic fallback (GoAgent.md §9.2 "evaluation before claims").
//
// Usage (from apps/server): node --env-file=../../.env scripts/goagent-jev-eval.ts
import * as NodeUtil from "node:util";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type { GoAgentPlan, GoAgentPlanTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  GoAgentDecisionService,
  layer as decisionLayer,
  type DecisionRequest,
} from "../src/goagent/GoAgentDecisionService.ts";
import { failureOwnerDecision, routeDecision } from "../src/goagent/goagentDecisions.ts";

const { values } = NodeUtil.parseArgs({
  options: { only: { type: "string" } },
});

const task = (
  key: string,
  role: GoAgentPlanTask["role"],
  ownsPaths: string[],
): GoAgentPlanTask => ({
  key: key as GoAgentPlanTask["key"],
  title: `${role} work`,
  role,
  brief: `Implement the ${role} part of the request.`,
  ownsPaths,
  dependsOn: [],
  proposesContract: role === "backend",
});

const plan = (tasks: GoAgentPlanTask[]): GoAgentPlan => ({
  title: "Evaluation plan",
  constraints: [],
  contract: null,
  tasks,
  verificationCommandIds: [],
});

const splitPlan = plan([
  task("backend", "backend", ["server/**"]),
  task("frontend", "frontend", ["web/**"]),
]);
const onePlan = plan([task("main", "fullstack", ["server/**", "web/**"])]);

// Labels are the answer a careful engineer would pick for the profile-app fixture layout.
const routingCases: ReadonlyArray<{
  readonly request: string;
  readonly touched: string[];
  readonly expected: "single_agent" | "parallel";
}> = [
  {
    request:
      "Add an authenticated edit-profile feature: PATCH /api/profile plus an edit form on the profile page.",
    touched: [
      "server/routes/profile.ts",
      "web/src/pages/ProfilePage.tsx",
      "web/src/api/profile.ts",
    ],
    expected: "parallel",
  },
  {
    request:
      "Add avatar upload: a new upload endpoint that stores the file, and an avatar picker in the profile UI.",
    touched: ["server/routes/profile.ts", "server/db.ts", "web/src/pages/ProfilePage.tsx"],
    expected: "parallel",
  },
  {
    request: "Add a password-change flow with a new API route and a settings page form.",
    touched: ["server/routes/auth.ts", "server/auth/password.ts", "web/src/pages"],
    expected: "parallel",
  },
  {
    request:
      "Build an admin users list: GET /api/admin/users with pagination and a new admin page with a table.",
    touched: ["server/routes", "server/db.ts", "web/src/pages", "web/src/api"],
    expected: "parallel",
  },
  {
    request:
      "Add account deletion: DELETE /api/profile endpoint and a danger-zone section with confirm dialog in the UI.",
    touched: ["server/routes/profile.ts", "web/src/pages/ProfilePage.tsx"],
    expected: "parallel",
  },
  {
    request:
      "Add email verification: send a token on signup, a verify endpoint, and a 'check your inbox' page.",
    touched: ["server/routes/auth.ts", "server/db.ts", "web/src/pages"],
    expected: "parallel",
  },
  {
    request:
      "Add user preferences (theme, language) saved on the server with a preferences screen in the web app.",
    touched: ["server/db.ts", "server/routes", "web/src/pages"],
    expected: "parallel",
  },
  {
    request: "Add a public profile page at /u/:name backed by a new public API endpoint.",
    touched: ["server/routes/profile.ts", "web/src/App.tsx", "web/src/pages"],
    expected: "parallel",
  },
  {
    request:
      "Add refresh tokens: new /api/auth/refresh endpoint and automatic token refresh in the web API client.",
    touched: ["server/auth/jwt.ts", "server/routes/auth.ts", "web/src/api/client.ts"],
    expected: "parallel",
  },
  {
    request:
      "Add an activity log: record logins on the server and show the last 10 on the profile page.",
    touched: ["server/db.ts", "server/routes/auth.ts", "web/src/pages/ProfilePage.tsx"],
    expected: "parallel",
  },
  {
    request: "Fix the typo 'Sumbit' on the login button.",
    touched: ["web/src/pages/LoginPage.tsx"],
    expected: "single_agent",
  },
  {
    request: "Change the default API port from 4000 to 4100.",
    touched: ["server/index.ts"],
    expected: "single_agent",
  },
  {
    request: "Increase the bcrypt-style password hashing iteration count.",
    touched: ["server/auth/password.ts"],
    expected: "single_agent",
  },
  {
    request: "Rename the CSS class profile-card to profile-panel.",
    touched: ["web/src/pages/ProfilePage.tsx"],
    expected: "single_agent",
  },
  {
    request: "Add a unit test for the JWT expiry check.",
    touched: ["tests/server/auth.test.ts", "server/auth/jwt.ts"],
    expected: "single_agent",
  },
  {
    request: "Return 404 instead of 500 when the profile row is missing.",
    touched: ["server/routes/profile.ts"],
    expected: "single_agent",
  },
  {
    request: "Show a loading spinner while the profile is fetched.",
    touched: ["web/src/pages/ProfilePage.tsx"],
    expected: "single_agent",
  },
  {
    request: "Log a warning when JWT_SECRET is not set.",
    touched: ["server/index.ts"],
    expected: "single_agent",
  },
  {
    request: "Update the README with setup steps.",
    touched: ["README.md"],
    expected: "single_agent",
  },
  {
    request: "Make the login form trim whitespace from the email field.",
    touched: ["web/src/pages/LoginPage.tsx"],
    expected: "single_agent",
  },
];

const ownerTasks = [
  { key: "backend", title: "Profile API", ownsPaths: ["server/**"] },
  { key: "frontend", title: "Profile UI", ownsPaths: ["web/**"] },
];
const failureCases: ReadonlyArray<{ readonly log: string; readonly expected: string }> = [
  {
    log: "FAIL tests/server/profile.test.ts > PATCH /api/profile > updates the name\nAssertionError: expected 404 to be 200\n at server/routes/profile.ts:31",
    expected: "backend",
  },
  {
    log: "FAIL tests/web/profileApi.test.ts > updateProfile sends PATCH\nTypeError: updateProfile is not a function\n at web/src/api/profile.ts:12",
    expected: "frontend",
  },
  {
    log: "FAIL tests/server/auth.test.ts > rejects expired token\nError: SqliteError: no such column: display_name\n at server/db.ts:44",
    expected: "backend",
  },
  {
    log: "web/src/pages/ProfilePage.tsx:58:7 - error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
    expected: "frontend",
  },
  {
    log: "FAIL tests/web/profileApi.test.ts > sends the bearer token\nexpected headers.Authorization to be 'Bearer abc'\nreceived undefined (web/src/api/client.ts:9)",
    expected: "frontend",
  },
  { log: "Error: listen EADDRINUSE: address already in use :::4000", expected: "unknown" },
];

interface Row {
  readonly id: string;
  readonly expected: string;
  readonly jev: string;
  readonly source: string;
  readonly confidence: number | null;
  readonly fallback: string;
  readonly latencyMs: number;
  readonly note: string | null;
}

const runCase = Effect.fn("GoAgentJevEval.runCase")(function* (
  id: string,
  expected: string,
  request: DecisionRequest,
) {
  const service = yield* GoAgentDecisionService;
  const started = Date.now();
  const outcome = yield* service.decide(request);
  return {
    id,
    expected,
    jev: outcome.answer,
    source: outcome.source,
    confidence: outcome.confidence,
    fallback: request.fallback.answer,
    latencyMs: Date.now() - started,
    note: outcome.fallbackReason,
  } satisfies Row;
});

const summarize = (name: string, rows: ReadonlyArray<Row>) => {
  const jevRows = rows.filter((row) => row.source === "jev");
  const jevCorrect = jevRows.filter((row) => row.jev === row.expected).length;
  const usedCorrect = rows.filter((row) => row.jev === row.expected).length;
  const fallbackCorrect = rows.filter((row) => row.fallback === row.expected).length;
  console.log(`\n## ${name} (${rows.length} cases)`);
  for (const row of rows)
    console.log(
      `${row.jev === row.expected ? "ok  " : "MISS"} ${row.id.padEnd(12)} expected=${row.expected.padEnd(12)} answer=${row.jev.padEnd(12)} source=${row.source.padEnd(8)} conf=${row.confidence?.toFixed(2) ?? "-"} ${row.latencyMs}ms${row.note ? `  (${row.note})` : ""}`,
    );
  console.log(
    `answered by Jev: ${jevRows.length}/${rows.length}; Jev correct when it answered: ${jevCorrect}/${jevRows.length}; ` +
      `final answer correct: ${usedCorrect}/${rows.length}; fallback rule alone: ${fallbackCorrect}/${rows.length}`,
  );
};

await Effect.runPromise(
  Effect.gen(function* () {
    const service = yield* GoAgentDecisionService;
    console.log(`Jev status: ${JSON.stringify(service.status)}`);
    if (values.only !== "failure") {
      const rows: Row[] = [];
      for (const [index, item] of routingCases.entries()) {
        const route = routeDecision({
          request: item.request,
          plan: item.expected === "parallel" || item.touched.length > 1 ? splitPlan : onePlan,
          touchedFiles: item.touched,
        });
        rows.push(yield* runCase(`route-${index + 1}`, item.expected, route));
      }
      summarize("mission.route", rows);
    }
    if (values.only !== "route") {
      const rows: Row[] = [];
      for (const [index, item] of failureCases.entries())
        rows.push(
          yield* runCase(
            `failure-${index + 1}`,
            item.expected,
            failureOwnerDecision({ logExcerpt: item.log, tasks: ownerTasks }),
          ),
        );
      summarize("failure.owner", rows);
    }
  }).pipe(Effect.provide(decisionLayer.pipe(Layer.provide(FetchHttpClient.layer)))),
);
