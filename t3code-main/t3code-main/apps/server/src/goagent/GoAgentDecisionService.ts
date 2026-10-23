import * as TypeSafeClient from "@effect/ai-typesafe/TypeSafeClient";
import * as TypeSafeDecisionModel from "@effect/ai-typesafe/TypeSafeDecisionModel";
import type {
  GoAgentDecisionKey,
  GoAgentDecisionSource,
  GoAgentToolStatus,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Decision, DecisionModel } from "effect/ai";
import * as HttpClient from "effect/http/HttpClient";

/**
 * One bounded question for Jev. `criteria` maps each answer label to its description; for `rate`
 * the entries are ordered lowest to highest. `fallback` is the deterministic answer used when Jev is
 * disabled, fails, times out, or is not confident enough.
 */
export interface DecisionRequest {
  readonly key: GoAgentDecisionKey;
  readonly kind: "classify" | "rate" | "probability";
  readonly question: string;
  readonly criteria: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly input: Readonly<Record<string, string>>;
  readonly threshold: number;
  readonly fallback: { readonly answer: string; readonly reason: string };
}

export interface DecisionOutcome {
  readonly answer: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number | null;
  readonly model: string | null;
  readonly source: GoAgentDecisionSource;
  readonly fallbackReason: string | null;
}

export class GoAgentDecisionService extends Context.Service<
  GoAgentDecisionService,
  {
    readonly status: GoAgentToolStatus;
    /** Never fails: any Jev problem resolves to the request's labelled fallback. */
    readonly decide: (request: DecisionRequest) => Effect.Effect<DecisionOutcome>;
  }
>()("t3/goagent/GoAgentDecisionService") {}

const DECISION_TIMEOUT = Duration.seconds(10);
const DEFAULT_JEV_MODEL = "jev-latest";

const DecisionInput = Schema.Record(Schema.String, Schema.String);

const fallbackOutcome = (request: DecisionRequest, reason: string): DecisionOutcome => ({
  answer: request.fallback.answer,
  probabilities: {},
  confidence: null,
  model: null,
  source: "fallback",
  fallbackReason: `${reason}; ${request.fallback.reason}`,
});

const toDefinitionDecision = (request: DecisionRequest) => {
  switch (request.kind) {
    case "classify":
      return Decision.classify({
        instructions: request.question,
        criteria: Object.fromEntries(request.criteria.map((c) => [c.label, c.description])),
      });
    case "rate":
      return Decision.rate({
        instructions: request.question,
        criteria: request.criteria.map((c) => ({ label: c.label, description: c.description })),
      });
    case "probability": {
      const describe = (label: string) =>
        request.criteria.find((c) => c.label === label)?.description ?? label;
      return Decision.probability({
        instructions: request.question,
        criteria: { false: describe("false"), true: describe("true") },
      });
    }
  }
};

/** Pure: turns a raw Jev answer into an outcome, applying the confidence threshold. */
export function interpretAnswer(
  request: DecisionRequest,
  answer:
    | {
        readonly label: string;
        readonly probabilities: Readonly<Record<string, number>>;
        readonly confidence?: number | undefined;
      }
    | { readonly probability: number },
  model: string,
): DecisionOutcome {
  if ("probability" in answer) {
    const p = answer.probability;
    const label = p >= 0.5 ? "true" : "false";
    const confidence = Math.max(p, 1 - p);
    if (confidence < request.threshold)
      return fallbackOutcome(
        request,
        `Jev confidence ${confidence.toFixed(2)} is below ${request.threshold}`,
      );
    return {
      answer: label,
      probabilities: { true: p, false: 1 - p },
      confidence,
      model,
      source: "jev",
      fallbackReason: null,
    };
  }
  const probabilities = { ...answer.probabilities };
  const confidence = answer.confidence ?? probabilities[answer.label] ?? null;
  if (confidence === null || confidence < request.threshold)
    return fallbackOutcome(
      request,
      confidence === null
        ? "Jev returned no confidence"
        : `Jev confidence ${confidence.toFixed(2)} is below ${request.threshold}`,
    );
  return {
    answer: answer.label,
    probabilities,
    confidence,
    model,
    source: "jev",
    fallbackReason: null,
  };
}

export const makeWith = (options: {
  readonly model: Option.Option<{
    readonly name: string;
    readonly service: DecisionModel.DecisionModel;
  }>;
  readonly disabledReason: string;
}) =>
  GoAgentDecisionService.of({
    status: Option.match(options.model, {
      onNone: () => ({ available: false, version: null, detail: options.disabledReason }),
      onSome: ({ name }) => ({ available: true, version: name, detail: null }),
    }),
    decide: Effect.fn("GoAgentDecisionService.decide")(function* (request: DecisionRequest) {
      if (Option.isNone(options.model)) return fallbackOutcome(request, options.disabledReason);
      if (request.criteria.length < 2 && request.kind !== "probability")
        return fallbackOutcome(request, "fewer than two answer options");
      const { name, service } = options.model.value;
      const definition = Decision.make({
        input: DecisionInput,
        decisions: { answer: toDefinitionDecision(request) },
      });
      return yield* DecisionModel.decide(definition, { input: { ...request.input } }).pipe(
        Effect.provideService(DecisionModel.DecisionModel, service),
        Effect.timeout(DECISION_TIMEOUT),
        Effect.map(({ answers }) => interpretAnswer(request, answers.answer, name)),
        Effect.catch((error) =>
          Effect.succeed(
            fallbackOutcome(
              request,
              error._tag === "TimeoutError"
                ? "Jev timed out"
                : `Jev request failed (${error._tag})`,
            ),
          ),
        ),
      );
    }),
  });

const JevConfig = Config.all({
  apiKey: Config.Redacted("TYPESAFE_API_KEY").pipe(Config.option),
  enabled: Config.String("GOAGENT_JEV_ENABLED").pipe(Config.withDefault("true")),
  modelName: Config.String("GOAGENT_JEV_MODEL").pipe(Config.withDefault(DEFAULT_JEV_MODEL)),
});

const make = Effect.gen(function* () {
  const config = yield* Effect.option(JevConfig);
  if (Option.isNone(config))
    return makeWith({ model: Option.none(), disabledReason: "Jev configuration is invalid" });
  const { apiKey, enabled, modelName } = config.value;
  if (enabled === "false")
    return makeWith({
      model: Option.none(),
      disabledReason: "Jev is turned off (GOAGENT_JEV_ENABLED=false)",
    });
  if (Option.isNone(apiKey))
    return makeWith({ model: Option.none(), disabledReason: "TYPESAFE_API_KEY is not set" });
  const httpClient = yield* HttpClient.HttpClient;
  const service = yield* DecisionModel.DecisionModel.use(Effect.succeed).pipe(
    Effect.provide(
      TypeSafeDecisionModel.layer({ model: modelName }).pipe(
        Layer.provide(TypeSafeClient.layer({ apiKey: apiKey.value })),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
      ),
    ),
  );
  return makeWith({ model: Option.some({ name: modelName, service }), disabledReason: "" });
});

export const layer = Layer.effect(GoAgentDecisionService, make);
