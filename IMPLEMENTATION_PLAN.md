# GoAgent — Implementation Plan

**Date:** 2026-10-22 | **Spec:** [GoAgent.md](GoAgent.md) | **Codebase:** `t3code-main/t3code-main` (T3 Code fork)
**Approach:** functional first, polished UI later. Every phase ends with real, runnable evidence.

Status legend: ☐ todo · ◐ in progress · ☑ done · ⚠ blocked

---

## Phase 0 — Environment & baseline

| # | Step | Notes |
|---|---|---|
| 0.1 | Install `vp` (Vite+) | Windows: `irm https://vite.plus/ps1 \| iex` (from T3 README) |
| 0.2 | Node **26.12.1** | `package.json` `engines.node`; machine has 22.20.0. Use `vp`'s managed Node or fnm |
| 0.3 | pnpm 12.14.0 | via corepack / `vp` |
| 0.4 | Git baseline for the fork | `t3code-main/` has no `.git`; commit it unmodified in the outer `GoAgent` repo first so every GoAgent change is a reviewable diff |
| 0.5 | `vp i` in the fork | then `vp run dev` with a non-live home dir (never `~/.t3/userdata`) |
| 0.6 | Install Graphify | `uv tool install ./graphify-8/graphify-8` (local source, pinned) → `graphify --version` |
| 0.7 | Fixture repo | `fixtures/profile-app`: React + Express + SQLite, JWT auth, profile page, Vitest; own git repo; `pnpm test` green |
| 0.8 | Provider | Claude Code CLI 2.1.306 is installed → demo provider = Claude (Codex not installed) |

**Exit:** T3 dev server + web open locally; one normal T3 thread works on the fixture; `graphify extract fixtures/profile-app --code-only` produces `graph.json`.

---

## Phase 1 — Spikes (de-risk before building)

| # | Spike | Pass condition |
|---|---|---|
| 1.1 | Effect `DecisionModel` in `effect@4.0.5` | `import { Decision, DecisionModel } from "effect/ai"` resolves from `apps/server`; fake-model test passes |
| 1.2 | Jev live call | `@effect/ai-typesafe` (or thin HTTP client) returns a classify answer with `TYPESAFE_API_KEY` |
| 1.3 | Graphify output | confirm output dir control, `graph.schema_version`, runtime on fixture |
| 1.4 | Worktree thread from server code | find the service behind `t3_thread_launch` (`mcp/toolkits/project/handlers.ts` → `ThreadManagementService`) and launch one thread with `workspaceStrategy: { type: "worktree" }` from a test |
| 1.5 | Run settlement signal | identify the event/projection that says a thread's run finished (RunFinalizationService) to drive task completion |

**Decisions recorded here after spikes:**
- Mission persistence: **own GoAgent tables + own append-only event table in the same SQLite DB** (migration `068_GoAgent.ts`), written transactionally, broadcast after commit via a PubSub-backed stream RPC. Rationale: T3's v2 orchestrator decider is thread-centric; extending its event union touches replay compatibility of every environment. Revisit only if the spike shows a cheap seam.
- Graph access for agents: **GoAgent MCP toolkit** over ingested graph (option A).
- Graph delta: computed in TypeScript over two ingested snapshots.

---

## Phase 2 — Contracts & persistence

Files *(follow existing patterns, e.g. `usage.ts` + `UsageService`)*:
- `packages/contracts/src/goagent.ts` — Schemas: `GoAgentMission`, `GoAgentTask`, `GoAgentPlan`, `GoAgentContract`, `GoAgentDecision`, `GoAgentGraphNode/Edge/Scan/Delta`, `GoAgentVerificationRun`, `GoAgentEvent` (tagged union), error classes.
- `packages/contracts/src/rpc.ts` — add `WS_METHODS.goagent*` + `Rpc.make` entries; add guarded scopes in `clientRpcPermissions.ts`.
- `apps/server/src/persistence/Migrations/068_GoAgent.ts` — tables from GoAgent.md §12 + `goagent_events(event_id, mission_id, sequence, type, actor, caused_by, payload_json, occurred_at)` with `UNIQUE(mission_id, sequence)`.
- `apps/server/src/goagent/GoAgentStore.ts` — typed repository; `appendEvents` + projection updates in one transaction.

Tests: migration applies; sequence uniqueness; append + projection atomicity.

---

## Phase 3 — Graph service (Graphify)

- `GoAgentGraphService.ts`
  - `probe()` → graphify path/version or `GRAPHIFY_UNAVAILABLE`.
  - `index({ projectId, root, scope, taskId?, sha })` → spawn `graphify extract <root> --code-only` (captured PID, timeout, output into `<t3 home>/goagent/graphs/<projectId>/<scanId>/`), parse `graph.json`, check schema version, restore arc direction, upsert nodes/edges, record scan + `GRAPH_INDEXED`.
  - `get({ projectId, scanId?, level: "file" | "symbol" })` → paged nodes/edges with communities.
  - `delta(baseScanId, newScanId)` → new/removed nodes/edges.
  - `neighbors / path / query` for agents.
- Exclusions: `.env*`, keys, `node_modules`, build dirs (copy-to-temp with filter if Graphify lacks an exclude flag).
- Tests: ingest fixture `graph.json` (checked-in sample), direction restore, idempotent re-ingest, delta correctness, missing binary → typed error.

---

## Phase 4 — Decision service (Jev)

- `GoAgentDecisionService.ts`
  - Definitions: `mission.route` (classify), `mission.risk` (rate), `contract.match` (probability, P1), `failure.owner` (classify, P1).
  - `decide(key, input)` → Jev with timeout → threshold check → else deterministic fallback; returns `{answer, probabilities, confidence, model, source, fallbackReason}`; caller persists `DECISION_MADE`.
  - Disabled when `TYPESAFE_API_KEY` missing or user turned Jev off → always fallback, labelled.
- Tests with a fake `DecisionModel` layer: confident answer, low confidence → fallback, error → fallback, budget exceeded → fallback.

---

## Phase 5 — Mission service

- `GoAgentPlanner.ts` — uses T3's existing text-generation path to produce plan JSON; schema validate; cycle/unknown-dep/too-many-tasks/unapproved-command checks.
- `GoAgentMissionService.ts`
  - `create(projectId, request)` → route decision → plan → `PLAN_PROPOSED`.
  - `updatePlan`, `approve(planVersion)` → risk decision.
  - `start` → check clean base, record base SHA, persist tasks, launch each runnable task as a T3 thread in its own worktree with the context packet prompt; blocked tasks wait on the gate.
  - Gate engine: re-evaluate on `CONTRACT_ACKNOWLEDGED` / `TASK_COMPLETED`.
  - Task completion: watch thread run settlement → verify commits in worktree → `TASK_COMPLETED` → per-task graph index + delta.
  - `cancel` → interrupt mission threads via thread service; kill only captured child PIDs.
  - Startup reconcile → `interrupted` when unsure.
- `GoAgentContextBuilder.ts` — task files → 1–2 hop neighbourhood (capped) + rationale nodes + contract + decisions.
- Tests: plan validation, gate unblock only on matching version, stale ack invalidation, cancel, reconcile.

---

## Phase 6 — Agent MCP toolkit

- `apps/server/src/mcp/toolkits/goagent/{tools,handlers}.ts`, registered beside the orchestrator toolkit.
- Tools: `goagent_graph_query|node|neighbors|path`, `goagent_contract_propose|ack|read`, `goagent_task_status`.
- Scope check: caller's thread ↔ mission task.
- Tests: foreign mission id rejected; propose → ack → gate unblock end-to-end through handlers.

---

## Phase 7 — Integration & verification

- `GoAgentIntegrationService.ts` — integration worktree from base SHA; cherry-pick task heads in dependency order; conflict → `INTEGRATION_CONFLICT` + `needs_review`; success → index integration worktree.
- `GoAgentVerificationService.ts` — approved commands (project scripts / GoAgent config) as argv; no shell; timeout; bounded capture; log artifact; `PASSED|FAILED|TIMED_OUT|NOT_RUN`; Vitest JSON parse when available.
- P1: `failure.owner` → repair brief to owning thread → re-integrate → re-verify (max 1).
- Tests: conflict path on a temp repo; exit 1 → FAILED; timeout → TIMED_OUT.

---

## Phase 8 — Web UI (functional, plain styling)

- Route `apps/web/src/routes/goagent.$environmentId.$projectId.tsx` (exact shape after reading `projects.$projectKey.tsx`) + entry button in project view + command palette entry.
- `apps/web/src/components/goagent/`: `GoAgentShell`, `KnowledgeGraph` (`@xyflow/react`), `MissionDag`, `Inspector`, `DecisionCard`, `AuditTimeline`, `VerificationPanel`, `MissionComposer`.
- State via `packages/client-runtime` patterns + `createEnvironmentRpcCommand`; mission subscription stream.
- Use existing `components/ui` variants only (no restyling) — the pro UI pass comes later with your reference sites.
- Browser tests for DAG states + inspector.

---

## Phase 9 — End-to-end & hardening

- Full fixture mission: index → route → plan → approve → 2 agents → contract → deltas → integrate → verify → report.
- All error states from GoAgent.md §6.8 reachable and readable.
- `vp run check:changed` clean; targeted `vp test run` for every new module.
- Three consecutive clean demo runs.

---

## Phase 10 — Pro UI (later)
Visual redesign using the reference sites you provide.

---

## Inputs needed from you
1. Permission to install toolchain globally: `vp` (Vite+), Node 26 runtime, Graphify (uv tool).
2. `TYPESAFE_API_KEY` for Jev (until then: fallback mode, clearly labelled).
3. Confirm Claude Code (already installed) as the demo provider.
4. OK to commit the unmodified `t3code-main` as a baseline in the GoAgent git repo.

## Progress log
- 2026-10-22: Plan written. Toolchain gaps found: Node 22 (need 26.12.1), no `vp`/pnpm, no Graphify. `t3code-main` is not a git repo. Claude Code CLI present.
- 2026-10-22: Toolchain installed: Vite+ `vp` 1.3.0 (managed mode) → Node 26.12.1 + pnpm 12.14.0; Graphify 0.9.93 via `uv tool install` from `graphify-8/`. Demo provider: **OpenCode v2.0.24** (installed; receives T3's MCP server).
- 2026-10-22: Fixture `fixtures/profile-app` built (React + Express 5 + `node:sqlite` + in-house HS256 JWT). `pnpm test`: **7/7 passing**. `pnpm-workspace.yaml` allows the esbuild build so `pnpm install --frozen-lockfile` exits 0.
- Spike results:
  - 1.1 ☑ `effect@4.0.5` ships `effect/ai` `Decision`/`DecisionModel`; `@effect/ai-typesafe@4.0.5` is on npm (peer `effect ^4.0.5`) → added to catalog + server deps.
  - 1.3 ☑ `graphify extract <root> --code-only --out <dir>` works on the fixture: 105 nodes / 179 edges, schema_version 1. **On Windows the default worker pool costs ~2 min; `--max-workers 1` → 1.7 s.** GoAgent passes `--max-workers 1` on win32.
  - 1.4 ☑ Server-side launch = `ThreadLaunchService.launch({ workspaceStrategy: { type: "worktree", baseRef } , initialMessage, createdBy: "system", creationSource: "server" })`.
  - 1.5 ☑ Completion signal = `OrchestratorV2.streamDomainEvents` `run.updated` with terminal status; worktree path/branch on `thread.worktreePath/branch`.
- Decisions made while building:
  - **Planner is deterministic and graph-driven** (no generic JSON text-generation API exists across T3 providers). Tasks + owned paths come from the repo layout; the user edits the plan; the contract-owner agent designs the API itself via MCP.
  - **Contract gate**: a task that depends on `contract` is launched only after a contract version exists, and integration is refused until it has acknowledged the latest version. New versions are pushed to running dependents, which must re-ack.
  - **Mission writes are serialized by a lock, not one DB transaction**, because steps launch T3 threads that commit through T3's own event sink (nested-transaction deadlock risk).
  - **Verification runs every approved command in order** (install → typecheck → test), stops at the first failure, and records exit code, timeout, output tail and the test summary line printed by Vitest/Jest (never invented).
  - Leftover uncommitted agent work is committed by GoAgent inside the task's own worktree (identity `GoAgent <goagent@localhost>`), recorded in the `task.completed` event.
- Built so far (phases 2–8, code written; typecheck/tests pending on install):
  - Contracts `packages/contracts/src/goagent.ts`, 15 RPCs in `rpc.ts`, scopes in `clientRpcPermissions.ts` + `RpcAuthorization.ts`.
  - Migration `068_GoAgent.ts`; `apps/server/src/goagent/`: `GoAgentStore`, `graphifyGraph` (+tests), `GoAgentGraphService`, `GoAgentDecisionService` (+tests), `goagentDecisions`, `goagentPlanner` (+tests), `GoAgentMissionService`; wired in `runtimeLayer.ts` and `ws.ts`.
  - MCP toolkit `mcp/toolkits/goagent` (`goagent_graph_search|neighbours`, `goagent_contract_propose|read|acknowledge`, `goagent_task_status`).
  - Client: `client-runtime/src/state/goagent.ts`; web route `/goagent`, page + graph (React Flow) + mission DAG + plan editor + decisions + audit + verify; sidebar + command palette entries; `docs/user/goagent.md`.
- `pnpm install` in the T3 monorepo is very slow to finalize on this machine (~20 min idle after postinstall before writing the lockfile); it does complete (exit 0). Lockfile now includes `@effect/ai-typesafe@4.0.5` and `@xyflow/react@12.12.0`.
- 2026-10-23 verification (all run, not assumed):
  - Typecheck: `packages/contracts`, `packages/client-runtime`, `apps/web` → 0 errors. `apps/server` → 0 errors in GoAgent or edited files; remaining `any in requirements channel` diagnostics are in `server.ts`, `binCli.ts`, `ws.test.ts`, `cli/*.test.ts` (files not changed; a type probe showed `Ws.layer`'s requirements are concrete, not `any`). Not proven pre-existing because there is no pristine upstream copy to diff against.
  - Tests: server GoAgent + migrations + RpcAuthorization → 56/56; `ws.test.ts` 6/6; `src/mcp` 228/230 (2 failures in `OrchestratorMcpToolkit.integration.test.ts`: pre-existing Windows path bug `D:\D:\…` reading a fixture); web GoAgent layout 4/4; contracts rpc 2/2.
  - Lint (oxlint + t3code rules) on all GoAgent files: 0 errors. Knip: GoAgent unused exports removed.
  - Runtime: `vp run dev --home-dir <scratch> --no-seed` boots; migration `68_GoAgent` applied; no GoAgent errors in the log.
- Not yet verified: a full mission with real OpenCode agents (needs the fixture to be a git repo with a commit, a project default model, and a browser session).
- Note: migration id 68 will collide if upstream T3 adds its own 068; renumber when rebasing.
- 2026-10-23 (later): Jev key configured (`t3code-main/t3code-main/.env`, gitignored). Spike 1.2 ☑.
  - `apps/server/scripts/goagent-jev-eval.ts` (labelled set, live Jev): `mission.route` 20/20 correct (fallback rule alone 19/20); `failure.owner` 5/6 (missed a port-in-use log that should be `unknown`; fallback rule 6/6). ~300 ms per call.
- 2026-10-23: **Phase 9 end-to-end with real parallel agents** via `apps/server/scripts/verify-goagent-live.ts` (fresh T3 home + fixture copy, production server, same typed WebSocket RPC as the web client; provider `claudeAgent` / `claude-sonnet-5-5`; evidence written to a temp dir per run).
  - Run 2: index 105/179 → plan backend ∥ frontend → Jev risk high → 2 agents in 2 worktrees from the same base SHA → backend agent proposed `PATCH /api/profile` over MCP → frontend unblocked, launched, acknowledged v1 (Jev `contract.match` 78%) → per-task graph deltas → integration without conflicts → `pnpm install` + `pnpm test` **15/15 passed** on the integrated worktree. Only failed check was a verifier race (graph delta arrives ~2 s after `task.completed`); verifier now waits for it.
  - Run with `--inject-regression` (labelled verifier commit drops the `Bearer` prefix in the frontend worktree): `pnpm test` failed 2/15 → Jev `failure.owner` = frontend (100%) → repair brief sent → agent fixed it → GoAgent re-integrated and re-verified by itself → **15/15 passed, all checks passed**.
  - Run 3 (project decisions seeded from DECISIONS.md): all checks passed, 15/15.
  - Run 4 (graph-first prompt): both agents called `goagent_graph_search` + `goagent_graph_neighbours` over MCP (4 audited `graph.queried` events with real results) → AC-03 shown; all checks passed, `pnpm test` 16/16.
- Built in this pass:
  - P1 repair loop: `goagent.requestRepair`, `repair.requested` event, one round per mission, automatic re-integrate + re-verify; "Send repair to …" button.
  - High risk (Jev `mission.risk` = high) holds the plan in `needs_review` with `plan.review_required`; "Approve despite high risk" confirms.
  - Low-confidence Jev answers keep Jev's distribution/model next to the fallback answer (card shows "Jev said, not used").
  - `contract.match`: Jev leaning mismatch (p(true) < 0.5) adds a review blocker; integration refuses until the user overrides the decision to `true`.
  - Integration uses each task worktree's current HEAD (repairs / hand-fixed conflicts are no longer dropped); `integration.started` lists refreshed heads.
  - P1 project decisions: migration `069_GoAgentProjectDecisions`, `goagent.updateProjectDecisions` (add / import DECISIONS.md as *seeded* / retire), injected into task prompts (`context.built.projectDecisionIds`), `decision` graph nodes with `governs` edges (evidence `explicit_human`) only to files the text names, MCP tool `goagent_project_decisions`, left-panel UI.
  - AC-03: agent graph tool calls are audited (`graph.queried`); task prompt now asks agents to query the graph first.
  - Task prompt names the repo's package manager (an agent had created `package-lock.json` in a pnpm repo).
  - Fixed `reconcileV2PreviewMigration.test.ts` expectations (they listed migrations only up to 67, so 068 had already broken them).
- Checks after this pass: typecheck contracts / client-runtime / web 0 errors, server 0 errors outside the files listed above; lint 0 errors on GoAgent files; tests: server GoAgent 39/39, `src/mcp`+GoAgent+auth 340/342 (same 2 pre-existing Windows path failures), `ws.test.ts`+auth 85/85, migrations reconcile fixed, web GoAgent layout 5/5, contracts rpc 2/2. `DatabaseMaintenance.test.ts` fails with a Windows EBUSY file lock (file not touched).
- Still open: P1 mission replay; 3-task plans (validator allows 3, planner does not yet propose a tests task); AC-11 cancel/restart not exercised live; UI pass (Phase 10).
- 2026-10-23: **Three agents + Jev coordination (P1 "3 parallel tasks" + micro-decisions).**
  - Planner: repos with client, server and test code get `backend` (owns server, proposes the contract) ∥ `frontend` ∥ `tests` (both wait only for the contract). Integration order backend → frontend → tests.
  - Plan carries `coupling` computed from the persistent base graph: Graphify edges crossing task ownership (e.g. `tests uses backend`). Shown in task prompts and per agent in the UI.
  - Micro-decisions (`handoff.notify`, `handoff.route`) with graph-based fallbacks: on task completion, agents whose code uses the changed files (walking the graph up to 3 hops, consumers only — no ping-pong) are candidates and Jev decides whether to switch to them now; agents can call `goagent_handoff` and Jev picks the receiver. Budgets: 8 handoffs and 24 Jev calls per mission, each ordered pair handed off once.
  - Agents record design decisions with `goagent_record_decision` (`agent.decision` events).
  - New **Agent decisions** tab: one window per agent with its own decisions, Jev coordination decisions about it, handoffs in/out, graph lookups and coupling.
  - Live run 5 (3 agents): all checks passed, 22/22 tests; showed a race — Jev's `handoff.notify` backend→tests (66%) landed after integration started, so the mission completed while tests was switched back on. Fixed: missions are marked `coordinating` from a run's completion until its graph delta and handoff decisions finish; integration refuses meanwhile; UI shows "Coordinating…"; snapshot exposes `coordinating`.
  - Live run 6 (after the fix): backend → contract → frontend ∥ tests; `handoff.route` frontend→tests (Jev 55%); backend finished → `handoff.notify` backend→tests (Jev 92%, 3 graph links) → tests reworked and finished → only then integration (backend → frontend → tests, no conflicts) → `pnpm test` **26/26**, all checks passed. Coupling from the graph: tests uses backend (11 links), tests uses frontend (4).
