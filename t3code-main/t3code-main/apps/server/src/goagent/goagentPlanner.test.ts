import { describe, expect, it } from "@effect/vitest";

import {
  buildPlan,
  classifyArea,
  integrationOrder,
  parseTestSummary,
  suggestVerificationCommands,
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
  it("splits a client/server repo into backend and frontend with a contract gate", () => {
    const plan = buildPlan({
      request: "Add edit profile",
      files: fixtureFiles,
      verificationCommandIds: ["test"],
    });
    expect(
      plan.tasks.map((task) => [task.key, task.ownsPaths, task.dependsOn, task.proposesContract]),
    ).toEqual([
      ["backend", ["server/**", "tests/server/**"], [], true],
      ["frontend", ["tests/web/**", "web/**"], ["contract"], false],
    ]);
    expect(validatePlan(plan, ["test"])).toEqual([]);
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
  it("applies the contract proposer first, then dependents", () => {
    const plan = buildPlan({ request: "x", files: fixtureFiles, verificationCommandIds: [] });
    expect(integrationOrder(plan.tasks.toReversed())).toEqual(["backend", "frontend"]);
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
