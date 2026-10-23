// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side process verifier retains raw wire evidence and owns deadline timers.
// End-to-end GoAgent mission against a real server, real provider agents, real Graphify and Jev.
// It copies the fixture into a fresh git repository, starts the production server in a fresh
// T3 home, and drives the mission through the same typed WebSocket RPC the web client uses:
// index → plan (Jev routing) → approve (Jev risk) → parallel agents in worktrees → contract
// handoff → per-task graph delta → integrate → approved verification commands.
//
// Usage (from the repository root; consumes model usage):
//   node --env-file=.env apps/server/scripts/verify-goagent-live.ts [--model claude-sonnet-5-5]
// --inject-regression commits a labelled bug into the frontend worktree after the agents finish,
// then checks failure triage, the one repair round, and the automatic re-verification.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  ProjectId,
  ProviderInstanceId,
  WsRpcGroup,
  type GoAgentMissionSnapshot,
} from "@t3tools/contracts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string", default: "claude-sonnet-5-5" },
    provider: { type: "string", default: "claudeAgent" },
    timeout: { type: "string", default: "2400" },
    request: {
      type: "string",
      default:
        "Add an authenticated edit-profile feature: a PATCH /api/profile endpoint that updates the signed-in user's display name, and an edit form on the profile page that uses it. Keep the existing JWT auth.",
    },
    fixture: { type: "string" },
    "inject-regression": { type: "boolean", default: false },
  },
});
const timeoutMs = Number(values.timeout) * 1000;
NodeAssert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeout must be positive seconds");
const root = NodePath.resolve(import.meta.dirname, "../../..");
const fixture = NodePath.resolve(
  values.fixture ?? NodePath.join(root, "../../fixtures/profile-app"),
);
NodeAssert.ok(
  NodeFS.existsSync(NodePath.join(fixture, "package.json")),
  `No fixture at ${fixture}`,
);

const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goagent-live-"));
const home = NodePath.join(evidence, "home");
const project = NodePath.join(evidence, "project");
console.log(`Evidence: ${evidence}`);
const milestone = (kind: string, detail: object = {}) => {
  const line = { kind, at: new Date().toISOString(), ...detail };
  NodeFS.appendFileSync(NodePath.join(evidence, "milestones.ndjson"), JSON.stringify(line) + "\n");
  console.log(`[${line.at}] ${kind} ${JSON.stringify(detail)}`);
};

// Fresh copy of the fixture sources: no dependencies, databases, env files or git metadata.
const SKIP = new Set(["node_modules", ".git", ".env", ".goagent-test-results.json"]);
NodeFS.cpSync(fixture, project, {
  recursive: true,
  filter: (source) => {
    const name = NodePath.basename(source);
    return !SKIP.has(name) && !name.endsWith(".sqlite");
  },
});
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-C", project, ...args], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("add", "-A");
git(
  "-c",
  "user.name=Verifier",
  "-c",
  "user.email=verifier@localhost",
  "commit",
  "-qm",
  "Fixture baseline",
);
const fixtureHead = git("rev-parse", "HEAD");
NodeFS.writeFileSync(
  NodePath.join(evidence, "manifest.json"),
  JSON.stringify(
    {
      fixture,
      fixtureHead,
      provider: values.provider,
      model: values.model,
      request: values.request,
      jevKeyPresent: Boolean(process.env.TYPESAFE_API_KEY),
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise<void>((done) => reservation.once("listening", done));
const address = reservation.address();
NodeAssert.ok(address && typeof address !== "string");
await new Promise<void>((done) => reservation.close(() => done()));
const port = address.port;
const origin = `http://127.0.0.1:${port}`;
const bootstrap = NodeCrypto.randomUUID();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Host-side verifier with no Effect runtime of its own.
const isWindows = process.platform === "win32";

function startServer() {
  const server = NodeChildProcess.spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3", "--log-level", "debug"],
    { cwd: root, detached: !isWindows, stdio: ["ignore", "pipe", "pipe", "pipe"] },
  );
  const bootstrapPipe = server.stdio[3];
  NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
  bootstrapPipe.end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port,
      t3Home: home,
      host: "127.0.0.1",
      desktopBootstrapToken: bootstrap,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
  );
  const ready = Promise.withResolvers<void>();
  let output = "";
  for (const pipe of [server.stdout, server.stderr])
    pipe?.on("data", (data: Buffer) => {
      const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
      NodeFS.appendFileSync(NodePath.join(evidence, "server.log"), text);
      output = (output + text).slice(-8192);
      if (output.includes("startup phase: complete")) ready.resolve();
    });
  server.once("error", ready.reject);
  server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
  const startupDeadline = setTimeout(
    () => ready.reject(new Error("Server startup timed out")),
    120_000,
  );
  return { server, ready: ready.promise.finally(() => clearTimeout(startupDeadline)) };
}

const TERMINAL_TASK = new Set(["completed", "failed", "cancelled", "needs_review", "interrupted"]);
const writeSnapshot = (name: string, snapshot: GoAgentMissionSnapshot) =>
  NodeFS.writeFileSync(NodePath.join(evidence, name), JSON.stringify(snapshot, null, 2));

const { server, ready } = startServer();
const abort = new AbortController();
const onSignal = () => abort.abort(new Error("Verification interrupted"));
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
let verdict: Record<string, unknown> = { status: "failed", reason: "verification did not finish" };
const checks: Record<string, boolean | string> = {};
try {
  await ready;
  milestone("server.ready", { origin });
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(tokenResponse.ok, `Authentication failed: ${tokenResponse.status}`);
  const token = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    await tokenResponse.json(),
  );
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const created = await fetch(`${origin}/api/projects/mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: "GoAgent live verification",
      workspaceRoot: project,
    }),
  });
  NodeAssert.ok(created.ok, `Project creation failed: ${created.status} ${await created.text()}`);
  milestone("project.created", { projectId });
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok, `WebSocket authentication failed: ${ticketResponse.status}`);
  const ticket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
    await ticketResponse.json(),
  );
  const layerSocket = Socket.layerWebSocket(
    `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const layerProtocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(layerSocket),
    Layer.provide(RpcSerialization.layerJson),
  );

  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    // Same path as Settings → Projects → default model.
    yield* client["server.updateSettings"]({
      patch: {
        projectSettingsOverrides: {
          [projectId]: {
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make(values.provider),
              model: values.model,
            },
          },
        },
      },
    });
    const state = yield* client["goagent.getProjectState"]({ projectId });
    milestone("tools", { graphify: state.graphify, jev: state.jev });
    NodeAssert.ok(state.graphify.available, `Graphify unavailable: ${state.graphify.detail}`);

    const scan = yield* client["goagent.indexProject"]({ projectId });
    milestone("graph.indexed", {
      scanId: scan.scanId,
      nodes: scan.nodeCount,
      edges: scan.edgeCount,
    });
    checks.graphIndexed = scan.nodeCount >= 10 && scan.edgeCount >= 5;

    // Seeded project decisions from the fixture's DECISIONS.md (labelled seeded, not user-typed).
    const decided = yield* client["goagent.updateProjectDecisions"]({
      projectId,
      change: { type: "import" },
    });
    milestone("decisions.imported", {
      decisions: decided.projectDecisions.map((d) => `${d.author}: ${d.text.slice(0, 60)}`),
    });
    checks.decisionsSeeded =
      decided.projectDecisions.length > 0 &&
      decided.projectDecisions.every(
        (d) => d.author === "seeded" && d.sourceFile === "DECISIONS.md",
      );
    const graphWithDecisions = yield* client["goagent.getGraph"]({ projectId });
    checks.decisionNodesInGraph =
      graphWithDecisions !== null &&
      graphWithDecisions.nodes.some((n) => n.kind === "decision") &&
      graphWithDecisions.edges.some(
        (e) => e.relation === "governs" && e.evidence === "explicit_human",
      );

    const commands = state.suggestedVerificationCommands.filter((c) =>
      ["install", "test"].includes(c.id),
    );
    NodeAssert.ok(
      commands.some((c) => c.id === "test"),
      "The fixture has no test script to verify",
    );
    yield* client["goagent.setVerificationCommands"]({ projectId, commands });
    milestone("verification.approved", { commands: commands.map((c) => c.argv.join(" ")) });

    let snapshot = yield* client["goagent.createMission"]({ projectId, request: values.request });
    const missionId = snapshot.mission.missionId;
    writeSnapshot("01-planned.json", snapshot);
    const route = snapshot.decisions.find((d) => d.key === "mission.route");
    milestone("mission.planned", {
      missionId,
      tasks: snapshot.mission.plan.tasks.map((t) => `${t.key}<-[${t.dependsOn.join(",")}]`),
      contract: snapshot.mission.plan.contract,
      route: route && { answer: route.answer, source: route.source, confidence: route.confidence },
    });
    checks.routeDecided = route !== undefined;
    NodeAssert.ok(
      snapshot.mission.plan.tasks.length >= 2,
      `The plan has ${snapshot.mission.plan.tasks.length} task(s); parallel execution needs at least 2`,
    );

    snapshot = yield* client["goagent.approveMission"]({
      missionId,
      planVersion: snapshot.mission.planVersion,
    });
    const risk = snapshot.decisions.find((d) => d.key === "mission.risk");
    milestone("mission.approved", {
      state: snapshot.mission.state,
      risk: risk && { answer: risk.answer, source: risk.source, confidence: risk.confidence },
    });
    if (snapshot.mission.state === "needs_review") {
      // A high risk rating holds the plan; the verifier stands in for the user's second approval.
      checks.highRiskHeldForReview = snapshot.events.some((e) => e.type === "plan.review_required");
      snapshot = yield* client["goagent.approveMission"]({
        missionId,
        planVersion: snapshot.mission.planVersion,
      });
      milestone("risk.review.confirmed", { state: snapshot.mission.state });
    }
    NodeAssert.equal(snapshot.mission.state, "approved", "Mission did not reach approved");

    snapshot = yield* client["goagent.startMission"]({ missionId });
    writeSnapshot("02-started.json", snapshot);
    milestone("mission.started", {
      baseSha: snapshot.mission.baseSha,
      tasks: snapshot.tasks.map((t) => ({ key: t.key, state: t.state, blockedOn: t.blockedOn })),
    });

    const seen = new Set<string>();
    const record = (item: GoAgentMissionSnapshot) => {
      for (const event of item.events) {
        if (seen.has(event.eventId)) continue;
        seen.add(event.eventId);
        NodeFS.appendFileSync(
          NodePath.join(evidence, "mission-events.ndjson"),
          JSON.stringify(event) + "\n",
        );
        milestone(`event:${event.type}`, { actor: event.actor, summary: event.summary });
      }
      return item;
    };
    const follow = (until: (item: GoAgentMissionSnapshot) => boolean) =>
      client["goagent.subscribeMission"]({ missionId }).pipe(
        Stream.map(record),
        Stream.filter(until),
        Stream.take(1),
        Stream.runCollect,
        Effect.flatMap((items) =>
          items[0] === undefined
            ? client["goagent.getMission"]({ missionId })
            : Effect.succeed(items[0]),
        ),
      );
    // Settled = every task terminal, and every completed task's graph re-index has reported.
    const graphReported = (item: GoAgentMissionSnapshot, key: string) =>
      item.events.some(
        (e) =>
          (e.type === "graph.delta" || e.type === "graph.indexed") && e.payload.taskKey === key,
      );
    snapshot = yield* follow(
      (item) =>
        item.tasks.length > 0 &&
        item.tasks.every((task) => TERMINAL_TASK.has(task.state)) &&
        item.tasks.every((task) => task.state !== "completed" || graphReported(item, task.key)) &&
        item.coordinating !== true,
    );
    writeSnapshot("03-tasks-settled.json", snapshot);
    const tasks = snapshot.tasks;
    milestone("tasks.settled", {
      tasks: tasks.map((t) => ({
        key: t.key,
        state: t.state,
        threadId: t.threadId,
        worktree: t.worktreePath,
        changedFiles: t.changedFiles,
        failure: t.failureReason,
      })),
    });

    const worktrees = tasks.map((t) => t.worktreePath).filter((p): p is string => p !== null);
    const threads = tasks.map((t) => t.threadId).filter((id) => id !== null);
    checks.parallelThreads = new Set(threads).size >= 2;
    checks.distinctWorktrees =
      new Set(worktrees).size >= 2 && worktrees.every((p) => p !== project);
    const baseSha = snapshot.mission.baseSha;
    checks.sameBaseSha =
      baseSha === fixtureHead &&
      worktrees.every(
        (p) =>
          NodeChildProcess.spawnSync("git", [
            "-C",
            p,
            "merge-base",
            "--is-ancestor",
            baseSha,
            "HEAD",
          ]).status === 0,
      );
    checks.mainCheckoutUntouched =
      git("rev-parse", "HEAD") === fixtureHead && git("status", "--porcelain") === "";
    checks.contractProposedByAgent = snapshot.events.some(
      (e) => e.type === "contract.proposed" && e.actor.startsWith("task:"),
    );
    checks.contractAcknowledged = snapshot.events.some((e) => e.type === "contract.acknowledged");
    checks.decisionsInjected = snapshot.events
      .filter((e) => e.type === "context.built")
      .every(
        (e) =>
          Array.isArray(e.payload.projectDecisionIds) && e.payload.projectDecisionIds.length > 0,
      );
    // Informational (agents choose their own tools): did any agent query the graph via MCP?
    milestone("graph.queries", {
      count: snapshot.events.filter((e) => e.type === "graph.queried").length,
      byTask: snapshot.events
        .filter((e) => e.type === "graph.queried")
        .map((e) => `${e.actor}: ${e.summary}`)
        .slice(0, 10),
    });
    const completed = tasks.filter((t) => t.state === "completed");
    checks.graphDeltaPerTask =
      completed.length > 0 &&
      completed.every((t) =>
        snapshot.events.some((e) => e.type === "graph.delta" && e.payload.taskKey === t.key),
      );
    checks.allTasksCompleted = tasks.every((t) => t.state === "completed");
    // Three agents when the repo has tests: backend, frontend and tests, each in its own worktree.
    checks.threeAgents =
      tasks.length === 3 &&
      new Set(threads).size === 3 &&
      new Set(worktrees).size === 3 &&
      tasks.some((t) => t.role === "tests");
    checks.couplingFromGraph = (snapshot.mission.plan.coupling ?? []).length > 0;
    const coordination = snapshot.decisions.filter((d) => d.key.startsWith("handoff."));
    checks.coordinationDecided = coordination.length > 0;
    milestone("coordination", {
      coupling: (snapshot.mission.plan.coupling ?? []).map(
        (c) => `${c.from} uses ${c.to}: ${c.edgeCount}`,
      ),
      decisions: coordination.map(
        (d) =>
          `${d.key} ${d.taskKey ?? "?"}->${d.targetTaskKey ?? "-"}: ${d.answer} [${d.source}${d.confidence === null ? "" : ` ${Math.round(d.confidence * 100)}%`}]`,
      ),
      handoffs: snapshot.events.filter((e) => e.type === "handoff.sent").map((e) => e.summary),
      agentDecisions: snapshot.events
        .filter((e) => e.type === "agent.decision")
        .map((e) => e.summary),
    });

    if (checks.allTasksCompleted) {
      if (values["inject-regression"]) {
        // A labelled, deliberate bug in the frontend's worktree so the repair loop has a real
        // failure to route. It is not agent work and is committed under the verifier's name.
        const frontend = tasks.find((t) => t.role === "frontend" && t.worktreePath !== null);
        NodeAssert.ok(frontend?.worktreePath, "No frontend worktree to inject a regression into");
        const worktree = frontend.worktreePath;
        const file = NodePath.join(worktree, "web/src/api/client.ts");
        const source = NodeFS.readFileSync(file, "utf8");
        const broken = source.replace(
          "authorization: `Bearer ${options.token}`",
          "authorization: options.token",
        );
        NodeAssert.notEqual(broken, source, "The bearer header line was not found to break");
        NodeFS.writeFileSync(file, broken);
        const wt = (...args: string[]) =>
          NodeChildProcess.execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
        wt("add", "web/src/api/client.ts");
        wt(
          "-c",
          "user.name=Verifier",
          "-c",
          "user.email=verifier@localhost",
          "commit",
          "-qm",
          "verifier: injected regression (drops the Bearer prefix)",
        );
        milestone("regression.injected", { task: frontend.key, file: "web/src/api/client.ts" });
      }
      snapshot = yield* client["goagent.integrateMission"]({ missionId });
      writeSnapshot("04-integrated.json", snapshot);
      milestone("integration", snapshot.mission.integration);
      checks.integrated = snapshot.mission.integration.status === "completed";
      if (checks.integrated) {
        snapshot = yield* client["goagent.verifyMission"]({ missionId });
        writeSnapshot("05-verified.json", snapshot);
        for (const run of snapshot.verificationRuns)
          milestone("verification.run", {
            command: run.argv.join(" "),
            status: run.status,
            exitCode: run.exitCode,
            tests: run.testSummary,
          });
        if (!values["inject-regression"]) {
          checks.verificationPassed =
            snapshot.verificationRuns.length > 0 &&
            snapshot.verificationRuns.every((run) => run.status === "passed");
        } else {
          checks.injectedFailureCaught = snapshot.verificationRuns.some(
            (run) => run.status === "failed",
          );
          const owner = snapshot.decisions.findLast((d) => d.key === "failure.owner");
          milestone("failure.owner", owner ?? {});
          checks.ownerIsFrontend = owner?.answer === "frontend";
          if (checks.injectedFailureCaught && owner !== undefined && owner.answer !== "unknown") {
            snapshot = yield* client["goagent.requestRepair"]({ missionId });
            checks.repairSent = snapshot.events.some((e) => e.type === "repair.requested");
            const firstRuns = new Set(snapshot.verificationRuns.map((run) => run.runId));
            // GoAgent re-integrates and re-verifies by itself once the repairing agent finishes.
            snapshot = yield* follow(
              (item) =>
                ["completed", "needs_review", "failed", "cancelled"].includes(item.mission.state) &&
                item.verificationRuns.some((run) => !firstRuns.has(run.runId)) &&
                item.verificationRuns.every((run) => run.status !== "running"),
            );
            writeSnapshot("05b-repaired.json", snapshot);
            const rerun = snapshot.verificationRuns.filter((run) => !firstRuns.has(run.runId));
            for (const run of rerun)
              milestone("verification.rerun", {
                command: run.argv.join(" "),
                status: run.status,
                exitCode: run.exitCode,
                tests: run.testSummary,
              });
            checks.repairedAndPassed =
              rerun.length > 0 &&
              rerun.every((run) => run.status === "passed") &&
              snapshot.mission.state === "completed";
          }
        }
      }
    }
    snapshot = yield* client["goagent.getMission"]({ missionId });
    writeSnapshot("06-final.json", snapshot);
    return {
      missionId,
      missionState: snapshot.mission.state,
      decisions: snapshot.decisions.map((d) => ({
        key: d.key,
        answer: d.answer,
        source: d.source,
        confidence: d.confidence,
        model: d.model,
      })),
    };
  }).pipe(Effect.scoped, Effect.provide(layerProtocol), Effect.timeout(timeoutMs));

  const finished = await Effect.runPromise(program, { signal: abort.signal });
  const failedChecks = Object.entries(checks)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);
  verdict = {
    status: failedChecks.length === 0 ? "passed" : "failed",
    failedChecks,
    checks,
    ...finished,
  };
  console.log(JSON.stringify(verdict, null, 2));
  if (failedChecks.length > 0) process.exitCode = 1;
} catch (error) {
  verdict = { status: "failed", reason: String(error), checks };
  console.error(String(error));
  process.exitCode = 1;
} finally {
  NodeFS.writeFileSync(NodePath.join(evidence, "verdict.json"), JSON.stringify(verdict, null, 2));
  await stopServer(server);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  console.log(`Evidence: ${evidence}`);
}

async function stopServer(server: ReturnType<typeof NodeChildProcess.spawn>) {
  const running = server.exitCode === null && server.signalCode === null;
  if (running) {
    const stopped = new Promise<void>((done) => server.once("exit", () => done()));
    // Windows has no process groups: end the tree of the PID captured at spawn while it is alive
    // so provider CLIs started by the server are not orphaned. Never a pattern match.
    if (isWindows && server.pid)
      NodeChildProcess.spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    else server.kill("SIGTERM");
    const deadline = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await stopped;
    clearTimeout(deadline);
  }
  if (!server.pid || isWindows) return;
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
