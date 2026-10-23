import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { DecisionModel } from "effect/ai";
import * as AiError from "effect/ai/AiError";

import { interpretAnswer, makeWith, type DecisionRequest } from "./GoAgentDecisionService.ts";
import { failureOwnerDecision, routeDecision } from "./goagentDecisions.ts";

const plan = {
  title: "Edit profile",
  constraints: [],
  contract: null,
  tasks: [
    {
      key: "backend",
      title: "API",
      role: "backend" as const,
      brief: "b",
      ownsPaths: ["server/**"],
      dependsOn: [],
      proposesContract: true,
    },
    {
      key: "frontend",
      title: "UI",
      role: "frontend" as const,
      brief: "f",
      ownsPaths: ["web/**"],
      dependsOn: ["contract"],
      proposesContract: false,
    },
  ],
  verificationCommandIds: [],
};

const route = routeDecision({ request: "add edit profile", plan, touchedFiles: [] });

const fakeModel = (answers: Record<string, DecisionModel.ProviderAnswer>) =>
  DecisionModel.make({
    decide: () => Effect.succeed({ answers, usage: { inputTokens: 1, outputTokens: 1 } }),
  });

describe("interpretAnswer", () => {
  it("accepts a confident classification", () => {
    const outcome = interpretAnswer(
      route,
      {
        label: "parallel",
        probabilities: { parallel: 0.87, single_agent: 0.13 },
        confidence: 0.87,
      },
      "jev-1.13.0",
    );
    assert.deepStrictEqual(outcome, {
      answer: "parallel",
      probabilities: { parallel: 0.87, single_agent: 0.13 },
      confidence: 0.87,
      model: "jev-1.13.0",
      source: "jev",
      fallbackReason: null,
    });
  });

  it("falls back below the threshold and records why", () => {
    const outcome = interpretAnswer(
      route,
      { label: "single_agent", probabilities: { parallel: 0.45, single_agent: 0.55 } },
      "jev-latest",
    );
    assert.strictEqual(outcome.source, "fallback");
    assert.strictEqual(outcome.answer, "parallel");
    assert.include(outcome.fallbackReason ?? "", "below 0.6");
  });

  it("maps probability answers to true/false", () => {
    const request: DecisionRequest = { ...route, kind: "probability", threshold: 0.7 };
    const outcome = interpretAnswer(request, { probability: 0.9 }, "jev-latest");
    assert.strictEqual(outcome.answer, "true");
    assert.strictEqual(outcome.confidence, 0.9);
  });
});

describe("decide", () => {
  it.effect("uses the fallback when Jev is not configured", () =>
    Effect.gen(function* () {
      const service = makeWith({
        model: Option.none(),
        disabledReason: "TYPESAFE_API_KEY is not set",
      });
      assert.isFalse(service.status.available);
      const outcome = yield* service.decide(route);
      assert.strictEqual(outcome.source, "fallback");
      assert.strictEqual(outcome.answer, "parallel");
      assert.include(outcome.fallbackReason ?? "", "TYPESAFE_API_KEY is not set");
    }),
  );

  it.effect("returns Jev's answer from the decision model", () =>
    Effect.gen(function* () {
      const model = yield* fakeModel({
        answer: {
          _tag: "Classify",
          label: "single_agent",
          probabilities: { single_agent: 0.9, parallel: 0.1 },
          confidence: 0.9,
        },
      });
      const service = makeWith({
        model: Option.some({ name: "jev-1.13.0", service: model }),
        disabledReason: "",
      });
      const outcome = yield* service.decide(route);
      assert.strictEqual(outcome.source, "jev");
      assert.strictEqual(outcome.answer, "single_agent");
      assert.strictEqual(outcome.model, "jev-1.13.0");
    }),
  );

  it.effect("falls back when the Jev request fails", () =>
    Effect.gen(function* () {
      const model = yield* DecisionModel.make({
        decide: () =>
          Effect.fail(
            AiError.make({
              module: "TypeSafeClient",
              method: "systemOne",
              reason: new AiError.InvalidRequestError({ description: "bad request" }),
            }),
          ),
      });
      const service = makeWith({
        model: Option.some({ name: "jev-latest", service: model }),
        disabledReason: "",
      });
      const outcome = yield* service.decide(route);
      assert.strictEqual(outcome.source, "fallback");
      assert.include(outcome.fallbackReason ?? "", "Jev request failed");
    }),
  );
});

describe("failureOwnerDecision", () => {
  it("falls back to the task whose paths the log mentions most", () => {
    const request = failureOwnerDecision({
      logExcerpt: "FAIL tests/web/profileApi.test.ts > web/src/api/profile.ts:12",
      tasks: plan.tasks,
    });
    assert.strictEqual(request.fallback.answer, "frontend");
    assert.deepStrictEqual(
      request.criteria.map((c) => c.label),
      ["backend", "frontend", "unknown"],
    );
  });

  it("falls back to unknown when no task is singled out", () => {
    const request = failureOwnerDecision({ logExcerpt: "Error: timeout", tasks: plan.tasks });
    assert.strictEqual(request.fallback.answer, "unknown");
  });
});
