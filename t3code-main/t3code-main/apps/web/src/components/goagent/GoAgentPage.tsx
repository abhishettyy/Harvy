import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  GoAgentMissionId,
  GoAgentMissionSnapshot,
  GoAgentProjectState,
  ProjectId,
} from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { isElectron } from "../../env";
import { useProjects } from "../../state/entities";
import { goagent } from "../../state/goagent";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { GoAgentGraphView } from "./GoAgentGraphView";
import { GoAgentMissionView } from "./GoAgentMissionView";
import { AuditTimeline, DecisionsPanel, VerificationPanel } from "./GoAgentPanels";
import { StateBadge } from "./GoAgentStateBadge";

export const GOAGENT_TABS = ["mission", "graph", "decisions", "audit", "verify"] as const;
export type GoAgentTab = (typeof GOAGENT_TABS)[number];

export interface GoAgentSearch {
  readonly environment?: EnvironmentId;
  readonly project?: ProjectId;
  readonly mission?: GoAgentMissionId;
  readonly tab?: GoAgentTab;
}

const TAB_LABELS: Record<GoAgentTab, string> = {
  mission: "Mission",
  graph: "Knowledge graph",
  decisions: "Decisions",
  audit: "Audit",
  verify: "Verify",
};

export function GoAgentPage() {
  const search = useSearch({ from: "/_chat/goagent" });
  const navigate = useNavigate({ from: "/goagent" });
  const projects = useProjects().filter((project) => project.isScratch !== true);
  const selected =
    projects.find((p) => p.environmentId === search.environment && p.id === search.project) ?? null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="text-sm font-medium">GoAgent</span>
            {selected === null ? null : (
              <>
                <span className="text-muted-foreground">/</span>
                <span className="truncate text-sm">{selected.title}</span>
                <Button
                  size="compact"
                  variant="ghost-muted"
                  onClick={() => void navigate({ search: {} })}
                >
                  Change project
                </Button>
              </>
            )}
          </div>
        </WorkspacePageHeader>
        {selected === null ? (
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer>
              <div className="flex flex-col gap-1">
                <h1 className="text-lg font-semibold">Choose a project</h1>
                <p className="text-sm text-muted-foreground">
                  GoAgent maps the repository with Graphify, plans parallel agent tasks, and
                  verifies the integrated result.
                </p>
              </div>
              {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">Add a project to get started.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {projects.map((project) => (
                    <Button
                      key={`${project.environmentId}:${project.id}`}
                      variant="outline"
                      className="justify-start"
                      onClick={() =>
                        void navigate({
                          search: { environment: project.environmentId, project: project.id },
                        })
                      }
                    >
                      <span className="truncate">{project.title}</span>
                      <span className="ml-auto truncate text-xs text-muted-foreground">
                        {project.workspaceRoot}
                      </span>
                    </Button>
                  ))}
                </div>
              )}
            </WorkspacePageContainer>
          </ScrollArea>
        ) : (
          <GoAgentWorkspace
            environmentId={selected.environmentId}
            projectId={selected.id}
            missionId={search.mission ?? null}
            tab={search.tab ?? "mission"}
          />
        )}
      </div>
    </SidebarInset>
  );
}

function GoAgentWorkspace({
  environmentId,
  projectId,
  missionId,
  tab,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly missionId: GoAgentMissionId | null;
  readonly tab: GoAgentTab;
}) {
  const navigate = useNavigate({ from: "/goagent" });
  const stateResult = useAtomValue(goagent.projectState({ environmentId, input: { projectId } }));
  const state = Option.getOrNull(AsyncResult.value(stateResult));
  const setSearch = (patch: Partial<GoAgentSearch>) =>
    void navigate({ search: (previous) => ({ ...previous, ...patch }) });

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r p-4">
        <ProjectStatus environmentId={environmentId} projectId={projectId} state={state} />
        <MissionComposer
          environmentId={environmentId}
          projectId={projectId}
          onCreated={(snap) => setSearch({ mission: snap.mission.missionId, tab: "mission" })}
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase text-muted-foreground">Missions</span>
          {state === null ? (
            <Spinner />
          ) : state.missions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No missions yet.</p>
          ) : (
            state.missions.map((mission) => (
              <Button
                key={mission.missionId}
                variant={mission.missionId === missionId ? "secondary" : "ghost"}
                size="compact"
                className="justify-start"
                onClick={() => setSearch({ mission: mission.missionId })}
              >
                <span className="truncate">{mission.title}</span>
                <StateBadge state={mission.state} className="ml-auto" />
              </Button>
            ))
          )}
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <nav className="flex shrink-0 gap-1 border-b px-4 py-2">
          {GOAGENT_TABS.map((candidate) => (
            <Button
              key={candidate}
              size="compact"
              variant={candidate === tab ? "secondary" : "ghost-muted"}
              onClick={() => setSearch({ tab: candidate })}
            >
              {TAB_LABELS[candidate]}
            </Button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-hidden">
          {missionId === null ? (
            tab === "graph" ? (
              <GoAgentGraphView
                environmentId={environmentId}
                projectId={projectId}
                snapshot={null}
              />
            ) : (
              <EmptyMission />
            )
          ) : (
            <MissionTabs
              key={missionId}
              environmentId={environmentId}
              projectId={projectId}
              missionId={missionId}
              tab={tab}
              state={state}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MissionTabs({
  environmentId,
  projectId,
  missionId,
  tab,
  state,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly missionId: GoAgentMissionId;
  readonly tab: GoAgentTab;
  readonly state: GoAgentProjectState | null;
}) {
  const missionResult = useAtomValue(goagent.missionLive({ environmentId, input: { missionId } }));
  const snapshot = Option.getOrNull(AsyncResult.value(missionResult));
  if (snapshot === null)
    return (
      <div className="p-6">
        {missionResult._tag === "Failure" ? (
          <p className="text-sm text-destructive-foreground">The mission could not be loaded.</p>
        ) : (
          <Spinner />
        )}
      </div>
    );
  switch (tab) {
    case "graph":
      return (
        <GoAgentGraphView environmentId={environmentId} projectId={projectId} snapshot={snapshot} />
      );
    case "decisions":
      return <DecisionsPanel environmentId={environmentId} snapshot={snapshot} />;
    case "audit":
      return <AuditTimeline snapshot={snapshot} />;
    case "verify":
      return <VerificationPanel environmentId={environmentId} snapshot={snapshot} state={state} />;
    case "mission":
      return <GoAgentMissionView environmentId={environmentId} snapshot={snapshot} state={state} />;
  }
}

function EmptyMission() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm font-medium">No mission selected</p>
      <p className="max-w-md text-sm text-muted-foreground">
        Describe a feature on the left. GoAgent reads the knowledge graph, asks Jev whether to split
        the work, and drafts a plan you can edit before any agent starts.
      </p>
    </div>
  );
}

function ProjectStatus({
  environmentId,
  projectId,
  state,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly state: GoAgentProjectState | null;
}) {
  const index = useAtomCommand(goagent.indexProject, { label: "GoAgent index" });
  const [indexing, setIndexing] = useState(false);
  if (state === null) return <Spinner />;
  const scan = state.latestBaseScan;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <ToolRow name="Graphify" status={state.graphify} />
      <ToolRow name="Jev" status={state.jev} unavailableLabel="fallback rules" />
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Graph</span>
        <span className="ml-auto">
          {scan === null
            ? "not indexed"
            : `${scan.nodeCount} nodes · ${scan.edgeCount} edges${scan.commitSha ? ` · ${scan.commitSha.slice(0, 7)}` : ""}`}
        </span>
      </div>
      <Button
        size="compact"
        variant="outline"
        disabled={indexing || !state.graphify.available}
        onClick={async () => {
          setIndexing(true);
          await index({ environmentId, input: { projectId } });
          setIndexing(false);
        }}
      >
        {indexing ? <Spinner /> : null}
        {scan === null ? "Index repository" : "Re-index"}
      </Button>
    </div>
  );
}

function ToolRow({
  name,
  status,
  unavailableLabel = "unavailable",
}: {
  readonly name: string;
  readonly status: GoAgentProjectState["graphify"];
  readonly unavailableLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{name}</span>
        <span className="ml-auto">
          <Badge size="sm" variant={status.available ? "success" : "warning"}>
            {status.available ? (status.version ?? "ready") : unavailableLabel}
          </Badge>
        </span>
      </div>
      {status.available || status.detail === null ? null : (
        <span className="text-3xs text-muted-foreground">{status.detail}</span>
      )}
    </div>
  );
}

function MissionComposer({
  environmentId,
  projectId,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onCreated: (snapshot: GoAgentMissionSnapshot) => void;
}) {
  const create = useAtomCommand(goagent.createMission, { label: "GoAgent create mission" });
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (request.trim().length === 0 || busy) return;
    setBusy(true);
    const result = await create({ environmentId, input: { projectId, request: request.trim() } });
    setBusy(false);
    if (result._tag === "Success") {
      setRequest("");
      onCreated(result.value);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase text-muted-foreground">New mission</span>
      <Textarea
        size="sm"
        value={request}
        placeholder="Add an authenticated edit-profile feature; keep the existing JWT auth."
        onChange={(event) => setRequest(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
        }}
      />
      <Button
        size="compact"
        disabled={busy || request.trim().length === 0}
        onClick={() => void submit()}
      >
        {busy ? <Spinner /> : null}
        Plan mission
      </Button>
    </div>
  );
}
