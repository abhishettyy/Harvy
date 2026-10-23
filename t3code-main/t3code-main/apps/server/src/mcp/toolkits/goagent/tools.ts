import {
  GoAgentContract,
  GoAgentContractSpec,
  GoAgentGraphEdge,
  GoAgentGraphNode,
  GoAgentTaskState,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as GoAgentMissionService from "../../../goagent/GoAgentMissionService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// McpToolAccess caller checks read the calling thread through ThreadManagementService.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  GoAgentMissionService.GoAgentMissionService,
];

const GraphResult = Schema.Struct({
  nodes: Schema.Array(GoAgentGraphNode),
  edges: Schema.Array(GoAgentGraphEdge),
});

const ContractResult = Schema.Struct({ contract: Schema.NullOr(GoAgentContract) });

const GraphSearchTool = Tool.make("goagent_graph_search", {
  description:
    "Only for agents working on a GoAgent mission task. Search the mission's knowledge graph (built by Graphify from source) for files, functions, classes and WHY-rationale comments by name or path. Each result cites its source file and line. Use this before grepping the repository.",
  parameters: Schema.Struct({ query: Schema.String.check(Schema.isMinLength(1)) }),
  success: Schema.Struct({ nodes: Schema.Array(GoAgentGraphNode) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Search the GoAgent knowledge graph")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const GraphNeighboursTool = Tool.make("goagent_graph_neighbours", {
  description:
    "Only for agents working on a GoAgent mission task. Return the graph neighbourhood (imports, calls, contains, rationale) around node ids from goagent_graph_search, up to 3 hops. Edges carry evidence: verified_static is read from source, inferred and ambiguous are not proven.",
  parameters: Schema.Struct({
    nodeIds: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    hops: Schema.optional(Schema.Int),
  }),
  success: GraphResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Explore the GoAgent knowledge graph")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ContractProposeTool = Tool.make("goagent_contract_propose", {
  description:
    "Only for the GoAgent task that owns the API contract. Publish the HTTP API other mission agents will build against: method, path, request shape, response shape and notes (auth, errors). Each call creates a new version; agents that depend on it are started or told to re-acknowledge, and integration waits until they acknowledge the latest version.",
  parameters: GoAgentContractSpec,
  success: GoAgentContract,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Propose the mission API contract")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ContractReadTool = Tool.make("goagent_contract_read", {
  description:
    "Only for agents working on a GoAgent mission task. Read the latest version of the mission's API contract and who has acknowledged it. Returns null when no contract has been proposed yet.",
  success: ContractResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read the mission API contract")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ContractAcknowledgeTool = Tool.make("goagent_contract_acknowledge", {
  description:
    "Only for GoAgent tasks that consume the API contract. Confirm you will use contract `version` exactly as specified; `note` says in one line how you will call it. Fails if a newer version exists, so read the contract again in that case.",
  parameters: Schema.Struct({
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    note: Schema.String.check(Schema.isMinLength(1)),
  }),
  success: GoAgentContract,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Acknowledge the mission API contract")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TaskStatusTool = Tool.make("goagent_task_status", {
  description:
    "Only for agents working on a GoAgent mission task. Report the mission, your task, the other tasks' states and what blocks them, and the current contract version.",
  success: Schema.Struct({
    mission: Schema.Struct({ title: Schema.String, state: Schema.String, request: Schema.String }),
    taskKey: Schema.String,
    tasks: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        state: GoAgentTaskState,
        blockedOn: Schema.Array(Schema.String),
      }),
    ),
    contractVersion: Schema.NullOr(Schema.Int),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "GoAgent task status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const GoAgentToolkit = Toolkit.make(
  GraphSearchTool,
  GraphNeighboursTool,
  ContractProposeTool,
  ContractReadTool,
  ContractAcknowledgeTool,
  TaskStatusTool,
);
