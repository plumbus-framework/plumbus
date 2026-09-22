import {
  AIInvalidRequestError,
  type AIProviderAdapter,
  type AIProviderCapabilities,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type ListModelsFilter,
  type ProviderClassifyRequest,
  type ProviderClassifyResponse,
  type ProviderModel,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStreamEvent,
} from '@plumbus/core';
import type { NoulQuestion, NoulResponse, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { noul } from '@typesafe-ai/sdk';
import { resolveClient } from './client.js';
import { mapTypeSafeError, PROVIDER_NAME } from './errors.js';
import { calculateJevCost } from './pricing.js';
import type { TypeSafeClassifyAdapterConfig } from './types.js';

const DEFAULT_LABEL_THRESHOLD = 0.5;

/**
 * Jev generates no text, so every generation capability is off. `classify` is
 * the one chat-side operation it can answer, and it answers it natively.
 */
const TYPESAFE_CAPABILITIES: AIProviderCapabilities = {
  tools: false,
  streamingTools: false,
  parallelToolCalls: false,
  parallelToolCallControl: false,
  namedToolChoice: false,
  nativeClassify: true,
};

function unsupportedError(operation: string): AIInvalidRequestError {
  return new AIInvalidRequestError({
    reason: 'typesafe_generation_unsupported',
    message: `TypeSafe does not support ${operation}. Jev is a decision model: it answers typed questions about a state and generates no text. Use ctx.ai.decide() for typed decisions or ctx.ai.classify() for labels, and route ctx.ai.generate()/streamGenerate()/extract() to a text provider such as OpenAI or Anthropic.`,
  });
}

/**
 * One Noul per label in a single request.
 *
 * `ctx.ai.classify()` is multi-label, so a single Choice would be the wrong
 * shape — it returns exactly one option. Asking a yes/no question per label
 * keeps the multi-label contract and gives each label an independent
 * probability to threshold. Jev reads the state once and evaluates all the
 * questions against it in parallel, so this costs one request regardless of
 * how many labels there are.
 */
function buildLabelQuestions(labels: string[]): { questions: Questions; keyToLabel: string[] } {
  const questions: Record<string, NoulQuestion> = {};
  const keyToLabel: string[] = [];

  labels.forEach((label, index) => {
    // Positional keys, because a label can be any string and question ids have
    // to survive the round trip unchanged.
    const key = `label_${index}`;
    keyToLabel[index] = label;
    questions[key] = noul(
      {
        label,
        question: 'Does the `label` apply to the state?',
      },
      {
        true: 'The label applies to the state.',
        false: 'The label does not apply to the state.',
      },
    );
  });

  return { questions, keyToLabel };
}

/**
 * Create a Jev-backed `AIProviderAdapter` that serves `ctx.ai.classify()` and
 * rejects every generation operation.
 *
 * Register it as a normal provider so classify routes to Jev while generation
 * stays on a text model:
 *
 * ```ts
 * createAIService({
 *   providers: {
 *     openai: createProviderAdapter("openai", { apiKey: process.env.AI_OPENAI_API_KEY! }),
 *     typesafe: createTypeSafeAdapter({ apiKey: process.env.AI_TYPESAFE_API_KEY! }),
 *   },
 *   defaultProvider: "openai",
 * });
 * ```
 *
 * Note that `ctx.ai.classify()` always uses the *default* provider — it takes
 * no per-call provider override — so making classify Jev-backed means setting
 * `AI_DEFAULT_PROVIDER=typesafe`, which also sends `generate()` here and makes
 * it throw. Apps that need both generation and Jev-backed labels should call
 * `ctx.ai.decide()` with a Choice or Nouls instead of `classify()`.
 */
export function createTypeSafeAdapter(
  config: TypeSafeClassifyAdapterConfig = {},
): AIProviderAdapter {
  const client = resolveClient(config);
  const threshold = config.labelThreshold ?? DEFAULT_LABEL_THRESHOLD;

  return {
    name: PROVIDER_NAME,
    capabilities: TYPESAFE_CAPABILITIES,

    complete(_request: ProviderRequest): Promise<ProviderResponse> {
      return Promise.reject(unsupportedError('text completion (ctx.ai.generate / extract)'));
    },

    // Rejects on first iteration rather than when `stream()` is called, so the
    // failure surfaces the same way a real provider stream failure would.
    stream(_request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(unsupportedError('streaming (ctx.ai.streamGenerate)')),
        }),
      };
    },

    embed(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
      return Promise.reject(unsupportedError('embeddings (ctx.ai.retrieve / RAG ingestion)'));
    },

    async classify(request: ProviderClassifyRequest): Promise<ProviderClassifyResponse> {
      if (request.labels.length === 0) {
        throw new AIInvalidRequestError({
          reason: 'classify_labels_empty',
          message: 'ctx.ai.classify() requires at least one label',
        });
      }

      const { questions, keyToLabel } = buildLabelQuestions(request.labels);

      let result: SystemOneResult<Questions>;
      try {
        result = await client.systemOne(
          {
            state: request.text,
            questions,
            ...(request.model != null ? { model: request.model } : {}),
          },
          request.signal ? { signal: request.signal } : undefined,
        );
      } catch (err) {
        throw mapTypeSafeError(err);
      }

      const labels = keyToLabel.filter((_, index) => {
        const answer = result.answers[`label_${index}`] as NoulResponse | undefined;
        return answer != null && answer.noul >= threshold;
      });

      const inputTokens = result.usage.input_tokens;
      const outputTokens = result.usage.output_tokens;
      const cost = calculateJevCost(result.model, inputTokens);

      return {
        labels,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        ...(cost != null ? { cost } : {}),
      };
    },

    async listModels(filter?: ListModelsFilter): Promise<ProviderModel[]> {
      const kinds = filter?.kind == null ? undefined : [filter.kind].flat();
      // Jev is a decision model, so it matches no other kind filter.
      if (kinds && !kinds.includes('decision')) return [];

      try {
        const cards = await client.models.list();
        return cards.map((card) => ({
          id: card.name,
          provider: PROVIDER_NAME,
          kind: 'decision' as const,
          inputPerMTok: calculateJevCost(card.name, 1_000_000) ?? null,
          outputPerMTok: 0,
          displayName: card.description,
          createdAt: card.release_date,
        }));
      } catch (err) {
        console.warn(
          `[plumbus:ai-typesafe] listModels failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    },
  };
}
