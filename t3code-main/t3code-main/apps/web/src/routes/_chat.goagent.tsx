import type { EnvironmentId, GoAgentMissionId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { GoAgentPage, GOAGENT_TABS, type GoAgentSearch } from "../components/goagent/GoAgentPage";

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;

export const Route = createFileRoute("/_chat/goagent")({
  validateSearch: (raw: Record<string, unknown>): GoAgentSearch => {
    const environment = text(raw.environment);
    const project = text(raw.project);
    const mission = text(raw.mission);
    const tab = GOAGENT_TABS.find((candidate) => candidate === raw.tab);
    return {
      ...(environment === undefined ? {} : { environment: environment as EnvironmentId }),
      ...(project === undefined ? {} : { project: project as ProjectId }),
      ...(mission === undefined ? {} : { mission: mission as GoAgentMissionId }),
      ...(tab === undefined ? {} : { tab }),
    };
  },
  component: GoAgentPage,
});
