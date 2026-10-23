import { OrchestratorMcpFailure, type GoAgentError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as GoAgentMissionService from "../../../goagent/GoAgentMissionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { GoAgentToolkit } from "./tools.ts";

const toFailure = (error: GoAgentError) =>
  new OrchestratorMcpFailure({
    code: error.code === "storage_failed" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

/** The calling agent's thread; GoAgent scopes every tool to that thread's own mission task. */
const withCaller = Effect.fn("GoAgentMcp.withCaller")(function* <A, R>(
  run: (
    service: GoAgentMissionService.GoAgentMissionService["Service"],
    caller: GoAgentMissionService.AgentCaller,
  ) => Effect.Effect<A, GoAgentError, R>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "GoAgent tools are only available to agents running inside a mission thread.",
    });
  const service = yield* GoAgentMissionService.GoAgentMissionService;
  return yield* run(service, { threadId: scope.thread.threadId }).pipe(Effect.mapError(toFailure));
});

const handlers = {
  goagent_graph_search: McpToolAccess.readsAsCaller((input) =>
    withCaller((service, caller) =>
      service.agentGraphSearch(caller, input.query).pipe(Effect.map((nodes) => ({ nodes }))),
    ),
  ),
  goagent_graph_neighbours: McpToolAccess.readsAsCaller((input) =>
    withCaller((service, caller) =>
      service.agentGraphNeighbours(caller, input.nodeIds, input.hops ?? 1),
    ),
  ),
  goagent_contract_propose: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) => service.agentProposeContract(caller, input)),
  ),
  goagent_contract_read: McpToolAccess.readsAsCaller(() =>
    withCaller((service, caller) =>
      service.agentTaskStatus(caller).pipe(Effect.map(({ contract }) => ({ contract }))),
    ),
  ),
  goagent_contract_acknowledge: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) => service.agentAcknowledgeContract(caller, input)),
  ),
  goagent_task_status: McpToolAccess.readsAsCaller(() =>
    withCaller((service, caller) =>
      service.agentTaskStatus(caller).pipe(
        Effect.map(({ mission, task, tasks, contract }) => ({
          mission: { title: mission.title, state: mission.state, request: mission.request },
          taskKey: task.key,
          tasks: tasks.map((t) => ({ key: t.key, state: t.state, blockedOn: t.blockedOn })),
          contractVersion: contract?.version ?? null,
        })),
      ),
    ),
  ),
  goagent_project_decisions: McpToolAccess.readsAsCaller(() =>
    withCaller((service, caller) =>
      service.agentProjectDecisions(caller).pipe(Effect.map((decisions) => ({ decisions }))),
    ),
  ),
  goagent_record_decision: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) => service.agentRecordDecision(caller, input)),
  ),
  goagent_handoff: McpToolAccess.actsAsCaller((input) =>
    withCaller((service, caller) =>
      service.agentHandoff(caller, { note: input.note, files: input.files ?? [] }),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof GoAgentToolkit.tools>;

export const layer = McpToolAccess.toLayer(GoAgentToolkit, handlers);
