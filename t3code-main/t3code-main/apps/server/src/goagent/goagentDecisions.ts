import type { GoAgentContractSpec, GoAgentPlan } from "@t3tools/contracts";

import type { DecisionRequest } from "./GoAgentDecisionService.ts";

// Paths that mark a change as client- or server-side when the plan does not say so explicitly.
const CLIENT_HINTS = [
  "web/",
  "client/",
  "frontend/",
  "app/",
  "src/components",
  "src/pages",
  ".tsx",
];
const SERVER_HINTS = ["server/", "api/", "backend/", "routes/", "db"];

const touches = (paths: ReadonlyArray<string>, hints: ReadonlyArray<string>) =>
  paths.some((path) => hints.some((hint) => path.toLowerCase().includes(hint)));

export function routeDecision(input: {
  readonly request: string;
  readonly plan: GoAgentPlan;
  readonly touchedFiles: ReadonlyArray<string>;
}): DecisionRequest {
  const planPaths = input.plan.tasks.flatMap((task) => task.ownsPaths);
  const both =
    touches([...planPaths, ...input.touchedFiles], CLIENT_HINTS) &&
    touches([...planPaths, ...input.touchedFiles], SERVER_HINTS);
  return {
    key: "mission.route",
    kind: "classify",
    question:
      "Should this software change be done by one coding agent, or split across parallel agents that each own a separate part of the codebase?",
    criteria: [
      {
        label: "single_agent",
        description:
          "Small or tightly coupled change; splitting would cost more coordination than it saves.",
      },
      {
        label: "parallel",
        description:
          "Independent parts (for example server API and client UI) that can be built at the same time against an agreed contract.",
      },
    ],
    input: {
      request: input.request.slice(0, 2_000),
      plannedTasks: input.plan.tasks.map((task) => `${task.key}: ${task.title}`).join("\n"),
      touchedFiles: input.touchedFiles.slice(0, 40).join("\n"),
    },
    threshold: 0.6,
    fallback: {
      answer: both && input.plan.tasks.length > 1 ? "parallel" : "single_agent",
      reason: both
        ? "rule: the plan touches both client and server paths"
        : "rule: the plan does not touch both client and server paths",
    },
  };
}

export function riskDecision(input: {
  readonly plan: GoAgentPlan;
  readonly hubFiles: ReadonlyArray<string>;
}): DecisionRequest {
  return {
    key: "mission.risk",
    kind: "rate",
    question:
      "How risky is this planned change for the existing codebase (breaking behaviour, security, data)?",
    criteria: [
      { label: "low", description: "Additive change in isolated code." },
      { label: "medium", description: "Changes shared code or an API surface." },
      {
        label: "high",
        description: "Touches authentication, data integrity, or widely shared core modules.",
      },
    ],
    input: {
      plan: input.plan.tasks.map((task) => `${task.key} (${task.role}): ${task.brief}`).join("\n"),
      constraints: input.plan.constraints.join("\n"),
      mostConnectedFilesTouched: input.hubFiles.join("\n"),
    },
    threshold: 0.5,
    fallback: { answer: "medium", reason: "rule: default risk when Jev has no confident answer" },
  };
}

export function contractMatchDecision(input: {
  readonly contract: GoAgentContractSpec;
  readonly ackNote: string;
}): DecisionRequest {
  return {
    key: "contract.match",
    kind: "probability",
    question:
      "Does the consumer's acknowledgment show it will use the API exactly as the contract specifies?",
    criteria: [
      { label: "false", description: "The acknowledgment contradicts or misreads the contract." },
      { label: "true", description: "The acknowledgment matches the contract." },
    ],
    input: {
      contract: `${input.contract.method} ${input.contract.path}\nrequest: ${input.contract.request}\nresponse: ${input.contract.response}`,
      acknowledgment: input.ackNote.slice(0, 2_000),
    },
    threshold: 0.7,
    fallback: { answer: "true", reason: "rule: a version-matched acknowledgment is accepted" },
  };
}

export function failureOwnerDecision(input: {
  readonly logExcerpt: string;
  readonly tasks: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly ownsPaths: ReadonlyArray<string>;
  }>;
}): DecisionRequest {
  const mentioned = input.tasks
    .map((task) => ({
      key: task.key,
      hits: task.ownsPaths.reduce((count, path) => {
        const stem = path.replace(/\*+.*$/, "").replace(/\/$/, "");
        return stem.length > 0 && input.logExcerpt.includes(stem) ? count + 1 : count;
      }, 0),
    }))
    .toSorted((a, b) => b.hits - a.hits);
  const best = mentioned[0];
  const clearWinner = best !== undefined && best.hits > 0 && best.hits > (mentioned[1]?.hits ?? 0);
  return {
    key: "failure.owner",
    kind: "classify",
    question: "Which task's code most likely caused this verification failure?",
    criteria: [
      ...input.tasks.map((task) => ({
        label: task.key,
        description: `${task.title} (owns ${task.ownsPaths.join(", ") || "unspecified paths"})`,
      })),
      { label: "unknown", description: "The log does not point at any one task." },
    ],
    input: { log: input.logExcerpt.slice(-4_000) },
    threshold: 0.55,
    fallback: {
      answer: clearWinner ? best.key : "unknown",
      reason: clearWinner
        ? "rule: the failing log mentions this task's paths most"
        : "rule: the failing log does not single out one task",
    },
  };
}

/**
 * Micro-decision when an agent finishes: should GoAgent switch to another agent the knowledge
 * graph links to the finished work, and tell it about the change now?
 */
export function handoffNotifyDecision(input: {
  readonly fromTask: string;
  readonly toTask: { readonly key: string; readonly title: string; readonly state: string };
  readonly changedFiles: ReadonlyArray<string>;
  readonly links: ReadonlyArray<string>;
}): DecisionRequest {
  return {
    key: "handoff.notify",
    kind: "classify",
    question: `The ${input.fromTask} agent just finished. Should the ${input.toTask.key} agent be interrupted now with a summary of the changes its code is linked to?`,
    criteria: [
      {
        label: "notify",
        description:
          "The changes affect names, data shapes or behaviour the other agent's code relies on, so it should check its work now.",
      },
      {
        label: "skip",
        description:
          "The link is incidental (shared helper, unchanged interface); interrupting would waste the other agent's time.",
      },
    ],
    input: {
      finishedAgent: input.fromTask,
      otherAgent: `${input.toTask.key}: ${input.toTask.title} (${input.toTask.state})`,
      changedFiles: input.changedFiles.slice(0, 30).join("\n"),
      graphLinks: input.links.join("\n"),
    },
    threshold: 0.6,
    fallback: {
      answer: input.links.length > 0 ? "notify" : "skip",
      reason:
        input.links.length > 0
          ? "rule: the knowledge graph links the changed files to this agent's code"
          : "rule: no graph link to this agent's code",
    },
  };
}

/**
 * Micro-decision when an agent calls goagent_handoff: which other agent should receive its note?
 * The fallback follows the files the note names, then the strongest graph coupling.
 */
export function handoffRouteDecision(input: {
  readonly fromTask: string;
  readonly note: string;
  readonly files: ReadonlyArray<string>;
  readonly candidates: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly ownsPaths: ReadonlyArray<string>;
  }>;
  readonly fileOwner: string | null;
  readonly strongestCoupling: string | null;
}): DecisionRequest {
  const fallbackAnswer = input.fileOwner ?? input.strongestCoupling ?? "none";
  return {
    key: "handoff.route",
    kind: "classify",
    question: `The ${input.fromTask} agent wants to hand something to another agent. Which agent should receive it?`,
    criteria: [
      ...input.candidates.map((c) => ({
        label: c.key,
        description: `${c.title} (owns ${c.ownsPaths.join(", ")})`,
      })),
      { label: "none", description: "No other agent needs this; keep it with the sender." },
    ],
    input: {
      from: input.fromTask,
      note: input.note.slice(0, 1_500),
      files: input.files.slice(0, 20).join("\n"),
    },
    threshold: 0.55,
    fallback: {
      answer: fallbackAnswer,
      reason:
        input.fileOwner !== null
          ? "rule: the note names files this agent owns"
          : input.strongestCoupling !== null
            ? "rule: the agent most linked to the sender in the knowledge graph"
            : "rule: no owner or graph link found",
    },
  };
}
