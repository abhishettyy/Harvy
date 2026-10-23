import {
  GoAgentError,
  GoAgentScanId,
  type GoAgentGraphDelta,
  type GoAgentGraphScan,
  type GoAgentGraphSnapshot,
  type GoAgentMissionId,
  type GoAgentScanScope,
  type GoAgentToolStatus,
  type ProjectId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GoAgentStore from "./GoAgentStore.ts";
import {
  diffGraphs,
  neighbourhood,
  parseGraphifyGraph,
  searchNodes,
  type ParsedGraph,
} from "./graphifyGraph.ts";

const INDEX_TIMEOUT = Duration.minutes(5);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const PROBE_TIMEOUT = Duration.seconds(20);
/** The UI renders at most this many nodes; larger graphs are trimmed to files + their edges. */
const SNAPSHOT_NODE_LIMIT = 400;

export interface IndexInput {
  readonly projectId: ProjectId;
  readonly root: string;
  readonly scope: GoAgentScanScope;
  readonly missionId?: GoAgentMissionId | undefined;
  readonly taskKey?: string | undefined;
}

export class GoAgentGraphService extends Context.Service<
  GoAgentGraphService,
  {
    readonly status: Effect.Effect<GoAgentToolStatus>;
    readonly index: (input: IndexInput) => Effect.Effect<GoAgentGraphScan, GoAgentError>;
    readonly latestBaseScan: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<GoAgentGraphScan>, GoAgentError>;
    readonly snapshot: (scanId: GoAgentScanId) => Effect.Effect<GoAgentGraphSnapshot, GoAgentError>;
    readonly delta: (
      baseScanId: GoAgentScanId,
      scanId: GoAgentScanId,
    ) => Effect.Effect<GoAgentGraphDelta, GoAgentError>;
    readonly search: (
      scanId: GoAgentScanId,
      query: string,
      limit: number,
    ) => Effect.Effect<GoAgentGraphSnapshot["nodes"], GoAgentError>;
    readonly neighbours: (
      scanId: GoAgentScanId,
      nodeIds: ReadonlyArray<string>,
      options: { readonly hops: number; readonly maxNodes: number },
    ) => Effect.Effect<Pick<GoAgentGraphSnapshot, "nodes" | "edges">, GoAgentError>;
  }
>()("t3/goagent/GoAgentGraphService") {}

const storageError = (cause: GoAgentStore.GoAgentStoreError) =>
  new GoAgentError({ code: "storage_failed", message: cause.message });

/** Keeps every file node plus its direct symbols until the limit, then only edges between kept nodes. */
function trimForDisplay(
  graph: Pick<ParsedGraph, "nodes" | "edges">,
  limit: number,
): {
  readonly nodes: ParsedGraph["nodes"];
  readonly edges: ParsedGraph["edges"];
  readonly truncated: boolean;
} {
  if (graph.nodes.length <= limit) return { ...graph, truncated: false };
  const ordered = [
    ...graph.nodes.filter((node) => node.kind === "file"),
    ...graph.nodes.filter((node) => node.kind === "rationale"),
    ...graph.nodes.filter((node) => node.kind === "symbol"),
    ...graph.nodes.filter((node) => node.kind === "concept"),
  ].slice(0, limit);
  const kept = new Set(ordered.map((node) => node.id));
  return {
    nodes: ordered,
    edges: graph.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
    truncated: true,
  };
}

const make = Effect.gen(function* () {
  const store = yield* GoAgentStore.GoAgentStore;
  const runner = yield* ProcessRunner.ProcessRunner;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const graphifyCommand = yield* Config.String("GOAGENT_GRAPHIFY_PATH").pipe(
    Config.withDefault("graphify"),
    Effect.orElseSucceed(() => "graphify"),
  );
  const graphsDir = path.join(stateDir, "goagent", "graphs");

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const status = runner
    .run({
      command: graphifyCommand,
      args: ["--version"],
      timeout: PROBE_TIMEOUT,
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 4_096,
      outputMode: "truncate",
    })
    .pipe(
      Effect.map((output): GoAgentToolStatus => {
        const version = /graphify\s+(\S+)/.exec(output.stdout)?.[1] ?? null;
        return output.code === 0 && version !== null
          ? { available: true, version, detail: null }
          : { available: false, version: null, detail: "graphify --version did not succeed" };
      }),
      Effect.orElseSucceed((): GoAgentToolStatus => ({
        available: false,
        version: null,
        detail: "Graphify is not installed. Install it with: uv tool install graphifyy",
      })),
    );

  const revParse = (root: string) =>
    git
      .execute({
        operation: "goagent.revParse",
        cwd: root,
        args: ["rev-parse", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
        Effect.orElseSucceed(() => null),
      );

  const isDirty = (root: string) =>
    git
      .execute({
        operation: "goagent.status",
        cwd: root,
        args: ["status", "--porcelain"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.exitCode !== 0 || result.stdout.trim().length > 0),
        Effect.orElseSucceed(() => true),
      );

  const runGraphify = Effect.fn("GoAgentGraphService.runGraphify")(function* (
    root: string,
    outDir: string,
  ) {
    const args = ["extract", root, "--code-only", "--out", outDir];
    // Graphify's process pool costs minutes to start on Windows; one worker is faster for
    // repositories of the size a mission works on.
    if (platform === "win32") args.push("--max-workers", "1");
    const output = yield* runner
      .run({
        command: graphifyCommand,
        args,
        cwd: root,
        timeout: INDEX_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 64_000,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError(
          () =>
            new GoAgentError({
              code: "graphify_unavailable",
              message: "Graphify could not be started.",
            }),
        ),
      );
    if (output.timedOut)
      return yield* new GoAgentError({
        code: "graph_index_failed",
        message: "Graphify timed out.",
      });
    if (output.code !== 0)
      return yield* new GoAgentError({
        code: "graph_index_failed",
        message: `Graphify exited with code ${output.code ?? "unknown"}.`,
      });
    const raw = yield* fileSystem
      .readFileString(path.join(outDir, "graphify-out", "graph.json"))
      .pipe(
        Effect.mapError(
          () =>
            new GoAgentError({
              code: "graph_index_failed",
              message: "Graphify wrote no graph.json.",
            }),
        ),
      );
    const json = yield* decodeJson(raw).pipe(
      Effect.mapError(
        () =>
          new GoAgentError({
            code: "graph_index_failed",
            message: "graph.json is not valid JSON.",
          }),
      ),
    );
    const parsed = parseGraphifyGraph(json);
    if (!parsed.ok)
      return yield* new GoAgentError({
        code:
          parsed.reason === "unsupported_schema"
            ? "graphify_schema_unsupported"
            : "graph_index_failed",
        message: parsed.detail,
      });
    return parsed.graph;
  });

  const index = Effect.fn("GoAgentGraphService.index")(function* (input: IndexInput) {
    const commitSha = yield* revParse(input.root);
    if (input.scope === "base" && commitSha !== null && !(yield* isDirty(input.root))) {
      const latest = yield* store
        .latestScan({ projectId: input.projectId, scope: "base", status: "completed" })
        .pipe(Effect.mapError(storageError));
      if (Option.isSome(latest) && latest.value.commitSha === commitSha) return latest.value;
    }
    const scanId = GoAgentScanId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const running: GoAgentGraphScan = {
      scanId,
      projectId: input.projectId,
      scope: input.scope,
      missionId: input.missionId ?? null,
      taskKey: input.taskKey ?? null,
      commitSha,
      status: "running",
      graphifyVersion: null,
      schemaVersion: null,
      nodeCount: 0,
      edgeCount: 0,
      startedAt: yield* nowIso,
      finishedAt: null,
      failure: null,
    };
    yield* store.putScan(running).pipe(Effect.mapError(storageError));
    const outDir = path.join(graphsDir, scanId);
    const result = yield* runGraphify(input.root, outDir).pipe(
      Effect.ensuring(fileSystem.remove(outDir, { recursive: true }).pipe(Effect.ignore)),
      Effect.result,
    );
    const finishedAt = yield* nowIso;
    if (result._tag === "Failure") {
      yield* store
        .putScan({ ...running, status: "failed", finishedAt, failure: result.failure.message })
        .pipe(Effect.mapError(storageError));
      return yield* result.failure;
    }
    const graph = result.success;
    const completed: GoAgentGraphScan = {
      ...running,
      status: "completed",
      graphifyVersion: graph.graphifyVersion,
      schemaVersion: graph.schemaVersion,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      finishedAt,
    };
    yield* store.completeScan(completed, graph).pipe(Effect.mapError(storageError));
    return completed;
  });

  const requireScan = (scanId: GoAgentScanId) =>
    store.getScan(scanId).pipe(
      Effect.mapError(storageError),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new GoAgentError({
                code: "scan_not_found",
                message: "The graph scan was not found.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const graphOf = (scanId: GoAgentScanId) =>
    store.getScanGraph(scanId).pipe(Effect.mapError(storageError));

  return GoAgentGraphService.of({
    status,
    index,
    latestBaseScan: (projectId) =>
      store
        .latestScan({ projectId, scope: "base", status: "completed" })
        .pipe(Effect.mapError(storageError)),
    snapshot: Effect.fn("GoAgentGraphService.snapshot")(function* (scanId) {
      const scan = yield* requireScan(scanId);
      const graph = yield* graphOf(scanId);
      return { scan, ...trimForDisplay(graph, SNAPSHOT_NODE_LIMIT) };
    }),
    delta: Effect.fn("GoAgentGraphService.delta")(function* (baseScanId, scanId) {
      yield* requireScan(baseScanId);
      yield* requireScan(scanId);
      const diff = diffGraphs(yield* graphOf(baseScanId), yield* graphOf(scanId));
      return { baseScanId, scanId, ...diff };
    }),
    search: (scanId, query, limit) =>
      graphOf(scanId).pipe(Effect.map((graph) => searchNodes(graph.nodes, query, limit))),
    neighbours: (scanId, nodeIds, options) =>
      graphOf(scanId).pipe(Effect.map((graph) => neighbourhood(graph, nodeIds, options))),
  });
});

export const layer = Layer.effect(GoAgentGraphService, make);
