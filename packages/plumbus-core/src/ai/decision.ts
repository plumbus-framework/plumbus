// ── Decision Primitive ──
// Typed decisions: send a `state` plus a map of named questions, get one
// typed answer per question back with calibrated probabilities.
//
// This is a separate provider surface from `AIProviderAdapter`. A decision
// model has no chat turns, no streaming, and no embeddings — it evaluates a
// state against questions in a single round trip. Mapping it onto
// `complete()` would force callers back into free-text parsing, which is the
// exact thing the primitive exists to remove.
//
// Used by `ctx.ai.decide` in capability handlers. Implemented by add-on
// packages such as `@plumbus/ai-typesafe` (TypeSafe Jev).

import type { TokenUsage } from './provider.js';

// ── Instructions ──
/**
 * What the model should evaluate.
 *
 * A plain string is the common case. An object or array lets a question carry
 * the data it refers to in sibling fields — put the question in one field and
 * reference the others by name in backticks, e.g.
 *
 * ```ts
 * {
 *   potential_duplicate: { name: 'John Smith', location: 'Oakland, California' },
 *   question: 'Is the resume for the same person as `potential_duplicate`?',
 * }
 * ```
 */
export type DecisionInstructions = string | Readonly<Record<string, unknown>> | readonly unknown[];

// ── Question Types ──

/** Optional descriptions of what a yes and a no mean for a {@link NoulQuestion}. */
export interface NoulCriteria {
  /** What a yes (value near 1) means. */
  true?: string;
  /** What a no (value near 0) means. */
  false?: string;
}

/** A yes/no question. The answer is the probability that the answer is yes. */
export interface NoulQuestion {
  type: 'noul';
  instructions: DecisionInstructions;
  criteria?: NoulCriteria;
}

/**
 * Picks one option from a set you define. `criteria` maps each option to a
 * rubric description; use `null` when an option needs no extra detail.
 */
export interface ChoiceQuestion<TOption extends string = string> {
  type: 'choice';
  instructions: DecisionInstructions;
  criteria: Readonly<Record<TOption, string | null>>;
}

/**
 * Rates the state along an ordered rubric. `criteria` is an ordered array of
 * level descriptions, lowest level first.
 */
export interface ScoreQuestion<TLevels extends readonly string[] = readonly string[]> {
  type: 'score';
  instructions: DecisionInstructions;
  criteria: TLevels;
}

/** Any question a decision provider accepts. */
export type DecisionQuestion =
  | NoulQuestion
  | ChoiceQuestion<string>
  | ScoreQuestion<readonly string[]>;

/**
 * A map of named questions. You choose the keys; answers come back under the
 * same keys. Keys are not sent to the model and play no part in inference.
 */
export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;

// ── Answer Types ──

/** The yes/no answer, on a scale from 0 (no) to 1 (yes). */
export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

/** The highest-probability option, the full distribution, and confidence. */
export interface ChoiceAnswer<TOption extends string = string> {
  type: 'choice';
  choice: TOption;
  /** Every option mapped to its probability. Sums to 1. */
  probabilities: Readonly<Record<TOption, number>>;
  /** How certain the model is, derived from the distribution. 0 to 1. */
  confidence: number;
}

/** The probability-weighted answer across the levels; can land between them. */
export interface ScoreAnswer {
  type: 'score';
  score: number;
  /** Each level index, as a string key, mapped back to its description. */
  legend: Readonly<Record<string, string>>;
  /** Each level index, as a string key, mapped to its probability. Sums to 1. */
  probabilities: Readonly<Record<string, number>>;
  /** How certain the model is, derived from the distribution. 0 to 1. */
  confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer<string> | ScoreAnswer;

/** The answer variant a given question type produces. */
export type AnswerFor<TQuestion> = TQuestion extends { type: 'noul' }
  ? NoulAnswer
  : TQuestion extends {
        type: 'choice';
        criteria: Readonly<Record<infer TOption extends string, string | null>>;
      }
    ? ChoiceAnswer<TOption>
    : TQuestion extends { type: 'score' }
      ? ScoreAnswer
      : DecisionAnswer;

/** One answer per question, keyed by the same ids the questions used. */
export type AnswersFor<TQuestions extends DecisionQuestions> = {
  [K in keyof TQuestions]: AnswerFor<TQuestions[K]>;
};

// ── Question Builders ──
// Mirror the ergonomics of provider SDKs so `answers[key]` narrows to the
// matching answer variant without a manual type argument.

/** Build a yes/no question. */
export function noul(instructions: DecisionInstructions, criteria?: NoulCriteria): NoulQuestion {
  return criteria === undefined
    ? { type: 'noul', instructions }
    : { type: 'noul', instructions, criteria };
}

/** Build a single-select question from an option → rubric map. */
export function choice<const TCriteria extends Record<string, string | null>>(
  instructions: DecisionInstructions,
  criteria: TCriteria,
): ChoiceQuestion<Extract<keyof TCriteria, string>> {
  return { type: 'choice', instructions, criteria } as ChoiceQuestion<
    Extract<keyof TCriteria, string>
  >;
}

/** Build a rubric question from an ordered array of level descriptions. */
export function score<const TLevels extends readonly string[]>(
  instructions: DecisionInstructions,
  criteria: TLevels,
): ScoreQuestion<TLevels> {
  return { type: 'score', instructions, criteria };
}

// ── Provider Limits ──

/**
 * Structural limits every known decision model shares. Enforced at
 * `defineDecision()` time and again before network I/O, so a malformed
 * question fails locally with a named field instead of as a provider 422.
 */
export const DECISION_LIMITS = {
  /** Maximum options in a single Choice question. */
  maxChoiceOptions: 255,
  /** A Score needs at least this many levels to be meaningful. */
  minScoreLevels: 2,
  /** Maximum levels the wire format accepts for a Score. */
  maxScoreLevels: 10,
} as const;

/**
 * Per-provider structural and budget limits. Optional for backward compat
 * with external adapters: an adapter that omits this is treated as declaring
 * only the shared {@link DECISION_LIMITS}.
 */
export interface DecisionProviderCapabilities {
  /** Options accepted in one Choice question. Defaults to 255. */
  maxChoiceOptions?: number;
  /** Inclusive bounds on Score levels. Defaults to 2–10. */
  scoreLevels?: { min: number; max: number };
  /** Token budget for `state` plus every question in one request. */
  maxRequestTokens?: number;
  /** Token budget for `state` plus the single longest question. */
  maxStateTokens?: number;
}

/**
 * Validate a question map against the shared limits and any tighter
 * provider-declared ones. Throws with the offending question id so the caller
 * can fix the definition rather than decode a provider error body.
 */
export function validateDecisionQuestions(
  questions: DecisionQuestions,
  capabilities?: DecisionProviderCapabilities,
): void {
  const entries = Object.entries(questions);
  if (entries.length === 0) {
    throw new Error('Decision requires at least one question');
  }

  const maxOptions = capabilities?.maxChoiceOptions ?? DECISION_LIMITS.maxChoiceOptions;
  const minLevels = capabilities?.scoreLevels?.min ?? DECISION_LIMITS.minScoreLevels;
  const maxLevels = capabilities?.scoreLevels?.max ?? DECISION_LIMITS.maxScoreLevels;

  for (const [id, question] of entries) {
    if (question.instructions == null || question.instructions === '') {
      throw new Error(`Decision question "${id}": instructions are required`);
    }

    if (question.type === 'choice') {
      const options = Object.keys(question.criteria);
      if (options.length < 2) {
        throw new Error(
          `Decision question "${id}": a choice needs at least 2 options, got ${options.length}`,
        );
      }
      if (options.length > maxOptions) {
        throw new Error(
          `Decision question "${id}": a choice accepts at most ${maxOptions} options, got ${options.length}`,
        );
      }
      continue;
    }

    if (question.type === 'score') {
      const levels = question.criteria.length;
      if (levels < minLevels || levels > maxLevels) {
        throw new Error(
          `Decision question "${id}": a score needs between ${minLevels} and ${maxLevels} levels, got ${levels}`,
        );
      }
    }
  }
}

// ── Provider Adapter ──

export interface DecisionRequest {
  /**
   * The content to evaluate. A plain string for text, or structured data
   * (object/array) for chat logs, records, or application state. The state is
   * ingested once and every question is evaluated against it in parallel.
   */
  state: unknown;
  /** Model or alias that should handle the request. */
  model?: string;
  questions: DecisionQuestions;
  /** Abort the in-flight HTTP request when this signal fires. */
  signal?: AbortSignal;
}

export interface DecisionResponse {
  /** The versioned model id that actually answered (aliases resolve here). */
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: TokenUsage;
  /**
   * Adapter-computed USD cost. Set it when the provider's rates are owned by
   * the add-on package rather than core's `MODEL_PRICING` catalog.
   */
  cost?: number;
}

/** One entry from a decision provider's model list. */
export interface DecisionModel {
  /** Model id or alias, as accepted by `DecisionRequest.model`. */
  name: string;
  description?: string;
  releaseDate?: string;
}

/**
 * A decision provider. Implemented by add-on packages and registered through
 * `AIServiceConfig.decisionProviders`.
 */
export interface DecisionProviderAdapter {
  readonly name: string;

  /**
   * Declared provider limits. Optional for backward compat with external
   * adapters: callers treat an adapter that omits this as declaring only the
   * shared {@link DECISION_LIMITS}.
   */
  readonly capabilities?: DecisionProviderCapabilities;

  /** Evaluate `state` against every question in one round trip. */
  decide(request: DecisionRequest): Promise<DecisionResponse>;

  /**
   * List the models this account can send in `DecisionRequest.model`.
   * Optional — adapters that don't implement it still satisfy the interface.
   * On network error or an unsupported endpoint, return `[]` rather than
   * throwing, mirroring `AIProviderAdapter.listModels`.
   */
  listModels?(): Promise<DecisionModel[]>;
}
