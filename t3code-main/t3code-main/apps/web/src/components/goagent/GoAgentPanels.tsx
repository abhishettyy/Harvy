import type {
  EnvironmentId,
  GoAgentDecision,
  GoAgentEvent,
  GoAgentMissionSnapshot,
  GoAgentProjectState,
  GoAgentVerificationCommand,
} from "@t3tools/contracts";
import { useState } from "react";

import { goagent } from "../../state/goagent";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { StateBadge } from "./GoAgentStateBadge";

const percent = (value: number) => `${Math.round(value * 100)}%`;

export function DecisionsPanel({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: GoAgentMissionSnapshot;
}) {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      {snapshot.decisions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No decisions yet.</p>
      ) : (
        snapshot.decisions.map((decision) => (
          <DecisionCard
            key={decision.decisionId}
            environmentId={environmentId}
            decision={decision}
          />
        ))
      )}
    </div>
  );
}

function DecisionCard({
  environmentId,
  decision,
}: {
  readonly environmentId: EnvironmentId;
  readonly decision: GoAgentDecision;
}) {
  const override = useAtomCommand(goagent.overrideDecision, { label: "GoAgent override decision" });
  const [busy, setBusy] = useState(false);
  const probabilities = Object.entries(decision.probabilities).toSorted((a, b) => b[1] - a[1]);
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="flex items-center gap-2">
        <code className="text-xs">{decision.key}</code>
        <Badge
          size="sm"
          variant={
            decision.source === "jev"
              ? "info"
              : decision.source === "fallback"
                ? "warning"
                : "secondary"
          }
        >
          {decision.source === "jev"
            ? `Jev · ${decision.model ?? "model"}`
            : decision.source === "fallback"
              ? "fallback rule"
              : "overridden by you"}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(decision.createdAt).toLocaleString()}
        </span>
      </div>
      <p className="text-sm">{decision.question}</p>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Answer</span>
        <StateBadge state={decision.answer} />
        {decision.confidence === null || decision.source !== "jev" ? null : (
          <span className="text-xs">confidence {percent(decision.confidence)}</span>
        )}
      </div>
      {probabilities.length > 0 ? (
        <div className="flex flex-col gap-1">
          {decision.source === "jev" ? null : (
            <span className="text-xs text-muted-foreground">
              Jev{decision.model === null ? "" : ` (${decision.model})`} said, not used
              {decision.confidence === null ? "" : ` · confidence ${percent(decision.confidence)}`}
            </span>
          )}
          {probabilities.map(([label, value]) => (
            <div key={label} className="flex items-center gap-2 text-xs">
              <span className="w-28 truncate">{label}</span>
              <div className="h-1.5 flex-1 rounded bg-muted">
                <div className="h-1.5 rounded bg-info" style={{ width: percent(value) }} />
              </div>
              <span className="w-10 text-right">{percent(value)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {decision.fallbackReason === null ? null : (
        <p className="text-xs text-muted-foreground">Why the fallback: {decision.fallbackReason}</p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground">Override:</span>
        {decision.criteria
          .filter((label) => label !== decision.answer)
          .map((label) => (
            <Button
              key={label}
              size="compact"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await override({
                  environmentId,
                  input: { decisionId: decision.decisionId, answer: label },
                });
                setBusy(false);
              }}
            >
              {label}
            </Button>
          ))}
      </div>
    </div>
  );
}

/** The selected event, every event it descends from, and the events it directly caused. */
function causalChain(
  selected: GoAgentEvent | null,
  byId: ReadonlyMap<string, GoAgentEvent>,
  events: ReadonlyArray<GoAgentEvent>,
): ReadonlySet<string> {
  if (selected === null) return new Set();
  const ids = new Set<string>([selected.eventId]);
  let cursor = selected.causedBy === null ? undefined : byId.get(selected.causedBy);
  while (cursor !== undefined && !ids.has(cursor.eventId)) {
    ids.add(cursor.eventId);
    cursor = cursor.causedBy === null ? undefined : byId.get(cursor.causedBy);
  }
  for (const event of events) if (event.causedBy === selected.eventId) ids.add(event.eventId);
  return ids;
}

export function AuditTimeline({ snapshot }: { readonly snapshot: GoAgentMissionSnapshot }) {
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<GoAgentEvent | null>(null);
  const actors = ["all", ...new Set(snapshot.events.map((event) => event.actor))];
  const events =
    filter === "all" ? snapshot.events : snapshot.events.filter((event) => event.actor === filter);
  const byId = new Map(snapshot.events.map((event) => [event.eventId, event]));
  const related = causalChain(selected, byId, snapshot.events);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap gap-1 border-b px-4 py-2">
          {actors.map((actor) => (
            <Button
              key={actor}
              size="compact"
              variant={actor === filter ? "secondary" : "ghost-muted"}
              onClick={() => setFilter(actor)}
            >
              {actor}
            </Button>
          ))}
        </div>
        <ol className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
          {events.map((event) => (
            <li key={event.eventId}>
              <button
                type="button"
                className={`flex w-full items-baseline gap-3 rounded px-2 py-1 text-left text-sm hover:bg-accent ${
                  related.has(event.eventId) ? "bg-accent" : ""
                }`}
                onClick={() => setSelected(event)}
              >
                <span className="w-8 shrink-0 text-right text-xs text-muted-foreground">
                  #{event.sequence}
                </span>
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {new Date(event.occurredAt).toLocaleTimeString()}
                </span>
                <code className="w-40 shrink-0 truncate text-xs">{event.type}</code>
                <span className="w-24 shrink-0 truncate text-xs">{event.actor}</span>
                <span className="min-w-0 truncate">{event.summary}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <aside className="flex w-96 shrink-0 flex-col gap-2 overflow-y-auto border-l p-4 text-sm">
        {selected === null ? (
          <p className="text-muted-foreground">
            Select an event to see its payload and causal chain.
          </p>
        ) : (
          <>
            <code className="text-xs">{selected.type}</code>
            <p>{selected.summary}</p>
            <span className="text-xs text-muted-foreground">
              #{selected.sequence} · {selected.actor} ·{" "}
              {new Date(selected.occurredAt).toLocaleString()}
            </span>
            {selected.causedBy === null ? null : (
              <span className="text-xs">
                Caused by: {byId.get(selected.causedBy)?.summary ?? selected.causedBy}
              </span>
            )}
            <pre className="overflow-x-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
              {JSON.stringify(selected.payload, null, 2)}
            </pre>
          </>
        )}
      </aside>
    </div>
  );
}

export function VerificationPanel({
  environmentId,
  snapshot,
  state,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: GoAgentMissionSnapshot;
  readonly state: GoAgentProjectState | null;
}) {
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4">
      <ApprovedCommands
        environmentId={environmentId}
        projectId={snapshot.mission.projectId}
        state={state}
      />
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase text-muted-foreground">Runs</h3>
        {snapshot.verificationRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {snapshot.mission.integration.status === "completed"
              ? "Run verification from the Mission tab."
              : "Verification runs on the integrated worktree, after integration."}
          </p>
        ) : (
          snapshot.verificationRuns.toReversed().map((run) => (
            <div key={run.runId} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs">{run.argv.join(" ")}</code>
                <StateBadge state={run.status} />
                <span className="text-xs">
                  exit code: {run.exitCode === null ? "none" : run.exitCode}
                </span>
                {run.timedOut ? <span className="text-xs">timed out</span> : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {run.finishedAt === null
                    ? "running…"
                    : `${((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)}s`}
                </span>
              </div>
              {run.testSummary === null ? (
                <span className="text-xs text-muted-foreground">
                  No test summary was printed; the exit code is the result.
                </span>
              ) : (
                <span className="text-xs">
                  Tests: {run.testSummary.passed} passed, {run.testSummary.failed} failed,{" "}
                  {run.testSummary.skipped} skipped of {run.testSummary.total}
                </span>
              )}
              {run.outputExcerpt.length > 0 ? (
                <details>
                  <summary className="text-xs">
                    Output (last {run.outputExcerpt.length} characters)
                  </summary>
                  <pre className="mt-1 max-h-96 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                    {run.outputExcerpt}
                  </pre>
                </details>
              ) : null}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function ApprovedCommands({
  environmentId,
  projectId,
  state,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: GoAgentMissionSnapshot["mission"]["projectId"];
  readonly state: GoAgentProjectState | null;
}) {
  const save = useAtomCommand(goagent.setVerificationCommands, {
    label: "GoAgent approve commands",
  });
  const [busy, setBusy] = useState(false);
  if (state === null) return <Spinner />;
  const approved = state.verificationCommands;
  const pending = state.suggestedVerificationCommands.filter(
    (s) => !approved.some((a) => a.id === s.id),
  );
  const write = async (commands: ReadonlyArray<GoAgentVerificationCommand>) => {
    setBusy(true);
    await save({ environmentId, input: { projectId, commands } });
    setBusy(false);
  };
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">Approved commands</h3>
      <p className="text-xs text-muted-foreground">
        GoAgent only runs commands you approve here, in order, in the integration worktree. They run
        with your user account, so approve only commands you would run yourself.
      </p>
      {approved.length === 0 ? <p className="text-sm">None approved.</p> : null}
      {approved.map((command) => (
        <div key={command.id} className="flex items-center gap-2 text-sm">
          <code className="text-xs">{command.argv.join(" ")}</code>
          <span className="text-xs text-muted-foreground">
            timeout {Math.round(command.timeoutMs / 1000)}s
          </span>
          <Button
            size="compact"
            variant="ghost-destructive"
            className="ml-auto"
            disabled={busy}
            onClick={() => void write(approved.filter((c) => c.id !== command.id))}
          >
            Remove
          </Button>
        </div>
      ))}
      {pending.length > 0 ? (
        <>
          <span className="text-xs font-medium">Suggested from package.json</span>
          {pending.map((command) => (
            <div key={command.id} className="flex items-center gap-2 text-sm">
              <code className="text-xs">{command.argv.join(" ")}</code>
              <Button
                size="compact"
                variant="outline"
                className="ml-auto"
                disabled={busy}
                onClick={() => void write([...approved, command])}
              >
                Approve
              </Button>
            </div>
          ))}
        </>
      ) : null}
    </section>
  );
}
