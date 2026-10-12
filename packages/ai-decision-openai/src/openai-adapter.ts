import {
  createDecisionHttpTransport,
  DecisionJsonSchema,
  DecisionProviderError,
  parseDecisionResponse,
  validateDecisionRequest,
  type DecisionDescription,
  type DecisionHttpConfig,
  type DecisionProviderAdapter,
  type DecisionQuestions,
  type DecisionUsage,
} from '@plumbus/ai-decision';
import { z } from '@plumbus/core/zod';

export interface OpenAIDecisionAdapterConfig
  extends Omit<DecisionHttpConfig, 'baseUrl' | 'apiKey'> {
  apiKey: string;
  /** API prefix, normally https://api.openai.com/v1. */
  baseUrl?: string;
  model?: string;
  /** Input USD / million tokens, keyed by the actual response model ID. */
  inputRates?: Readonly<Record<string, number>>;
}

/**
 * Source: https://developers.openai.com/api/docs/guides/decisions, verified 2026-10-08.
 * Output and cached input are not charged separately. Bundled rates double above
 * 272K input tokens; regional processing is not modeled.
 */
export const OpenAIDecisionInputRates = Object.freeze({ 'gpt-6-luna': 0.1 });

// https://developers.openai.com/api/docs/models/gpt-6-luna: "more than 272K input tokens are priced at 2x".
const LongContextInputTokens = 272_000;
// OpenAI documents no precision; its examples use two decimal places.
const Rounding = 0.01;
const Provider = 'openai-decisions';
const ProbabilitySchema = z.number().finite().min(0).max(1);
const TokensSchema = z.number().int().nonnegative().safe();
const MetadataSchema = z.object({
  model: z.string().trim().min(1).max(512),
  usage: z.object({ input_tokens: TokensSchema, output_tokens: TokensSchema }),
});
const EnvelopeSchema = MetadataSchema.extend({ answers: z.array(z.unknown()).max(256) });
const AnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), name: z.string(), probability: ProbabilitySchema }),
  z.object({
    type: z.literal('choice'),
    name: z.string(),
    choice: z.string(),
    confidence: ProbabilitySchema,
    probabilities: z
      .array(z.object({ value: z.string(), probability: ProbabilitySchema }))
      .max(255),
  }),
  z.object({
    type: z.literal('score'),
    name: z.string(),
    score: z.number().finite(),
    confidence: ProbabilitySchema,
    probabilities: z
      .array(
        z.object({
          value: z.number().int().nonnegative(),
          label: z.string(),
          probability: ProbabilitySchema,
        }),
      )
      .max(10),
  }),
  z.object({ type: z.literal('refusal'), name: z.string().nullable() }),
]);

const text = (value: DecisionDescription): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

function toOpenAIQuestions(questions: DecisionQuestions): unknown[] {
  return Object.entries(questions).map(([name, question]) => {
    const instructions = text(question.instructions);
    if (question.type === 'choice')
      return {
        type: 'choice',
        name,
        instructions,
        choices: Object.entries(question.criteria).map(([value, description]) =>
          description === null ? { value } : { value, description: text(description) },
        ),
      };
    if (question.type === 'score')
      return {
        type: 'score',
        name,
        instructions,
        levels: question.criteria.map((level) => ({ label: text(level) })),
      };
    const criteria = question.criteria ?? {};
    return {
      type: 'predicate',
      name,
      instructions: [
        instructions,
        ...(criteria.true === undefined ? [] : [`True when: ${text(criteria.true)}`]),
        ...(criteria.false === undefined ? [] : [`False when: ${text(criteria.false)}`]),
      ].join('\n'),
    };
  });
}

/** Creates an OpenAI Decisions API (`POST /v1/decisions`) adapter without the OpenAI SDK. */
export function createOpenAIDecisionAdapter(
  config: OpenAIDecisionAdapterConfig,
): DecisionProviderAdapter {
  const settings = z
    .object({
      apiKey: z.string().min(1),
      model: z.string().trim().min(1).max(256).default('gpt-6-luna'),
      inputRates: DecisionJsonSchema.pipe(z.record(z.number().finite().nonnegative())).optional(),
    })
    .safeParse(config);
  if (!settings.success)
    throw new DecisionProviderError(
      Provider,
      'configuration',
      'OpenAI requires an API key and valid model/pricing configuration',
    );
  const rates: Record<string, number> = {
    ...OpenAIDecisionInputRates,
    ...settings.data.inputRates,
  };
  const post = createDecisionHttpTransport(
    Provider,
    {
      ...config,
      apiKey: settings.data.apiKey,
      baseUrl: config.baseUrl === undefined ? 'https://api.openai.com/v1' : config.baseUrl,
    },
    { path: 'decisions' },
  );

  // Dated snapshots (gpt-6-luna-2026-10-01) inherit the alias rate; other unknown models stay unpriced.
  const pricedAs = (model: string): string | undefined => {
    if (Object.hasOwn(rates, model)) return model;
    const alias = /^(.+)-\d{4}-\d{2}-\d{2}$/.exec(model)?.[1];
    return alias !== undefined && Object.hasOwn(rates, alias) ? alias : undefined;
  };
  const costFor = (model: string, usage: DecisionUsage): number | null => {
    const priced = pricedAs(model);
    const rate = priced === undefined ? undefined : rates[priced];
    if (priced === undefined || rate === undefined) return null;
    // Configured rates are flat; bundled rates double for long prompts, as OpenAI bills them.
    const long =
      !Object.hasOwn(settings.data.inputRates ?? {}, priced) &&
      usage.inputTokens > LongContextInputTokens;
    const cost = (usage.inputTokens / 1_000_000) * rate * (long ? 2 : 1);
    return Number.isFinite(cost) && (cost > 0 || usage.inputTokens === 0 || rate === 0)
      ? cost
      : Number.NaN;
  };

  return {
    name: Provider,
    rounding: Rounding,
    async decide(request) {
      const input = validateDecisionRequest(request, Provider);
      const start = performance.now();
      const wire = await post(
        {
          model: input.model ?? settings.data.model,
          input: text(input.state),
          questions: toOpenAIQuestions(input.questions),
        },
        input,
      );

      const metadata = MetadataSchema.safeParse(wire);
      const model = metadata.success ? metadata.data.model : undefined;
      const usage: DecisionUsage | undefined = metadata.success
        ? {
            inputTokens: metadata.data.usage.input_tokens,
            outputTokens: metadata.data.usage.output_tokens,
            totalTokens: metadata.data.usage.input_tokens + metadata.data.usage.output_tokens,
          }
        : undefined;
      const fail = (message: string, refusedQuestions?: string[]): DecisionProviderError => {
        const refusal = refusedQuestions === undefined ? {} : { refusedQuestions };
        if (model === undefined || usage === undefined || !Number.isSafeInteger(usage.totalTokens))
          return new DecisionProviderError(Provider, 'invalid_response', message, refusal);
        const cost = costFor(model, usage);
        return new DecisionProviderError(Provider, 'invalid_response', message, {
          model,
          usage,
          cost: cost === null || Number.isNaN(cost) ? null : cost,
          ...refusal,
        });
      };

      const envelope = EnvelopeSchema.safeParse(wire);
      if (!envelope.success) throw fail('Invalid OpenAI decision response envelope');
      const mismatch = 'OpenAI decision answers do not match the question contract';
      if (envelope.data.answers.length !== Object.keys(input.questions).length)
        throw fail(mismatch);

      const answers: Record<string, unknown> = {};
      const named = new Set<string>();
      let refused = false;
      for (const raw of envelope.data.answers) {
        const parsed = AnswerSchema.safeParse(raw);
        if (!parsed.success) throw fail(mismatch);
        const answer = parsed.data;
        if (answer.type === 'refusal') refused = true;
        // Only a refusal may be unnamed; its question is found by elimination below.
        if (answer.name === null) continue;
        const question = Object.hasOwn(input.questions, answer.name)
          ? input.questions[answer.name]
          : undefined;
        if (question === undefined || named.has(answer.name)) throw fail(mismatch);
        named.add(answer.name);

        if (answer.type === 'refusal') continue;
        if (answer.type === 'predicate') {
          answers[answer.name] = { type: 'noul', noul: answer.probability };
        } else if (answer.type === 'choice') {
          if (question.type !== 'choice') throw fail(mismatch);
          // Omitted options have zero probability; unknown or repeated options are errors.
          const probabilities: Record<string, number> = Object.fromEntries(
            Object.keys(question.criteria).map((value) => [value, 0]),
          );
          const seen = new Set<string>();
          for (const option of answer.probabilities) {
            if (!Object.hasOwn(probabilities, option.value) || seen.has(option.value))
              throw fail(mismatch);
            seen.add(option.value);
            probabilities[option.value] = option.probability;
          }
          answers[answer.name] = {
            type: 'choice',
            choice: answer.choice,
            probabilities,
            confidence: answer.confidence,
          };
        } else {
          if (question.type !== 'score') throw fail(mismatch);
          const levels = question.criteria;
          const probabilities: Record<string, number> = Object.fromEntries(
            levels.map((_, index) => [String(index), 0]),
          );
          const seen = new Set<number>();
          for (const level of answer.probabilities) {
            const requested = levels[level.value];
            if (requested === undefined || level.label !== text(requested) || seen.has(level.value))
              throw fail(mismatch);
            seen.add(level.value);
            probabilities[String(level.value)] = level.probability;
          }
          answers[answer.name] = {
            type: 'score',
            score: answer.score,
            probabilities,
            confidence: answer.confidence,
            legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
          };
        }
      }

      // Check the answered questions first, so a malformed answer is never reported as a refusal.
      const answered = Object.fromEntries(
        Object.entries(input.questions).filter(([key]) => Object.hasOwn(answers, key)),
      ) as typeof input.questions;
      let result: ReturnType<typeof parseDecisionResponse<typeof input.questions>>;
      try {
        result = parseDecisionResponse(
          { model: envelope.data.model, usage: envelope.data.usage, answers },
          answered,
          Provider,
          { rounding: Rounding },
        );
      } catch (error) {
        if (error instanceof DecisionProviderError) throw fail(mismatch);
        throw error;
      }
      // Every other question has exactly one answer, so the unanswered ones were refused.
      if (refused)
        throw fail(
          'OpenAI refused to answer a decision question',
          Object.keys(input.questions).filter((key) => !Object.hasOwn(answers, key)),
        );
      const cost = costFor(result.model, result.usage);
      if (cost !== null && Number.isNaN(cost))
        throw new DecisionProviderError(
          Provider,
          'configuration',
          'OpenAI cost estimate cannot be represented',
          { usage: result.usage, model: result.model },
        );
      return {
        ...result,
        cost,
        costAvailable: cost !== null,
        latencyMs: performance.now() - start,
      };
    },
  };
}
