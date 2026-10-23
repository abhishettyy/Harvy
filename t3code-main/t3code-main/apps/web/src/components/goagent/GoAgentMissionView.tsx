import "@xyflow/react/dist/style.css";

import type {
  EnvironmentId,
  GoAgentContractSpec,
  GoAgentMissionSnapshot,
  GoAgentPlan,
  GoAgentPlanTask,
  GoAgentProjectState,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Background, MarkerType, ReactFlow } from "@xyflow/react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { goagent } from "../../state/goagent";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { StateBadge } from "./GoAgentStateBadge";
import { buildMissionDag, nextStep, type NextStep } from "./goagentLayout";

export function GoAgentMissionView({
  environmentId,
  snapshot,
  state,
  agentModelMissing = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: GoAgentMissionSnapshot;
  readonly state: GoAgentProjectState | null;
  /** The project has no default model, so starting agents would fail. */
  readonly agentModelMissing?: boolean;
}) {
  const { mission } = snapshot;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="h-72 shrink-0 border-b">
        <MissionDag snapshot={snapshot} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold">{mission.title}</h2>
          <StateBadge state={mission.state} />
          {mission.baseSha === null ? null : (
            <code className="text-xs text-muted-foreground">
              base {mission.baseSha.slice(0, 8)}
            </code>
          )}
          <MissionActions environmentId={environmentId} snapshot={snapshot} />
        </div>
        <NextStepBanner step={nextStep(snapshot, { agentModelMissing })} />
        <p className="text-sm text-muted-foreground">{mission.request}</p>
        {mission.state === "planned" ? (
          <PlanEditor environmentId={environmentId} snapshot={snapshot} state={state} />
        ) : mission.baseSha === null ? (
          <PlanSummary snapshot={snapshot} />
        ) : (
          <>
            <TaskList environmentId={environmentId} snapshot={snapshot} />
            <ContractCard snapshot={snapshot} />
            <IntegrationCard snapshot={snapshot} />
          </>
        )}
      </div>
    </div>
  );
}

const STEP_TONE: Record<NextStep["tone"], string> = {
  action: "border-info/50 bg-info/8",
  waiting: "border-border bg-muted/40",
  done: "border-success/50 bg-success/8",
  problem: "border-destructive/50 bg-destructive/8",
};

function NextStepBanner({ step }: { readonly step: NextStep }) {
  return (
    <div className={`flex flex-col gap-1 rounded-lg border p-3 ${STEP_TONE[step.tone]}`}>
      <span className="flex items-center gap-2 text-sm font-medium">
        {step.tone === "waiting" ? <Spinner /> : null}
        {step.tone === "action" ? "Next: " : ""}
        {step.title}
      </span>
      <span className="text-xs text-muted-foreground">{step.detail}</span>
    </div>
  );
}

/** The approved-but-not-started plan: who will work on what. */
function PlanSummary({ snapshot }: { readonly snapshot: GoAgentMissionSnapshot }) {
  const { plan } = snapshot.mission;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">
        Planned agents ({plan.tasks.length})
      </h3>
      {plan.tasks.map((task) => (
        <div key={task.key} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
          <span className="flex items-center gap-2">
            <span className="font-medium">{task.title}</span>
            <code className="text-xs text-muted-foreground">{task.key}</code>
            {task.proposesContract ? <StateBadge state="proposes contract" /> : null}
          </span>
          <span className="text-xs text-muted-foreground">Owns {task.ownsPaths.join(", ")}</span>
          {task.dependsOn.length > 0 ? (
            <span className="text-xs">Starts after: {task.dependsOn.join(", ")}</span>
          ) : (
            <span className="text-xs">Starts immediately</span>
          )}
        </div>
      ))}
      {(plan.coupling ?? []).length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Knowledge graph:{" "}
          {(plan.coupling ?? []).map((c) => `${c.from} uses ${c.to} (${c.edgeCount})`).join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

function MissionDag({ snapshot }: { readonly snapshot: GoAgentMissionSnapshot }) {
  const dag = buildMissionDag(snapshot);
  const nodes = dag.nodes.map((node) => ({
    id: node.id,
    position: { x: node.x, y: node.y },
    draggable: false,
    data: {
      label: (
        <div className="flex flex-col gap-1 text-left">
          <span className="text-xs font-medium">{node.label}</span>
          <StateBadge state={node.state} />
          {node.detail === null ? null : (
            <span className="truncate text-3xs text-muted-foreground">{node.detail}</span>
          )}
        </div>
      ),
    },
    className: "rounded-md! border! bg-card! text-card-foreground! w-48!",
  }));
  const edges = dag.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label ?? undefined,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      nodesConnectable={false}
      nodesDraggable={false}
      zoomOnScroll={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
    </ReactFlow>
  );
}

function MissionActions({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: GoAgentMissionSnapshot;
}) {
  const { mission, tasks } = snapshot;
  const missionId = mission.missionId;
  const approve = useAtomCommand(goagent.approveMission, { label: "GoAgent approve" });
  const start = useAtomCommand(goagent.startMission, { label: "GoAgent start" });
  const cancel = useAtomCommand(goagent.cancelMission, { label: "GoAgent cancel" });
  const integrate = useAtomCommand(goagent.integrateMission, { label: "GoAgent integrate" });
  const verify = useAtomCommand(goagent.verifyMission, { label: "GoAgent verify" });
  const repair = useAtomCommand(goagent.requestRepair, { label: "GoAgent repair" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (name: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(name);
    setError(null);
    const result = await action();
    setBusy(null);
    // Show why a button did nothing (e.g. no default model) instead of failing silently.
    if (!AsyncResult.isSuccess(result) && !Cause.hasInterruptsOnly(result.cause)) {
      const cause = Cause.squash(result.cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const allDone = tasks.length > 0 && tasks.every((task) => task.state === "completed");
  const coordinating = snapshot.coordinating === true;
  const heldForReview = mission.state === "needs_review" && mission.baseSha === null;
  const lastRun = snapshot.verificationRuns.at(-1);
  const repairUsed = snapshot.events.some((event) => event.type === "repair.requested");
  const owner = snapshot.decisions.findLast((decision) => decision.key === "failure.owner");
  const canRepair =
    mission.state === "needs_review" &&
    mission.integration.status === "completed" &&
    (lastRun?.status === "failed" || lastRun?.status === "timed_out") &&
    !repairUsed &&
    owner !== undefined &&
    owner.answer !== "unknown";
  const canCancel = !["completed", "cancelled", "failed"].includes(mission.state);
  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
      {error === null ? null : (
        <span className="w-full text-right text-xs text-destructive-foreground">{error}</span>
      )}
      {busy === null ? null : <Spinner />}
      {mission.state === "planned" || heldForReview ? (
        <Button
          size="compact"
          variant={heldForReview ? "destructive-outline" : "default"}
          disabled={busy !== null}
          onClick={() =>
            void run("approve", () =>
              approve({ environmentId, input: { missionId, planVersion: mission.planVersion } }),
            )
          }
        >
          {heldForReview ? "Approve despite high risk" : `Approve plan v${mission.planVersion}`}
        </Button>
      ) : null}
      {canRepair ? (
        <Button
          size="compact"
          disabled={busy !== null}
          onClick={() => void run("repair", () => repair({ environmentId, input: { missionId } }))}
        >
          Send repair to {owner.answer}
        </Button>
      ) : null}
      {mission.state === "approved" ? (
        <Button
          size="compact"
          disabled={busy !== null}
          onClick={() => void run("start", () => start({ environmentId, input: { missionId } }))}
        >
          Start agents
        </Button>
      ) : null}
      {(mission.state === "running" || mission.state === "needs_review") && allDone ? (
        <Button
          size="compact"
          disabled={busy !== null || coordinating}
          onClick={() =>
            void run("integrate", () => integrate({ environmentId, input: { missionId } }))
          }
        >
          {coordinating ? "Coordinating…" : "Integrate"}
        </Button>
      ) : null}
      {mission.integration.status === "completed" &&
      ["verifying", "needs_review", "completed"].includes(mission.state) ? (
        <Button
          size="compact"
          variant={mission.state === "completed" ? "outline" : "default"}
          disabled={busy !== null}
          onClick={() => void run("verify", () => verify({ environmentId, input: { missionId } }))}
        >
          {mission.state === "completed" ? "Verify again" : "Run verification"}
        </Button>
      ) : null}
      {canCancel ? (
        <Button
          size="compact"
          variant="ghost-destructive"
          disabled={busy !== null}
          onClick={() => void run("cancel", () => cancel({ environmentId, input: { missionId } }))}
        >
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

function TaskList({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: GoAgentMissionSnapshot;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">Agents</h3>
      {snapshot.tasks.map((task) => (
        <div key={task.key} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">{task.title}</span>
            <code className="text-xs text-muted-foreground">{task.key}</code>
            <StateBadge state={task.state} />
            {task.threadId === null ? null : (
              <Link
                className="ml-auto text-xs underline"
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: task.threadId }}
              >
                Open agent thread
              </Link>
            )}
          </div>
          {task.blockedOn.length > 0 ? (
            <span className="text-xs">Waiting for: {task.blockedOn.join(", ")}</span>
          ) : null}
          {task.failureReason === null ? null : (
            <span className="text-xs text-destructive-foreground">{task.failureReason}</span>
          )}
          {task.branch === null && task.worktreePath === null ? null : (
            <code className="text-xs text-muted-foreground">
              {task.branch ?? "detached"}{" "}
              {task.headSha === null ? "" : `@ ${task.headSha.slice(0, 8)}`}
            </code>
          )}
          {task.changedFiles.length > 0 ? (
            <details className="text-xs">
              <summary>{task.changedFiles.length} changed file(s)</summary>
              <ul className="mt-1 flex flex-col">
                {task.changedFiles.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function ContractCard({ snapshot }: { readonly snapshot: GoAgentMissionSnapshot }) {
  const contract = snapshot.contracts.at(-1);
  if (contract === undefined) return null;
  return (
    <section className="flex flex-col gap-1 rounded-md border p-3 text-sm">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">API contract v{contract.version}</h3>
        <span className="text-xs text-muted-foreground">proposed by {contract.proposedBy}</span>
      </div>
      <code className="text-xs">
        {contract.spec.method} {contract.spec.path}
      </code>
      <span className="text-xs">Request: {contract.spec.request || "—"}</span>
      <span className="text-xs">Response: {contract.spec.response || "—"}</span>
      {contract.spec.notes ? <span className="text-xs">Notes: {contract.spec.notes}</span> : null}
      <div className="mt-1 flex flex-col gap-1">
        {contract.acks.length === 0 ? (
          <span className="text-xs text-muted-foreground">No acknowledgment yet.</span>
        ) : (
          contract.acks.map((ack) => (
            <span key={ack.taskKey} className="text-xs">
              {ack.taskKey} acknowledged v{ack.version}
              {ack.version === contract.version ? "" : " (stale)"}: {ack.note}
            </span>
          ))
        )}
      </div>
    </section>
  );
}

function IntegrationCard({ snapshot }: { readonly snapshot: GoAgentMissionSnapshot }) {
  const { integration } = snapshot.mission;
  if (integration.status === "not_started") return null;
  return (
    <section className="flex flex-col gap-1 rounded-md border p-3 text-sm">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">Integration</h3>
        <StateBadge state={integration.status} />
      </div>
      {integration.appliedTasks.length > 0 ? (
        <span className="text-xs">Applied: {integration.appliedTasks.join(" → ")}</span>
      ) : null}
      {integration.headSha === null ? null : (
        <code className="text-xs">integrated at {integration.headSha.slice(0, 8)}</code>
      )}
      {integration.conflictFiles.length > 0 ? (
        <span className="text-xs text-destructive-foreground">
          Conflicts: {integration.conflictFiles.join(", ")}
        </span>
      ) : null}
      {integration.failure === null ? null : <span className="text-xs">{integration.failure}</span>}
      {integration.worktreePath === null ? null : (
        <code className="text-xs text-muted-foreground">{integration.worktreePath}</code>
      )}
    </section>
  );
}

const splitList = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const EMPTY_CONTRACT: GoAgentContractSpec = {
  method: "GET",
  path: "/api/",
  request: "",
  response: "",
  notes: "",
};

function PlanEditor({
  environmentId,
  snapshot,
  state,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: GoAgentMissionSnapshot;
  readonly state: GoAgentProjectState | null;
}) {
  const { mission } = snapshot;
  const [plan, setPlan] = useState<GoAgentPlan>(mission.plan);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const update = useAtomCommand(goagent.updatePlan, { label: "GoAgent update plan" });
  const edit = (next: GoAgentPlan) => {
    setPlan(next);
    setDirty(true);
  };
  const editTask = (index: number, patch: Partial<GoAgentPlanTask>) =>
    edit({
      ...plan,
      tasks: plan.tasks.map((task, i) => (i === index ? { ...task, ...patch } : task)),
    });
  const approved = state?.verificationCommands ?? [];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium uppercase text-muted-foreground">
          Plan v{mission.planVersion}
        </h3>
        {dirty ? (
          <>
            <Button
              size="compact"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                const result = await update({
                  environmentId,
                  input: { missionId: mission.missionId, planVersion: mission.planVersion, plan },
                });
                setSaving(false);
                if (result._tag === "Success") setDirty(false);
              }}
            >
              Save plan
            </Button>
            <Button
              size="compact"
              variant="ghost-muted"
              onClick={() => {
                setPlan(mission.plan);
                setDirty(false);
              }}
            >
              Discard
            </Button>
          </>
        ) : null}
      </div>
      <label className="flex flex-col gap-1 text-xs">
        Title
        <Input value={plan.title} onChange={(e) => edit({ ...plan, title: e.target.value })} />
      </label>
      {plan.tasks.map((task, index) => (
        <div key={task.key} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex items-center gap-2 text-sm">
            <code>{task.key}</code>
            <span className="text-muted-foreground">({task.role})</span>
            <label className="ml-auto flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={task.proposesContract}
                onChange={(e) => editTask(index, { proposesContract: e.target.checked })}
              />
              proposes the API contract
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs">
            Title
            <Input
              value={task.title}
              onChange={(e) => editTask(index, { title: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Brief for the agent
            <Textarea
              size="sm"
              value={task.brief}
              onChange={(e) => editTask(index, { brief: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Owns paths (comma separated globs)
            <Input
              value={task.ownsPaths.join(", ")}
              onChange={(e) => editTask(index, { ownsPaths: splitList(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Waits for (task keys, or "contract")
            <Input
              value={task.dependsOn.join(", ")}
              onChange={(e) => editTask(index, { dependsOn: splitList(e.target.value) })}
            />
          </label>
        </div>
      ))}
      <div className="flex flex-col gap-2 rounded-md border p-3 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={plan.contract !== null}
            onChange={(e) => edit({ ...plan, contract: e.target.checked ? EMPTY_CONTRACT : null })}
          />
          Fix the API contract in the plan (otherwise the proposing agent designs it)
        </label>
        {plan.contract === null ? null : (
          <div className="grid grid-cols-[6rem_1fr] items-center gap-2">
            <span>Method</span>
            <select
              className="rounded border bg-background px-2 py-1"
              value={plan.contract.method}
              onChange={(e) =>
                edit({
                  ...plan,
                  contract: {
                    ...plan.contract!,
                    method: e.target.value as GoAgentContractSpec["method"],
                  },
                })
              }
            >
              {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((method) => (
                <option key={method}>{method}</option>
              ))}
            </select>
            {(["path", "request", "response", "notes"] as const).map((field) => (
              <ContractField
                key={field}
                field={field}
                value={plan.contract![field]}
                onChange={(value) =>
                  edit({ ...plan, contract: { ...plan.contract!, [field]: value } })
                }
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Verification commands</span>
        {approved.length === 0 ? (
          <span className="text-muted-foreground">
            No approved commands yet. Approve them in the Verify tab; nothing runs until you do.
          </span>
        ) : (
          approved.map((command) => (
            <label key={command.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={plan.verificationCommandIds.includes(command.id)}
                onChange={(e) =>
                  edit({
                    ...plan,
                    verificationCommandIds: e.target.checked
                      ? [...plan.verificationCommandIds, command.id]
                      : plan.verificationCommandIds.filter((id) => id !== command.id),
                  })
                }
              />
              <code>{command.argv.join(" ")}</code>
            </label>
          ))
        )}
      </div>
    </section>
  );
}

function ContractField({
  field,
  value,
  onChange,
}: {
  readonly field: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <>
      <span className="capitalize">{field}</span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}
