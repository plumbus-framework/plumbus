import { z } from '@plumbus/core/zod';
import { DecisionProviderError } from './errors/index.js';
import type {
  DecisionAnswers,
  DecisionJson,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
  DecisionUsage,
} from './types.js';

const JsonSchema: z.ZodType<DecisionJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonSchema),
    z.record(JsonSchema),
  ]),
);
const DescriptionSchema = z.union([z.string(), z.array(JsonSchema), z.record(JsonSchema)]);
const QuestionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('choice'),
      instructions: DescriptionSchema,
      criteria: z
        .record(z.string().min(1), DescriptionSchema.nullable())
        .refine(
          (criteria) => Object.keys(criteria).length >= 2 && Object.keys(criteria).length <= 255,
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
const RequestSchema = z.object({
  state: DescriptionSchema,
  questions: z
    .record(z.string().min(1), QuestionSchema)
    .refine(
      (questions) => Object.keys(questions).length > 0 && Object.keys(questions).length <= 256,
      'Requests require 1–256 questions',
    ),
  model: z.string().trim().min(1).max(256).optional(),
  timeoutMs: DecisionTimeoutSchema.optional(),
});

/** Validates and snapshots JSON data before asynchronous transport work. */
export function validateDecisionRequest<Q extends DecisionQuestions>(
  request: DecisionRequest<Q>,
  provider: string,
): DecisionRequest<Q> {
  try {
    const parsed = RequestSchema.safeParse(request);
    if (parsed.success) return { ...parsed.data, signal: request.signal } as DecisionRequest<Q>;
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
const DistributionSchema = z.record(ProbabilitySchema);
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
    legend: z.record(DescriptionSchema),
  }),
  z.object({
    type: z.literal('noul'),
    noul: ProbabilitySchema,
    confidence: ProbabilitySchema.optional(),
  }),
]);
const EnvelopeSchema = z.object({
  model: z.string().min(1).max(512),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().safe(),
    output_tokens: z.number().int().nonnegative().safe(),
  }),
  answers: z.record(z.unknown()),
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
    throw new DecisionProviderError(
      provider,
      'invalid_response',
      'Invalid decision response envelope',
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
      if (chosen === undefined || chosen + 0.0001 < Math.max(...values)) throw invalid();
    } else {
      if (answer.score < 0 || answer.score > keys.length - 1 || !sameKeys(answer.legend, keys))
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
