import {
  type DecisionAnswer,
  type DecisionModel,
  type DecisionProviderAdapter,
  type DecisionProviderCapabilities,
  type DecisionRequest,
  type DecisionResponse,
  validateDecisionQuestions,
} from '@plumbus/core';
import type { Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { resolveClient } from './client.js';
import { mapTypeSafeError, PROVIDER_NAME } from './errors.js';
import { calculateJevCost } from './pricing.js';
import type { TypeSafeAdapterConfig } from './types.js';

/**
 * Structural and budget limits Jev enforces server-side, declared up front so
 * `ctx.ai.decide()` rejects an over-long rubric locally instead of decoding a
 * 422 response body.
 *
 * Source: https://docs.typesafe.ai/models and https://docs.typesafe.ai/api
 */
export const JEV_CAPABILITIES: DecisionProviderCapabilities = {
  maxChoiceOptions: 255,
  scoreLevels: { min: 2, max: 10 },
  maxRequestTokens: 64_000,
  maxStateTokens: 32_000,
};

/**
 * Jev ingests the state once and evaluates every question against it in
 * parallel, which is why batching questions into one request is both cheaper
 * and faster than asking them one at a time. The framework does not split a
 * question map across requests, so an oversized map is a caller error.
 */
function assertWithinTokenBudget(request: DecisionRequest): void {
  const stateChars = JSON.stringify(request.state ?? null).length;
  const questionChars = JSON.stringify(request.questions).length;

  // ~4 characters per token. Deliberately coarse: this exists to turn a
  // wildly oversized request into a named local error, not to predict billing.
  const estimatedTokens = Math.ceil((stateChars + questionChars) / 4);
  const budget = JEV_CAPABILITIES.maxRequestTokens ?? Number.POSITIVE_INFINITY;

  if (estimatedTokens > budget) {
    throw new Error(
      `TypeSafe decision request is approximately ${estimatedTokens} tokens, over the ${budget}-token budget for state plus all questions. Split the questions across calls or shorten the state.`,
    );
  }
}

/**
 * The SDK's `Questions` type allows omitted instructions and requires a
 * two-entry tuple for score criteria. Core's questions are already validated
 * against {@link JEV_CAPABILITIES} by the time they get here, so the shapes
 * agree on the wire and this only restates that for the compiler.
 */
function toSdkQuestions(questions: DecisionRequest['questions']): Questions {
  return questions as unknown as Questions;
}

function toDecisionAnswers(result: SystemOneResult<Questions>): Record<string, DecisionAnswer> {
  // The wire shapes of noul/choice/score answers are identical to core's, so
  // this is a widening rather than a conversion.
  return result.answers as unknown as Record<string, DecisionAnswer>;
}

/**
 * Create a Jev-backed decision provider for `ctx.ai.decide()`.
 *
 * Register it under `decisionProviders` (or set `AI_DECISION_PROVIDER=typesafe`
 * and let the framework build it):
 *
 * ```ts
 * import { createAIService } from "@plumbus/core";
 * import { createTypeSafeDecisionAdapter } from "@plumbus/ai-typesafe";
 *
 * createAIService({
 *   providers: { openai: createOpenAIAdapter({ apiKey }) },
 *   defaultProvider: "openai",
 *   decisionProviders: { typesafe: createTypeSafeDecisionAdapter({ apiKey }) },
 *   defaultDecisionProvider: "typesafe",
 * });
 * ```
 */
export function createTypeSafeDecisionAdapter(
  config: TypeSafeAdapterConfig = {},
): DecisionProviderAdapter {
  const client = resolveClient(config);

  return {
    name: PROVIDER_NAME,
    capabilities: JEV_CAPABILITIES,

    async decide(request: DecisionRequest): Promise<DecisionResponse> {
      validateDecisionQuestions(request.questions, JEV_CAPABILITIES);
      assertWithinTokenBudget(request);

      let result: SystemOneResult<Questions>;
      try {
        result = await client.systemOne(
          {
            state: request.state as never,
            questions: toSdkQuestions(request.questions),
            ...(request.model != null ? { model: request.model } : {}),
          },
          request.signal ? { signal: request.signal } : undefined,
        );
      } catch (err) {
        throw mapTypeSafeError(err);
      }

      const inputTokens = result.usage.input_tokens;
      const outputTokens = result.usage.output_tokens;
      const cost = calculateJevCost(result.model, inputTokens);

      return {
        model: result.model,
        answers: toDecisionAnswers(result),
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        ...(cost != null ? { cost } : {}),
      };
    },

    async listModels(): Promise<DecisionModel[]> {
      try {
        const cards = await client.models.list();
        return cards.map((card) => ({
          name: card.name,
          description: card.description,
          releaseDate: card.release_date,
        }));
      } catch (err) {
        // Same contract as `AIProviderAdapter.listModels`: never throw from a
        // model listing, so a discovery call cannot take down a health check.
        console.warn(
          `[plumbus:ai-typesafe] listModels failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    },
  };
}
