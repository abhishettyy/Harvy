import { describe, expect, it } from "@effect/vitest";

import {
  buildPlan,
  classifyArea,
  decisionGraph,
  impactedTasks,
  integrationOrder,
  ownerOfPath,
  packageManagerFor,
  parseDecisionsFile,
  parseTestSummary,
  renderHandoffMessage,
  renderRepairBrief,
  renderTaskPrompt,
  suggestVerificationCommands,
  taskCoupling,
  validatePlan,
} from "./goagentPlanner.ts";

// File layout of fixtures/profile-app.
const fixtureFiles = [
  "server/app.ts",
  "server/db.ts",
  "server/index.ts",
  "server/auth/jwt.ts",
  "server/auth/middleware.ts",
  "server/routes/auth.ts",
  "server/routes/profile.ts",
  "web/src/App.tsx",
  "web/src/api/client.ts",
  "web/src/api/profile.ts",
  "web/src/pages/ProfilePage.tsx",
  "tests/server/profile.test.ts",
  "tests/web/profileApi.test.ts",
  "vitest.config.ts",
];

describe("classifyArea", () => {
  it("separates client, server, tests and other files", () => {
    expect(classifyArea("server/routes/profile.ts")).toBe("server");
    expect(classifyArea("web/src/api/profile.ts")).toBe("client");
    expect(classifyArea("tests/web/profileApi.test.ts")).toBe("test");
    expect(classifyArea("vitest.config.ts")).toBe("other");
  });
});

describe("buildPlan", () => {
  it("splits a client/server repo with tests into backend, frontend and tests agents", () => {
    const plan = buildPlan({
      request: "Add edit profile",
      files: fixtureFiles,
      verificationCommandIds: ["test"],
    });
    expect(
      plan.tasks.map((task) => [task.key, task.ownsPaths, task.dependsOn, task.proposesContract]),
    ).toEqual([
      ["backend", ["server/**"], [], true],
      ["frontend", ["web/**"], ["contract"], false],
      ["tests", ["tests/server/**", "tests/web/**"], ["contract"], false],
    ]);
    expect(validatePlan(plan, ["test"])).toEqual([]);
  });

  it("keeps tests with their side when the repo has no test files", () => {
    const plan = buildPlan({
      request: "Add edit profile",
      files: fixtureFiles.filter((file) => !file.startsWith("tests/")),
      verificationCommandIds: [],
    });
    expect(plan.tasks.map((task) => task.key)).toEqual(["backend", "frontend"]);
  });

  it("plans one task for a single-area repo", () => {
    const plan = buildPlan({
      request: "Fix bug",
      files: ["server/a.ts", "server/b.ts"],
      verificationCommandIds: [],
    });
    expect(plan.tasks.map((task) => task.key)).toEqual(["implement"]);
  });
});

describe("validatePlan", () => {
  const base = buildPlan({ request: "x", files: fixtureFiles, verificationCommandIds: [] });

  it("rejects unknown dependencies, cycles and unapproved commands", () => {
    const plan = {
      ...base,
      tasks: [
        { ...base.tasks[0]!, dependsOn: ["frontend"] },
        { ...base.tasks[1]!, dependsOn: ["backend", "ghost"] },
      ],
      verificationCommandIds: ["deploy"],
    };
    expect(validatePlan(plan, ["test"])).toEqual([
      'Task "frontend" depends on unknown task "ghost".',
      "Task dependencies form a cycle.",
      'Verification command "deploy" is not approved.',
    ]);
  });

  it("rejects a contract wait with no proposer", () => {
    const plan = {
      ...base,
      tasks: base.tasks.map((task) => ({ ...task, proposesContract: false })),
    };
    expect(validatePlan(plan, [])).toContain(
      "A task waits for the contract, but no task proposes one and the plan sets none.",
    );
  });

  it("rejects too many tasks", () => {
    const extra = (key: string) => ({ ...base.tasks[0]!, key, proposesContract: false });
    const plan = { ...base, tasks: [...base.tasks, extra("tests"), extra("docs")] };
    expect(validatePlan(plan, [])).toContain("At most 3 tasks can run in one mission.");
  });
});

describe("integrationOrder", () => {
  it("applies the contract proposer first, then dependents, then tests", () => {
    const plan = buildPlan({ request: "x", files: fixtureFiles, verificationCommandIds: [] });
    expect(integrationOrder(plan.tasks.toReversed())).toEqual(["backend", "frontend", "tests"]);
  });
});

describe("parseTestSummary", () => {
  it("reads Vitest summaries, including colour codes", () => {
    expect(parseTestSummary(" Test Files  3 passed (3)\n      Tests  7 passed (7)\n")).toEqual({
      total: 7,
      passed: 7,
      failed: 0,
      skipped: 0,
    });
    expect(parseTestSummary("\u001b[2m      Tests \u001b[22m 1 failed | 6 passed (7)")).toEqual({
      total: 7,
      passed: 6,
      failed: 1,
      skipped: 0,
    });
  });

  it("reads Jest summaries and refuses to guess otherwise", () => {
    expect(parseTestSummary("Tests:       1 failed, 2 skipped, 5 passed, 8 total")).toEqual({
      total: 8,
      passed: 5,
      failed: 1,
      skipped: 2,
    });
    expect(parseTestSummary("all good")).toBeNull();
  });
});

describe("suggestVerificationCommands", () => {
  it("suggests install then the test script with the repo's package manager", () => {
    const commands = suggestVerificationCommands(
      { scripts: { test: "vitest run", dev: "vite" } },
      new Set(["pnpm-lock.yaml"]),
    );
    expect(commands.map((command) => command.argv)).toEqual([
      ["pnpm", "install", "--frozen-lockfile"],
      ["pnpm", "test"],
    ]);
  });

  it("suggests nothing without scripts", () => {
    expect(suggestVerificationCommands({}, new Set())).toEqual([]);
  });
});

describe("packageManagerFor", () => {
  it("follows the committed lockfile and has no opinion without one", () => {
    expect(packageManagerFor(new Set(["pnpm-lock.yaml"]))).toBe("pnpm");
    expect(packageManagerFor(new Set(["bun.lockb"]))).toBe("bun");
    expect(packageManagerFor(new Set(["package-lock.json"]))).toBe("npm");
    expect(packageManagerFor(new Set())).toBeNull();
  });
});

describe("renderTaskPrompt", () => {
  it("names the repository's package manager so agents do not add another lockfile", () => {
    const plan = buildPlan({
      request: "Edit profile",
      files: fixtureFiles,
      verificationCommandIds: [],
    });
    const task = plan.tasks[0]!;
    const base = { request: "Edit profile", plan, task, graphContext: "", contract: null };
    expect(renderTaskPrompt({ ...base, packageManager: "pnpm" })).toContain(
      "This repository uses pnpm",
    );
    expect(renderTaskPrompt(base)).not.toContain("This repository uses");
  });
});

describe("renderRepairBrief", () => {
  it("bounds the log, names the failing command and keeps the contract", () => {
    const brief = renderRepairBrief({
      task: { key: "frontend", title: "Profile UI", ownsPaths: ["web/**"] },
      command: "pnpm test",
      status: "failed",
      exitCode: 1,
      logExcerpt: `${"x".repeat(10_000)}FAIL tests/web/profileApi.test.ts`,
      contract: {
        version: 2,
        spec: {
          method: "PATCH",
          path: "/api/profile",
          request: "{ name }",
          response: "{ id, name }",
          notes: "",
        },
      },
      reason: "Jev picked this task (88%)",
    });
    expect(brief).toContain("pnpm test → failed (exit 1)");
    expect(brief).toContain("Jev picked this task (88%)");
    expect(brief).toContain("FAIL tests/web/profileApi.test.ts");
    expect(brief).toContain("PATCH /api/profile");
    expect(brief).toContain("only repair round");
    expect(brief.length).toBeLessThan(6_000);
  });
});

describe("parseDecisionsFile", () => {
  it("reads one decision per top-level bullet, joining wrapped lines", () => {
    const markdown = [
      "# Project decisions",
      "",
      "- **Auth:** Use the existing JWT auth service in `server/auth/jwt.ts`. Do not introduce a new auth",
      "  provider (Auth0, Clerk, sessions).",
      "- **Database:** SQLite via `node:sqlite`. No ORM.",
      "",
      "Some prose that is not a decision.",
    ].join("\n");
    expect(parseDecisionsFile(markdown)).toEqual([
      "Auth: Use the existing JWT auth service in `server/auth/jwt.ts`. Do not introduce a new auth provider (Auth0, Clerk, sessions).",
      "Database: SQLite via `node:sqlite`. No ORM.",
    ]);
  });
});

describe("decisionGraph", () => {
  it("links a decision only to files its text names, as explicit_human evidence", () => {
    const files = [
      {
        id: "jwt",
        label: "jwt.ts",
        kind: "file" as const,
        sourceFile: "server/auth/jwt.ts",
        sourceLocation: "L1",
        community: 0,
      },
      {
        id: "db",
        label: "db.ts",
        kind: "file" as const,
        sourceFile: "server/db.ts",
        sourceLocation: "L1",
        community: 0,
      },
    ];
    const graph = decisionGraph(
      [
        {
          decisionId: "d1" as never,
          text: "Use `server/auth/jwt.ts` for auth.",
          sourceFile: "DECISIONS.md",
        },
      ],
      files,
    );
    expect(graph.nodes.map((n) => [n.id, n.kind])).toEqual([["decision:d1", "decision"]]);
    expect(graph.edges.map((e) => [e.source, e.target, e.relation, e.evidence])).toEqual([
      ["decision:d1", "jwt", "governs", "explicit_human"],
    ]);
  });
});

// The fixture's real link chain, as Graphify reads it: importer/caller -> imported/callee.
const fileNode = (id: string) => ({
  id,
  label: id,
  kind: "file" as const,
  sourceFile: id,
  sourceLocation: "L1",
  community: 0,
});
const link = (source: string, target: string, relation = "imports") => ({
  source,
  target,
  relation,
  evidence: "verified_static" as const,
  confidenceScore: 1,
  sourceFile: source,
  sourceLocation: "L1",
});
const threeTasks = [
  { key: "backend", ownsPaths: ["server/**"] },
  { key: "frontend", ownsPaths: ["web/**"] },
  { key: "tests", ownsPaths: ["tests/server/**", "tests/web/**"] },
];
const fixtureGraph = {
  nodes: [
    "server/app.ts",
    "server/routes/profile.ts",
    "web/src/api/profile.ts",
    "tests/server/helpers.ts",
    "tests/server/profile.test.ts",
    "tests/web/profileApi.test.ts",
  ].map(fileNode),
  edges: [
    link("server/app.ts", "server/routes/profile.ts", "calls"),
    link("tests/server/helpers.ts", "server/app.ts", "calls"),
    link("tests/server/profile.test.ts", "tests/server/helpers.ts"),
    link("tests/web/profileApi.test.ts", "web/src/api/profile.ts"),
  ],
};

describe("ownerOfPath", () => {
  it("picks the task with the longest matching owned prefix", () => {
    expect(ownerOfPath(threeTasks, "tests/web/profileApi.test.ts")).toBe("tests");
    expect(ownerOfPath(threeTasks, "server/db.ts")).toBe("backend");
    expect(ownerOfPath(threeTasks, "package.json")).toBeNull();
  });
});

describe("taskCoupling", () => {
  it("counts graph edges that cross from one task's files to another's", () => {
    expect(taskCoupling(threeTasks, fixtureGraph)).toEqual([
      {
        from: "tests",
        to: "backend",
        edgeCount: 1,
        examples: ["tests/server/helpers.ts -> server/app.ts (calls)"],
      },
      {
        from: "tests",
        to: "frontend",
        edgeCount: 1,
        examples: ["tests/web/profileApi.test.ts -> web/src/api/profile.ts (imports)"],
      },
    ]);
  });
});

describe("impactedTasks", () => {
  it("follows the graph from a changed file back to the agents whose code uses it", () => {
    expect(
      impactedTasks({
        tasks: threeTasks,
        fromTask: "backend",
        changedFiles: ["server/routes/profile.ts"],
        graph: fixtureGraph,
      }),
    ).toEqual([
      {
        taskKey: "tests",
        links: ["tests/server/helpers.ts -> server/app.ts -> server/routes/profile.ts"],
      },
    ]);
  });

  it("never points back from tests to the code they test", () => {
    expect(
      impactedTasks({
        tasks: threeTasks,
        fromTask: "tests",
        changedFiles: ["tests/server/profile.test.ts", "tests/web/profileApi.test.ts"],
        graph: fixtureGraph,
      }),
    ).toEqual([]);
  });
});

describe("renderHandoffMessage", () => {
  it("cites the graph links and the sender", () => {
    const text = renderHandoffMessage({
      fromTask: "backend",
      changedFiles: ["server/routes/profile.ts"],
      links: ["tests/server/helpers.ts -> server/app.ts -> server/routes/profile.ts"],
      note: null,
      contract: null,
    });
    expect(text).toContain("The backend agent finished");
    expect(text).toContain(
      "- tests/server/helpers.ts -> server/app.ts -> server/routes/profile.ts",
    );
  });
});
