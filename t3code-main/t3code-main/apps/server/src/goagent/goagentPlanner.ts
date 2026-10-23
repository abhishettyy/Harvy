import {
  GOAGENT_CONTRACT_DEPENDENCY,
  type GoAgentContract,
  type GoAgentGraphEdge,
  type GoAgentGraphNode,
  type GoAgentPlan,
  type GoAgentPlanTask,
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
  // Contract proposers go first so dependents apply on top of the API they consume.
  remaining.sort((a, b) => Number(b.proposesContract) - Number(a.proposesContract));
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
}): string {
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
    input.graphContext.length > 0
      ? `Relevant code relationships from the GoAgent knowledge graph (Graphify, read from source):\n${input.graphContext}\nUse the goagent_graph_search and goagent_graph_neighbours tools to explore more instead of grepping the whole repository.`
      : null,
    input.task.proposesContract
      ? "Before implementing, design the HTTP API the other agents will consume and publish it with the goagent_contract_propose tool (method, path, request shape, response shape). If you later change it, propose a new version."
      : null,
    input.contract !== null && input.task.dependsOn.includes(GOAGENT_CONTRACT_DEPENDENCY)
      ? `The API you must consume:\n${renderContract(input.contract)}\nBefore writing code, confirm you will use it exactly by calling goagent_contract_acknowledge with version ${input.contract.version} and a one-line note on how you will call it. If it is unusable, say why in your note and stop.`
      : null,
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
export function suggestVerificationCommands(
  packageJson: unknown,
  lockfiles: ReadonlySet<string>,
): ReadonlyArray<GoAgentVerificationCommand> {
  const scripts =
    typeof packageJson === "object" && packageJson !== null && "scripts" in packageJson
      ? (packageJson as { scripts?: unknown }).scripts
      : undefined;
  if (typeof scripts !== "object" || scripts === null) return [];
  const pm = lockfiles.has("pnpm-lock.yaml")
    ? "pnpm"
    : lockfiles.has("yarn.lock")
      ? "yarn"
      : lockfiles.has("bun.lock") || lockfiles.has("bun.lockb")
        ? "bun"
        : "npm";
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
