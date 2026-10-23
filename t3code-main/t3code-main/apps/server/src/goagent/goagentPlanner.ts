import {
  GOAGENT_CONTRACT_DEPENDENCY,
  type GoAgentContract,
  type GoAgentGraphEdge,
  type GoAgentGraphNode,
  type GoAgentPlan,
  type GoAgentPlanTask,
  type GoAgentProjectDecision,
  type GoAgentTaskCoupling,
  type GoAgentTestSummary,
  type GoAgentVerificationCommand,
} from "@t3tools/contracts";

export type Area = "client" | "server" | "test" | "other";

const CLIENT_SEGMENTS = new Set([
  "web",
  "client",
  "frontend",
  "ui",
  "app",
  "components",
  "pages",
  "public",
]);
const SERVER_SEGMENTS = new Set([
  "server",
  "api",
  "backend",
  "routes",
  "db",
  "services",
  "lib-server",
]);
const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "e2e"]);

/** The outermost directory decides: `web/src/api/x.ts` is client code that calls an API. */
const sideOfSegments = (path: string): "client" | "server" | null => {
  for (const segment of path.toLowerCase().split("/").slice(0, -1)) {
    if (SERVER_SEGMENTS.has(segment)) return "server";
    if (CLIENT_SEGMENTS.has(segment)) return "client";
  }
  return null;
};

export function classifyArea(path: string): Area {
  const segments = path.toLowerCase().split("/");
  if (segments.some((s) => TEST_SEGMENTS.has(s)) || /\.(test|spec)\.[a-z]+$/.test(path))
    return "test";
  const side = sideOfSegments(path);
  if (side !== null) return side;
  if (/\.(tsx|jsx|vue|svelte|css)$/.test(path)) return "client";
  return "other";
}

/** The directory prefix that owns a file: two segments under `src`/`packages`/`apps`, else one. */
const ownerDir = (path: string) => {
  const segments = path.split("/");
  if (segments.length <= 1) return null;
  const depth =
    ["src", "packages", "apps", "tests", "test"].includes(segments[0]!) && segments.length > 2
      ? 2
      : 1;
  return segments.slice(0, depth).join("/");
};

const globsFor = (files: ReadonlyArray<string>) =>
  [
    ...new Set(
      files.flatMap((file) => {
        const dir = ownerDir(file);
        return dir === null ? [] : [`${dir}/**`];
      }),
    ),
  ].toSorted();

/**
 * Deterministic first plan from the repository layout. The user edits it before approval and the
 * agents do the design work; GoAgent only decides who owns which part of the tree.
 */
export function buildPlan(input: {
  readonly request: string;
  readonly files: ReadonlyArray<string>;
  readonly verificationCommandIds: ReadonlyArray<string>;
}): GoAgentPlan {
  const byArea = {
    client: [] as string[],
    server: [] as string[],
    test: [] as string[],
    other: [] as string[],
  };
  for (const file of input.files) byArea[classifyArea(file)].push(file);
  // A test belongs to the side its path names, e.g. tests/server/** to the backend.
  const testsFor = (side: "client" | "server") =>
    byArea.test.filter((file) => sideOfSegments(file) === side);
  const title = input.request.length > 80 ? `${input.request.slice(0, 77)}…` : input.request;
  const constraints = [
    "Follow the existing architecture and decisions recorded in the repository (DECISIONS.md, AGENTS.md, WHY: comments).",
    "Only edit files inside the paths your task owns unless coordination requires otherwise; say so in your final message.",
    "Commit your work in your worktree with a clear message when you are done.",
  ];
  if (byArea.client.length > 0 && byArea.server.length > 0 && byArea.test.length > 0) {
    // Three agents: tests move to their own agent, which writes them against the contract while
    // the backend and frontend implement it.
    return {
      title,
      constraints,
      contract: null,
      tasks: [
        {
          key: "backend",
          title: "Server side",
          role: "backend",
          brief: `Implement the server side of: ${input.request}`,
          ownsPaths: globsFor(byArea.server),
          dependsOn: [],
          proposesContract: true,
        },
        {
          key: "frontend",
          title: "Client side",
          role: "frontend",
          brief: `Implement the client side of: ${input.request}`,
          ownsPaths: globsFor(byArea.client),
          dependsOn: [GOAGENT_CONTRACT_DEPENDENCY],
          proposesContract: false,
        },
        {
          key: "tests",
          title: "Tests",
          role: "tests",
          brief: `Write and update the automated tests for: ${input.request}. Test the server through the agreed API contract and the client code that calls it. Your worktree does not contain the other agents' code, so new tests may fail there; GoAgent runs them on the integrated code.`,
          ownsPaths: globsFor(byArea.test),
          dependsOn: [GOAGENT_CONTRACT_DEPENDENCY],
          proposesContract: false,
        },
      ],
      verificationCommandIds: [...input.verificationCommandIds],
    };
  }
  if (byArea.client.length > 0 && byArea.server.length > 0) {
    return {
      title,
      constraints,
      contract: null,
      tasks: [
        {
          key: "backend",
          title: "Server side",
          role: "backend",
          brief: `Implement the server side of: ${input.request}`,
          ownsPaths: globsFor([...byArea.server, ...testsFor("server")]),
          dependsOn: [],
          proposesContract: true,
        },
        {
          key: "frontend",
          title: "Client side",
          role: "frontend",
          brief: `Implement the client side of: ${input.request}`,
          ownsPaths: globsFor([...byArea.client, ...testsFor("client")]),
          dependsOn: [GOAGENT_CONTRACT_DEPENDENCY],
          proposesContract: false,
        },
      ],
      verificationCommandIds: [...input.verificationCommandIds],
    };
  }
  return collapseToSingle(
    {
      title,
      constraints,
      contract: null,
      tasks: [],
      verificationCommandIds: [...input.verificationCommandIds],
    },
    input.request,
    globsFor(input.files),
  );
}

const ownedPrefix = (glob: string) => glob.replace(/\*+$/, "");

/** The task whose owned paths contain `file`, if any (longest prefix wins). */
export function ownerOfPath(
  tasks: ReadonlyArray<Pick<GoAgentPlanTask, "key" | "ownsPaths">>,
  file: string,
): string | null {
  let best: { readonly key: string; readonly length: number } | null = null;
  for (const task of tasks)
    for (const glob of task.ownsPaths) {
      const prefix = ownedPrefix(glob);
      if (file.startsWith(prefix) && (best === null || prefix.length > best.length))
        best = { key: task.key, length: prefix.length };
    }
  return best?.key ?? null;
}

const COUPLING_EXAMPLES = 4;

/**
 * Graph edges that cross from one task's files to another's, per ordered task pair. Symbols count
 * for the file that contains them. `from` uses `to` (for example tests import server code).
 */
export function taskCoupling(
  tasks: ReadonlyArray<Pick<GoAgentPlanTask, "key" | "ownsPaths">>,
  graph: {
    readonly nodes: ReadonlyArray<GoAgentGraphNode>;
    readonly edges: ReadonlyArray<GoAgentGraphEdge>;
  },
): ReadonlyArray<GoAgentTaskCoupling> {
  const fileOf = new Map(graph.nodes.map((node) => [node.id, node.sourceFile]));
  const pairs = new Map<string, { edgeCount: number; examples: Set<string> }>();
  for (const edge of graph.edges) {
    if (edge.relation === "contains") continue;
    const sourceFile = fileOf.get(edge.source);
    const targetFile = fileOf.get(edge.target);
    if (sourceFile == null || targetFile == null || sourceFile === targetFile) continue;
    const from = ownerOfPath(tasks, sourceFile);
    const to = ownerOfPath(tasks, targetFile);
    if (from === null || to === null || from === to) continue;
    // Task keys never contain ":".
    const key = `${from}:${to}`;
    const entry = pairs.get(key) ?? { edgeCount: 0, examples: new Set<string>() };
    entry.edgeCount += 1;
    if (entry.examples.size < COUPLING_EXAMPLES)
      entry.examples.add(`${sourceFile} -> ${targetFile} (${edge.relation})`);
    pairs.set(key, entry);
  }
  return [...pairs.entries()]
    .map(([key, entry]) => {
      const [from, to] = key.split(":") as [string, string];
      return {
        from: from as GoAgentTaskCoupling["from"],
        to: to as GoAgentTaskCoupling["to"],
        edgeCount: entry.edgeCount,
        examples: [...entry.examples],
      };
    })
    .toSorted((a, b) => b.edgeCount - a.edgeCount || a.from.localeCompare(b.from));
}

const MAX_IMPACT_HOPS = 3;

/**
 * Other tasks whose code uses `changedFiles` according to the graph: one of their files imports
 * or calls a changed file, directly or through up to three files that the finishing task owns or
 * nobody owns (e.g. `tests/server/helpers.ts -> server/app.ts -> server/routes/profile.ts`). Only
 * consumers are told about a change, so handoffs cannot ping-pong: nothing imports the tests.
 */
export function impactedTasks(input: {
  readonly tasks: ReadonlyArray<Pick<GoAgentPlanTask, "key" | "ownsPaths">>;
  readonly fromTask: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly graph: {
    readonly nodes: ReadonlyArray<GoAgentGraphNode>;
    readonly edges: ReadonlyArray<GoAgentGraphEdge>;
  };
}): ReadonlyArray<{ readonly taskKey: string; readonly links: ReadonlyArray<string> }> {
  const fileOf = new Map(input.graph.nodes.map((node) => [node.id, node.sourceFile]));
  // File-level "is used by" adjacency.
  const usersOf = new Map<string, Set<string>>();
  for (const edge of input.graph.edges) {
    if (edge.relation === "contains") continue;
    const user = fileOf.get(edge.source);
    const used = fileOf.get(edge.target);
    if (user == null || used == null || user === used) continue;
    const users = usersOf.get(used) ?? new Set<string>();
    users.add(user);
    usersOf.set(used, users);
  }
  const links = new Map<string, Set<string>>();
  for (const changedFile of input.changedFiles) {
    const visited = new Set([changedFile]);
    let frontier: ReadonlyArray<ReadonlyArray<string>> = [[changedFile]];
    for (let hop = 0; hop < MAX_IMPACT_HOPS && frontier.length > 0; hop++) {
      const next: Array<ReadonlyArray<string>> = [];
      for (const path of frontier)
        for (const user of usersOf.get(path[0]!) ?? []) {
          if (visited.has(user)) continue;
          visited.add(user);
          const chain = [user, ...path];
          const owner = ownerOfPath(input.tasks, user);
          if (owner !== null && owner !== input.fromTask) {
            const set = links.get(owner) ?? new Set<string>();
            if (set.size < COUPLING_EXAMPLES) set.add(chain.join(" -> "));
            links.set(owner, set);
          } else {
            next.push(chain);
          }
        }
      frontier = next;
    }
  }
  return [...links.entries()].map(([taskKey, set]) => ({ taskKey, links: [...set] }));
}

/** What an agent is told when GoAgent switches another agent's finished work to it. */
export function renderHandoffMessage(input: {
  readonly fromTask: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly links: ReadonlyArray<string>;
  readonly note: string | null;
  readonly contract: Pick<GoAgentContract, "version" | "spec"> | null;
}): string {
  return [
    input.note === null
      ? `The ${input.fromTask} agent finished its part. GoAgent's knowledge graph links its changes to code you own:`
      : `The ${input.fromTask} agent sent you this through GoAgent: ${input.note}`,
    ...input.links.map((link) => `- ${link}`),
    input.changedFiles.length === 0
      ? ""
      : `Files it changed: ${input.changedFiles.slice(0, 20).join(", ")}`,
    ...(input.contract === null ? [] : ["Current contract:", renderContract(input.contract)]),
    "Their code is not in your worktree. Check that your part matches (names, request and response shapes) and adjust your own files if needed, then commit. Reply briefly if nothing needs to change.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function collapseToSingle(
  plan: GoAgentPlan,
  request: string,
  ownsPaths?: ReadonlyArray<string>,
): GoAgentPlan {
  return {
    ...plan,
    contract: null,
    tasks: [
      {
        key: "implement",
        title: "Implement",
        role: "fullstack",
        brief: `Implement: ${request}`,
        ownsPaths: [...(ownsPaths ?? [...new Set(plan.tasks.flatMap((task) => task.ownsPaths))])],
        dependsOn: [],
        proposesContract: false,
      },
    ],
  };
}

const MAX_PARALLEL_TASKS = 3;

/** Returns human-readable problems; an empty list means the plan can run. */
export function validatePlan(
  plan: GoAgentPlan,
  approvedCommandIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const keys = plan.tasks.map((task) => task.key);
  if (plan.tasks.length === 0) problems.push("The plan has no tasks.");
  if (plan.tasks.length > MAX_PARALLEL_TASKS)
    problems.push(`At most ${MAX_PARALLEL_TASKS} tasks can run in one mission.`);
  if (new Set(keys).size !== keys.length) problems.push("Task keys must be unique.");
  const proposers = plan.tasks.filter((task) => task.proposesContract);
  if (proposers.length > 1) problems.push("Only one task can propose the API contract.");
  const needsContract = plan.tasks.some((task) =>
    task.dependsOn.includes(GOAGENT_CONTRACT_DEPENDENCY),
  );
  if (needsContract && proposers.length === 0 && plan.contract === null)
    problems.push(
      "A task waits for the contract, but no task proposes one and the plan sets none.",
    );
  for (const task of plan.tasks) {
    if (task.ownsPaths.length === 0) problems.push(`Task "${task.key}" owns no paths.`);
    for (const dependency of task.dependsOn) {
      if (dependency === GOAGENT_CONTRACT_DEPENDENCY) {
        if (task.proposesContract)
          problems.push(`Task "${task.key}" cannot wait for its own contract.`);
      } else if (!keys.includes(dependency)) {
        problems.push(`Task "${task.key}" depends on unknown task "${dependency}".`);
      } else if (dependency === task.key) {
        problems.push(`Task "${task.key}" depends on itself.`);
      }
    }
  }
  if (hasCycle(plan.tasks)) problems.push("Task dependencies form a cycle.");
  for (const id of plan.verificationCommandIds)
    if (!approvedCommandIds.includes(id))
      problems.push(`Verification command "${id}" is not approved.`);
  return problems;
}

function hasCycle(tasks: ReadonlyArray<GoAgentPlanTask>): boolean {
  const deps = new Map(
    tasks.map((task) => [
      task.key,
      task.dependsOn.filter((d) => d !== GOAGENT_CONTRACT_DEPENDENCY),
    ]),
  );
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): boolean => {
    if (state.get(key) === "done") return false;
    if (state.get(key) === "visiting") return true;
    state.set(key, "visiting");
    for (const next of deps.get(key) ?? []) if (deps.has(next) && visit(next)) return true;
    state.set(key, "done");
    return false;
  };
  return tasks.some((task) => visit(task.key));
}

/** Dependency order for integration: tasks with no task dependencies first, stable otherwise. */
export function integrationOrder(tasks: ReadonlyArray<GoAgentPlanTask>): ReadonlyArray<string> {
  const remaining = [...tasks];
  const ordered: Array<string> = [];
  // Contract proposers go first so dependents apply on top of the API they consume; tests go
  // last, on top of the code they exercise.
  const rank = (task: GoAgentPlanTask) =>
    task.proposesContract ? 0 : task.role === "tests" ? 2 : 1;
  remaining.sort((a, b) => rank(a) - rank(b));
  while (remaining.length > 0) {
    const index = remaining.findIndex((task) =>
      task.dependsOn.every((d) => d === GOAGENT_CONTRACT_DEPENDENCY || ordered.includes(d)),
    );
    const [next] = remaining.splice(index === -1 ? 0 : index, 1);
    ordered.push(next!.key);
  }
  return ordered;
}

/** Plain-text summary of a graph neighbourhood for an agent prompt; every line cites its source. */
export function renderGraphContext(
  nodes: ReadonlyArray<GoAgentGraphNode>,
  edges: ReadonlyArray<GoAgentGraphEdge>,
  maxLines: number,
): string {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const cite = (node: GoAgentGraphNode) =>
    node.sourceFile === null
      ? node.label
      : `${node.label} (${node.sourceFile}${node.sourceLocation ? `:${node.sourceLocation.replace(/^L/, "")}` : ""})`;
  const lines: Array<string> = [];
  for (const node of nodes) if (node.kind === "rationale") lines.push(`- rationale: ${cite(node)}`);
  for (const edge of edges) {
    if (edge.relation === "contains") continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const marker = edge.evidence === "verified_static" ? "" : ` [${edge.evidence}]`;
    lines.push(`- ${cite(source)} --${edge.relation}--> ${cite(target)}${marker}`);
  }
  const shown = lines.slice(0, maxLines);
  return lines.length > shown.length
    ? [...shown, `- … ${lines.length - shown.length} more`].join("\n")
    : shown.join("\n");
}

const renderContract = (contract: Pick<GoAgentContract, "version" | "spec">) =>
  [
    `Contract v${contract.version}: ${contract.spec.method} ${contract.spec.path}`,
    `Request: ${contract.spec.request || "(none)"}`,
    `Response: ${contract.spec.response || "(none)"}`,
    contract.spec.notes ? `Notes: ${contract.spec.notes}` : null,
  ]
    .filter((line) => line !== null)
    .join("\n");

export function renderTaskPrompt(input: {
  readonly request: string;
  readonly plan: GoAgentPlan;
  readonly task: GoAgentPlanTask;
  readonly graphContext: string;
  readonly contract: Pick<GoAgentContract, "version" | "spec"> | null;
  readonly packageManager?: string | null;
  readonly projectDecisions?: ReadonlyArray<Pick<GoAgentProjectDecision, "text" | "author">>;
}): string {
  const decisions = input.projectDecisions ?? [];
  const coupled = (input.plan.coupling ?? [])
    .filter((c) => c.from === input.task.key || c.to === input.task.key)
    .map(
      (c) =>
        `- ${c.from} uses ${c.to} (${c.edgeCount} graph link${c.edgeCount === 1 ? "" : "s"}, e.g. ${c.examples[0] ?? "n/a"})`,
    );
  const others = input.plan.tasks.filter((task) => task.key !== input.task.key);
  const sections = [
    `You are the "${input.task.key}" agent in a GoAgent mission. Other agents work in parallel in their own git worktrees.`,
    `Mission: ${input.request}`,
    `Your task (${input.task.role}): ${input.task.brief}`,
    `You own: ${input.task.ownsPaths.join(", ") || "(unspecified)"}`,
    others.length > 0
      ? `Other tasks:\n${others.map((task) => `- ${task.key} (${task.role}) owns ${task.ownsPaths.join(", ")}`).join("\n")}`
      : null,
    input.plan.constraints.length > 0
      ? `Constraints:\n${input.plan.constraints.map((c) => `- ${c}`).join("\n")}`
      : null,
    decisions.length > 0
      ? `Project decisions you must follow (recorded by the project's owner):\n${decisions.map((d) => `- ${d.text}`).join("\n")}`
      : null,
    coupled.length > 0
      ? `The knowledge graph links your code to other agents' code:\n${coupled.join("\n")}\nWhen you change something they depend on, or need something from them, call goagent_handoff with a short note; GoAgent decides which agent receives it.`
      : null,
    "Record each significant design decision you make (one line: what you chose and why) with goagent_record_decision. They are shown to the user per agent.",
    input.graphContext.length > 0
      ? `Relevant code relationships from the GoAgent knowledge graph (Graphify, read from source):\n${input.graphContext}`
      : null,
    "Start by calling goagent_graph_search for the main file or function you will change, then goagent_graph_neighbours on what it returns, to see what depends on it. Prefer these tools over grepping the whole repository; each call is recorded in the mission audit.",
    input.task.proposesContract
      ? "Before implementing, design the HTTP API the other agents will consume and publish it with the goagent_contract_propose tool (method, path, request shape, response shape). If you later change it, propose a new version."
      : null,
    input.contract !== null && input.task.dependsOn.includes(GOAGENT_CONTRACT_DEPENDENCY)
      ? `The API you must consume:\n${renderContract(input.contract)}\nBefore writing code, confirm you will use it exactly by calling goagent_contract_acknowledge with version ${input.contract.version} and a one-line note on how you will call it. If it is unusable, say why in your note and stop.`
      : null,
    input.packageManager == null
      ? null
      : `This repository uses ${input.packageManager}. Use it for installs and scripts, and do not create another package manager's lockfile.`,
    "When you are finished, run the relevant tests if you can, commit your changes in this worktree, and end with a short summary of what you changed.",
  ];
  return sections.filter((section) => section !== null).join("\n\n");
}

export function renderContractUpdateMessage(
  contract: Pick<GoAgentContract, "version" | "spec">,
): string {
  return `The API contract changed.\n${renderContract(contract)}\nUpdate your code to match, then call goagent_contract_acknowledge with version ${contract.version}.`;
}

/**
 * Top-level bullet points of a DECISIONS.md, one decision each, with markdown emphasis removed and
 * wrapped continuation lines joined. Headings and prose are ignored.
 */
export function parseDecisionsFile(markdown: string): ReadonlyArray<string> {
  const decisions: Array<string> = [];
  let current: string | null = null;
  const flush = () => {
    const text = current
      ?.replace(/\*\*|__/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) decisions.push(text.slice(0, MAX_DECISION_CHARS));
    current = null;
  };
  for (const line of markdown.split(/\r?\n/)) {
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      current = bullet[1]!;
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += ` ${line.trim()}`;
    } else {
      flush();
    }
  }
  flush();
  return decisions;
}

const MAX_DECISION_CHARS = 1_000;

/**
 * Project decisions as graph nodes, linked by `governs` edges only to files their text names
 * explicitly (for example `server/auth/jwt.ts`). Evidence is `explicit_human`: the link is what
 * the user wrote, not something Graphify read from source.
 */
export function decisionGraph(
  decisions: ReadonlyArray<Pick<GoAgentProjectDecision, "decisionId" | "text" | "sourceFile">>,
  nodes: ReadonlyArray<GoAgentGraphNode>,
): {
  readonly nodes: ReadonlyArray<GoAgentGraphNode>;
  readonly edges: ReadonlyArray<GoAgentGraphEdge>;
} {
  const files = nodes.filter((node) => node.kind === "file" && node.sourceFile !== null);
  const decisionNodes: Array<GoAgentGraphNode> = [];
  const edges: Array<GoAgentGraphEdge> = [];
  for (const decision of decisions) {
    const id = `decision:${decision.decisionId}`;
    decisionNodes.push({
      id,
      label: decision.text,
      kind: "decision",
      sourceFile: decision.sourceFile,
      sourceLocation: null,
      community: null,
    });
    for (const file of files) {
      if (!decision.text.includes(file.sourceFile!)) continue;
      edges.push({
        source: id,
        target: file.id,
        relation: "governs",
        evidence: "explicit_human",
        confidenceScore: 1,
        sourceFile: decision.sourceFile,
        sourceLocation: null,
      });
    }
  }
  return { nodes: decisionNodes, edges };
}

/** The bounded repair brief sent to the agent that owns a verification failure. */
export function renderRepairBrief(input: {
  readonly task: Pick<GoAgentPlanTask, "key" | "title" | "ownsPaths">;
  readonly command: string;
  readonly status: string;
  readonly exitCode: number | null;
  readonly logExcerpt: string;
  readonly contract: Pick<GoAgentContract, "version" | "spec"> | null;
  readonly reason: string;
}): string {
  return [
    `Verification of the integrated mission failed, and your task (${input.task.key}: ${input.task.title}) was picked to repair it.`,
    `Why you: ${input.reason}`,
    `Command: ${input.command} → ${input.status}${input.exitCode === null ? "" : ` (exit ${input.exitCode})`}`,
    "Last part of the output:",
    "```",
    input.logExcerpt.slice(-REPAIR_LOG_CHARS),
    "```",
    ...(input.contract === null
      ? []
      : ["The agreed contract is unchanged:", renderContract(input.contract)]),
    `Fix the cause inside the paths you own (${input.task.ownsPaths.join(", ") || "your task's files"}), run the failing check in your worktree, and commit. Keep the contract; if it really must change, propose a new version with goagent_contract_propose. This is the only repair round.`,
  ].join("\n");
}

const REPAIR_LOG_CHARS = 4_000;

/**
 * Reads the summary line Vitest and Jest print, e.g. `Tests  1 failed | 6 passed (7)` or
 * `Tests: 1 failed, 6 passed, 7 total`. Returns null rather than guessing when no line matches.
 */
export function parseTestSummary(output: string): GoAgentTestSummary | null {
  // oxlint-disable-next-line no-control-regex -- strips ANSI colour escapes
  const text = output.replace(/\u001b\[[0-9;]*m/g, "");
  const vitest = /^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/m.exec(text);
  if (vitest) {
    const parts = vitest[1]!;
    const count = (word: string) => Number(new RegExp(`(\\d+)\\s+${word}`).exec(parts)?.[1] ?? 0);
    return {
      total: Number(vitest[2]),
      passed: count("passed"),
      failed: count("failed"),
      skipped: count("skipped") + count("todo"),
    };
  }
  const jest = /^Tests:\s+(.+?)(\d+)\s+total\s*$/m.exec(text);
  if (jest) {
    const parts = jest[1]!;
    const count = (word: string) => Number(new RegExp(`(\\d+)\\s+${word}`).exec(parts)?.[1] ?? 0);
    return {
      total: Number(jest[2]),
      passed: count("passed"),
      failed: count("failed"),
      skipped: count("skipped") + count("todo"),
    };
  }
  return null;
}

/** Suggestions only: nothing runs until the user approves it. */
/** The package manager a repository's lockfile commits it to, or null without a lockfile. */
export function packageManagerFor(lockfiles: ReadonlySet<string>): string | null {
  if (lockfiles.has("pnpm-lock.yaml")) return "pnpm";
  if (lockfiles.has("yarn.lock")) return "yarn";
  if (lockfiles.has("bun.lock") || lockfiles.has("bun.lockb")) return "bun";
  if (lockfiles.has("package-lock.json")) return "npm";
  return null;
}

export function suggestVerificationCommands(
  packageJson: unknown,
  lockfiles: ReadonlySet<string>,
): ReadonlyArray<GoAgentVerificationCommand> {
  const scripts =
    typeof packageJson === "object" && packageJson !== null && "scripts" in packageJson
      ? (packageJson as { scripts?: unknown }).scripts
      : undefined;
  if (typeof scripts !== "object" || scripts === null) return [];
  const pm = packageManagerFor(lockfiles) ?? "npm";
  const install: GoAgentVerificationCommand = {
    id: "install",
    label: `${pm} install`,
    argv: pm === "npm" ? ["npm", "ci"] : [pm, "install", "--frozen-lockfile"],
    timeoutMs: 600_000,
  };
  const has = (name: string) => typeof (scripts as Record<string, unknown>)[name] === "string";
  const run = (name: string, timeoutMs: number): GoAgentVerificationCommand => ({
    id: name,
    label: `${pm} ${pm === "npm" ? "run " : ""}${name}`,
    argv: pm === "npm" ? ["npm", "run", name] : [pm, name],
    timeoutMs,
  });
  return [
    install,
    ...(has("typecheck") ? [run("typecheck", 600_000)] : []),
    ...(has("test") ? [run("test", 900_000)] : []),
  ];
}
