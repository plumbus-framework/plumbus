import { z } from '@plumbus/core/zod';
import { isDeepStrictEqual } from 'node:util';
import { DecisionProviderError } from './errors/index.js';
import { DecisionJsonSchema, jsonRecord } from './json.js';
import type {
  DecisionAnswers,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
  DecisionUsage,
} from './types.js';

const DescriptionSchema = DecisionJsonSchema.pipe(
  z.union([z.string(), z.array(DecisionJsonSchema), jsonRecord(DecisionJsonSchema)]),
);
const QuestionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('choice'),
      instructions: DescriptionSchema,
      criteria: jsonRecord(DescriptionSchema.nullable()).refine(
        (criteria) =>
          Object.keys(criteria).length >= 2 &&
          Object.keys(criteria).length <= 255 &&
          Object.keys(criteria).every((key) => key.length > 0),
        'Choice requires 2–255 options',
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal('score'),
      instructions: DescriptionSchema,
      criteria: z.array(DescriptionSchema).min(2).max(10),
    })
    .strict(),
  z
    .object({
      type: z.literal('probability'),
      instructions: DescriptionSchema,
      criteria: z
        .object({ true: DescriptionSchema.optional(), false: DescriptionSchema.optional() })
        .strict()
        .optional(),
    })
    .strict(),
]);

export const DecisionTimeoutSchema = z.number().int().min(1).max(300_000);
export const DecisionSignalSchema = z.instanceof(AbortSignal).optional();
const RequestSchema = z.object({
  state: DescriptionSchema,
  questions: jsonRecord(DecisionJsonSchema.pipe(QuestionSchema)).refine(
    (questions) =>
      Object.keys(questions).length > 0 &&
      Object.keys(questions).length <= 256 &&
      Object.keys(questions).every((key) => key.length > 0),
    'Requests require 1–256 questions',
  ),
  model: z.string().trim().min(1).max(256).optional(),
  timeoutMs: DecisionTimeoutSchema.optional(),
  signal: DecisionSignalSchema,
});

/** Validates and snapshots JSON data before asynchronous transport work. */
export function validateDecisionRequest<Q extends DecisionQuestions>(
  request: DecisionRequest<Q>,
  provider: string,
): DecisionRequest<Q> {
  try {
    const parsed = RequestSchema.safeParse(request);
    if (parsed.success) {
      const { signal: _signal, timeoutMs: _timeout, ...payload } = parsed.data;
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 2 * 1024 * 1024)
        return { ...parsed.data, signal: request.signal } as DecisionRequest<Q>;
    }
  } catch {
    // Cyclic/deep objects are not JSON. Never include caller state in errors.
  }
  throw new DecisionProviderError(provider, 'invalid_request', 'Invalid decision request');
}

export function toSystemOneQuestions(questions: DecisionQuestions): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      { ...question, type: question.type === 'probability' ? 'noul' : question.type },
    ]),
  );
}

const ProbabilitySchema = z.number().finite().min(0).max(1);
const DistributionSchema = jsonRecord(ProbabilitySchema);
const AnswerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: DistributionSchema,
    confidence: ProbabilitySchema,
  }),
  z.object({
    type: z.literal('score'),
    score: z.number().finite(),
    probabilities: DistributionSchema,
    confidence: ProbabilitySchema,
    legend: jsonRecord(DescriptionSchema),
  }),
  z.object({
    type: z.literal('noul'),
    noul: ProbabilitySchema,
    confidence: ProbabilitySchema.optional(),
  }),
]);
const MetadataSchema = z.object({
  model: z.string().trim().min(1).max(512),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().safe(),
    output_tokens: z.number().int().nonnegative().safe(),
  }),
});
const EnvelopeSchema = MetadataSchema.extend({
  answers: jsonRecord(z.unknown()),
  routing: z
    .object({
      model: z.string().min(1).max(256),
      repo: z.string().min(1).max(512),
      reason: z.string().max(2048),
    })
    .optional(),
});

function sameKeys(actual: object, expected: readonly string[]): boolean {
  return (
    Object.keys(actual).length === expected.length &&
    expected.every((key) => Object.hasOwn(actual, key))
  );
}

/** Validates provider wire answers against the original question contract. */
export function parseDecisionResponse<Q extends DecisionQuestions>(
  value: unknown,
  questions: Q,
  provider: string,
): Omit<DecisionResult<Q>, 'cost' | 'costAvailable' | 'latencyMs'> {
  const envelope = EnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    const metadata = MetadataSchema.safeParse(value);
    const usage = metadata.success
      ? {
          inputTokens: metadata.data.usage.input_tokens,
          outputTokens: metadata.data.usage.output_tokens,
          totalTokens: metadata.data.usage.input_tokens + metadata.data.usage.output_tokens,
        }
      : undefined;
    throw new DecisionProviderError(
      provider,
      'invalid_response',
      'Invalid decision response envelope',
      metadata.success && usage && Number.isSafeInteger(usage.totalTokens)
        ? { model: metadata.data.model, usage }
        : {},
    );
  }
  const { model, answers, routing } = envelope.data;
  const usage: DecisionUsage = {
    inputTokens: envelope.data.usage.input_tokens,
    outputTokens: envelope.data.usage.output_tokens,
    totalTokens: envelope.data.usage.input_tokens + envelope.data.usage.output_tokens,
  };
  const invalid = () =>
    new DecisionProviderError(
      provider,
      'invalid_response',
      'Decision answers do not match the question contract',
      { usage, model },
    );
  if (!Number.isSafeInteger(usage.totalTokens) || !sameKeys(answers, Object.keys(questions)))
    throw invalid();
  const entries: [string, unknown][] = [];
  for (const [id, question] of Object.entries(questions)) {
    const parsed = AnswerSchema.safeParse(answers[id]);
    if (!parsed.success) throw invalid();
    const answer = parsed.data;
    if (question.type === 'probability' && answer.type === 'noul') {
      entries.push([
        id,
        {
          type: 'probability',
          probability: answer.noul,
          ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
        },
      ]);
      continue;
    }
    if (answer.type === 'noul' || question.type === 'probability' || answer.type !== question.type)
      throw invalid();
    const keys =
      question.type === 'choice'
        ? Object.keys(question.criteria)
        : question.criteria.map((_, i) => String(i));
    const values = Object.values(answer.probabilities);
    // Laya rounds each value to four decimal places. Tolerance scales with option count.
    const tolerance = Math.max(0.0001, keys.length * 0.000051);
    if (
      !sameKeys(answer.probabilities, keys) ||
      Math.abs(values.reduce((a, b) => a + b, 0) - 1) > tolerance
    )
      throw invalid();
    if (answer.type === 'choice') {
      const chosen = answer.probabilities[answer.choice];
      if (
        !Object.hasOwn(answer.probabilities, answer.choice) ||
        chosen === undefined ||
        chosen + 0.0001 < Math.max(...values)
      )
        throw invalid();
    } else {
      if (answer.score < 0 || answer.score > keys.length - 1 || !sameKeys(answer.legend, keys))
        throw invalid();
      const expected = keys.reduce(
        (sum, key, index) => sum + index * (answer.probabilities[key] ?? 0),
        0,
      );
      // Rounding error is weighted by the ordinal index, plus the score's own rounding.
      const scoreTolerance = 0.000051 * (1 + (keys.length * (keys.length - 1)) / 2);
      if (Math.abs(answer.score - expected) > scoreTolerance) throw invalid();
      if (
        question.type !== 'score' ||
        !keys.every((key, index) => isDeepStrictEqual(answer.legend[key], question.criteria[index]))
      )
        throw invalid();
    }
    entries.push([id, answer]);
  }
  return {
    answers: Object.fromEntries(entries) as DecisionAnswers<Q>,
    provider,
    model,
    usage,
    ...(routing ? { routing } : {}),
  };
}

const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    totalTokens: z.number().int().nonnegative().safe(),
  })
  .refine((usage) => usage.totalTokens === usage.inputTokens + usage.outputTokens);

/** Preserves only valid billing metadata, including when the answers are malformed. */
export const DecisionFailureMetadataSchema = z.object({
  model: z.string().trim().min(1).max(512),
  usage: UsageSchema,
  cost: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});

/** A malformed cost must not discard separately valid model/token metadata. */
export function readDecisionFailureMetadata(value: unknown): {
  model?: string;
  usage?: DecisionUsage;
  cost?: number | null;
} {
  // Errors from custom SDKs may expose throwing accessors. A broken field must
  // neither suppress the ledger row nor discard other valid billing metadata.
  const read = (key: string): unknown => {
    try {
      const parsed = z.object({ [key]: z.unknown() }).safeParse(value);
      return parsed.success ? parsed.data[key] : undefined;
    } catch {
      return undefined;
    }
  };
  const model = z.string().trim().min(1).max(512).safeParse(read('model'));
  const usage = UsageSchema.safeParse(read('usage'));
  const cost = z
    .number()
    .finite()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .safeParse(read('cost'));
  return {
    ...(model.success ? { model: model.data } : {}),
    ...(usage.success ? { usage: usage.data } : {}),
    ...(cost.success ? { cost: read('costAvailable') === false ? null : cost.data } : {}),
  };
}

const PublicResultSchema = DecisionFailureMetadataSchema.extend({
  provider: z.string().min(1).max(256),
  answers: jsonRecord(z.unknown()),
  cost: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  costAvailable: z.boolean(),
  latencyMs: z.number().finite().nonnegative(),
  routing: EnvelopeSchema.shape.routing,
}).refine((result) => result.costAvailable === (result.cost !== null));

const PublicProbabilitySchema = z.object({
  type: z.literal('probability'),
  probability: ProbabilitySchema,
  confidence: ProbabilitySchema.optional(),
});

/** Validates normalized results from any adapter, including custom implementations. */
export function validateDecisionResult<Q extends DecisionQuestions>(
  value: unknown,
  questions: Q,
  provider: string,
): DecisionResult<Q> {
  const metadata = readDecisionFailureMetadata(value);
  const invalid = () =>
    new DecisionProviderError(
      provider,
      'invalid_response',
      'Invalid normalized decision result',
      metadata,
    );
  const parsed = PublicResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.provider !== provider) throw invalid();
  const result = parsed.data;
  const answers = Object.fromEntries(
    Object.entries(result.answers).map(([id, answer]) => {
      if (questions[id]?.type !== 'probability') return [id, answer];
      const probability = PublicProbabilitySchema.safeParse(answer);
      if (!probability.success) throw invalid();
      return [
        id,
        {
          type: 'noul',
          noul: probability.data.probability,
          confidence: probability.data.confidence,
        },
      ];
    }),
  );
  try {
    const normalized = parseDecisionResponse(
      {
        model: result.model,
        usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens },
        answers,
        routing: result.routing,
      },
      questions,
      provider,
    );
    return {
      ...normalized,
      cost: result.cost,
      costAvailable: result.costAvailable,
      latencyMs: result.latencyMs,
    };
  } catch {
    throw invalid();
  }
}
