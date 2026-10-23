import { WS_METHODS, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Atoms for GoAgent missions: project state, the knowledge graph, and a live mission stream. */
export function createGoAgentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const projectState = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:goagent:project-state",
    tag: WS_METHODS.goagentGetProjectState,
    staleTimeMs: 2_000,
  });
  const graph = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:goagent:graph",
    tag: WS_METHODS.goagentGetGraph,
    staleTimeMs: 60_000,
  });
  const graphDelta = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:goagent:graph-delta",
    tag: WS_METHODS.goagentGetGraphDelta,
    staleTimeMs: 5 * 60_000,
  });
  const missionLive = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:goagent:mission:live",
    tag: WS_METHODS.goagentSubscribeMission,
  });

  const refreshProject = (
    registry: { readonly refresh: (atom: Atom.Atom<unknown>) => void },
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) =>
    Effect.sync(() => {
      registry.refresh(projectState({ environmentId, input: { projectId } }));
      registry.refresh(graph({ environmentId, input: { projectId } }));
    });

  return {
    projectState,
    graph,
    graphDelta,
    missionLive,
    indexProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goagent:index-project",
      tag: WS_METHODS.goagentIndexProject,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.projectId}`,
      },
      onSuccess: ({ environmentId, input }, registry) =>
        refreshProject(registry, environmentId, input.projectId),
    }),
    setVerificationCommands: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goagent:set-verification-commands",
      tag: WS_METHODS.goagentSetVerificationCommands,
      onSuccess: ({ environmentId, input }, registry) =>
        refreshProject(registry, environmentId, input.projectId),
    }),
    createMission: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goagent:create-mission",
      tag: WS_METHODS.goagentCreateMission,
      onSuccess: ({ environmentId, input }, registry) =>
        refreshProject(registry, environmentId, input.projectId),
    }),
    updatePlan: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goagent:update-plan",
      tag: WS_METHODS.goagentUpdatePlan,
    }),
    approveMission: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goagent:approve-mission",
      tag: WS_METHODS.goagentApproveMission,
    }),
    startMission: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goagent:start-mission",
      tag: WS_METHODS.goagentStartMission,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.missionId}`,
      },
    }),
    cancelMission: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goagent:cancel-mission",
      tag: WS_METHODS.goagentCancelMission,
    }),
    overrideDecision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goagent:override-decision",
      tag: WS_METHODS.goagentOverrideDecision,
    }),
    integrateMission: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goagent:integrate-mission",
      tag: WS_METHODS.goagentIntegrateMission,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.missionId}`,
      },
    }),
    verifyMission: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:goagent:verify-mission",
      tag: WS_METHODS.goagentVerifyMission,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.missionId}`,
      },
    }),
  };
}
