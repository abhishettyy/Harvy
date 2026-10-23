import type { EnvironmentId, GoAgentMissionSnapshot } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Badge } from "../ui/badge";
import { StateBadge } from "./GoAgentStateBadge";
import { agentActivity, type AgentActivity } from "./goagentLayout";

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** One window per agent: what it decided, and the Jev coordination decisions about it. */
export function AgentDecisionsPanel({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: GoAgentMissionSnapshot;
}) {
  const agents = agentActivity(snapshot);
  if (agents.length === 0)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Agents appear here once the mission starts.
      </p>
    );
  return (
    <div className="grid h-full gap-3 overflow-y-auto p-4 md:grid-cols-2 xl:grid-cols-3">
      {agents.map((agent) => (
        <AgentWindow key={agent.taskKey} environmentId={environmentId} agent={agent} />
      ))}
    </div>
  );
}

function AgentWindow({
  environmentId,
  agent,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: AgentActivity;
}) {
  return (
    <section className="flex min-h-64 flex-col gap-3 overflow-hidden rounded-md border bg-card p-3 text-sm">
      <header className="flex items-center gap-2">
        <span className="font-medium">{agent.title}</span>
        <code className="text-xs text-muted-foreground">{agent.taskKey}</code>
        <StateBadge state={agent.state} />
        {agent.threadId === null ? null : (
          <Link
            className="ml-auto text-xs underline"
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: agent.threadId }}
          >
            Open thread
          </Link>
        )}
      </header>
      {agent.coupling.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Knowledge graph: {agent.coupling.join(" · ")}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <Section
          title="Decided by the agent"
          empty="No decisions recorded yet."
          count={agent.recorded.length}
        >
          {agent.recorded.map((entry) => (
            <li key={entry.eventId} className="flex flex-col">
              <span>{entry.decision}</span>
              <span className="text-xs text-muted-foreground">Why: {entry.reason}</span>
            </li>
          ))}
        </Section>
        <Section
          title="Coordination decided by Jev"
          empty="No coordination decisions yet."
          count={agent.coordination.length}
        >
          {agent.coordination.map((decision) => (
            <li key={decision.decisionId} className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-1">
                <code className="text-xs">{decision.key}</code>
                {decision.targetTaskKey === undefined ? null : (
                  <span className="text-xs">
                    {decision.taskKey ?? "?"} → {decision.targetTaskKey}
                  </span>
                )}
                <StateBadge state={decision.answer} />
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
                    ? `Jev${decision.confidence === null ? "" : ` ${percent(decision.confidence)}`}`
                    : decision.source === "fallback"
                      ? "fallback rule"
                      : "your override"}
                </Badge>
              </span>
              {decision.fallbackReason === null ? null : (
                <span className="text-xs text-muted-foreground">{decision.fallbackReason}</span>
              )}
            </li>
          ))}
        </Section>
        <Section
          title="Handoffs"
          empty="No work switched to or from this agent."
          count={agent.handoffsIn.length + agent.handoffsOut.length}
        >
          {agent.handoffsIn.map((handoff) => (
            <li key={handoff.eventId} className="text-xs">
              ← from {handoff.from}: {handoff.summary}
            </li>
          ))}
          {agent.handoffsOut.map((handoff) => (
            <li key={handoff.eventId} className="text-xs">
              → to {handoff.to}: {handoff.summary}
            </li>
          ))}
        </Section>
        <Section
          title="Graph lookups"
          empty="No knowledge-graph lookups."
          count={agent.graphLookups.length}
        >
          {agent.graphLookups.map((lookup) => (
            <li key={lookup.eventId} className="text-xs">
              {lookup.summary}
            </li>
          ))}
        </Section>
      </div>
    </section>
  );
}

function Section({
  title,
  empty,
  count,
  children,
}: {
  readonly title: string;
  readonly empty: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-medium uppercase text-muted-foreground">{title}</h4>
      {count > 0 ? (
        <ul className="flex flex-col gap-1.5">{children}</ul>
      ) : (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}
