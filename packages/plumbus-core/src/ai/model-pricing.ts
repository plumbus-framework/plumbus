import { validateTokenUsage } from './usage-validation.js';

// ── Model Pricing Table ──
// Published per-token rates for OpenAI and Anthropic models.
// Rates are in USD per 1 million tokens (MTok).
// Source: https://developers.openai.com/api/docs/pricing
//         https://platform.claude.com/docs/en/about-claude/pricing
// Last updated: 2026-09-10
//
// Unknown models (Ollama, custom endpoints) have no catalog cost.
//
// Only standard-tier rates are tracked (not batch, flex, or fast mode), and for
// models with split short/long context pricing the short-context (base) rate is
// recorded, with an explicit long-context threshold for GPT-5.6 Sol. Sonnet 5 remains $2/$10 (the scheduled increase was cancelled).
//
// `kind` is derived from the pricing page's section structure, not from name
// patterns — see `.agents/skills/update-model-pricing/scripts/fetch-pricing.ts`.

/**
 * Capability classification for a model. Drives the filter on
 * `AIProviderAdapter.listModels({ kind })`.
 *
 * - `text`:       chat / completion / reasoning (called via `complete` / `stream`)
 * - `embedding`:  text-embedding models (called via `embed`)
 * - `moderation`: content-moderation classifiers
 * - `image`:      image generation
 * - `audio`:      speech-to-text / text-to-speech / realtime audio
 * - `decision`:   System One decision models (called via `decide`)
 */
export type Kind = 'text' | 'embedding' | 'moderation' | 'image' | 'audio' | 'decision';

export interface ModelRate {
  /** USD per 1M input tokens */
  inputPerMTok: number;
  /** USD per 1M output tokens (0 for embedding / moderation / free models) */
  outputPerMTok: number;
  /** Published cache-read USD per MTok; defaults to 0.1× input when omitted. */
  cachedInputPerMTok?: number;
  /** Above this inclusive input-token boundary, charge 2× input/cache and 1.5× output. */
  longContextThreshold?: number;
  /**
   * Capability classification. Optional on the type for backward compat —
   * existing consumers that destructure only the rate fields keep working —
   * but every entry in `MODEL_PRICING` populates it.
   */
  kind?: Kind;
}

const MODEL_PRICING: Readonly<Record<string, ModelRate>> = {
  // ── OpenAI: Flagship ──
  'gpt-6-astra': { kind: 'text', inputPerMTok: 10, outputPerMTok: 50 },
  'gpt-5.6-sol': {
    kind: 'text',
    inputPerMTok: 5,
    outputPerMTok: 30,
    cachedInputPerMTok: 0.5,
    longContextThreshold: 272_000,
  },
  'gpt-5.6-terra': { kind: 'text', inputPerMTok: 2, outputPerMTok: 12 },
  'gpt-5.6-luna': { kind: 'text', inputPerMTok: 0.2, outputPerMTok: 1.2 },
  'gpt-5.5': { kind: 'text', inputPerMTok: 5, outputPerMTok: 30 },
  'gpt-5.5-pro': { kind: 'text', inputPerMTok: 30, outputPerMTok: 180 },
  'gpt-5.4': { kind: 'text', inputPerMTok: 2.5, outputPerMTok: 15 },
  'gpt-5.4-mini': { kind: 'text', inputPerMTok: 0.75, outputPerMTok: 4.5 },
  'gpt-5.4-nano': { kind: 'text', inputPerMTok: 0.2, outputPerMTok: 1.25 },
  'gpt-5.4-pro': { kind: 'text', inputPerMTok: 30, outputPerMTok: 180 },
  'gpt-5.2': { kind: 'text', inputPerMTok: 1.75, outputPerMTok: 14 },
  'gpt-5.2-pro': { kind: 'text', inputPerMTok: 21, outputPerMTok: 168 },
  'gpt-5.1': { kind: 'text', inputPerMTok: 1.25, outputPerMTok: 10 },
  'gpt-5': { kind: 'text', inputPerMTok: 1.25, outputPerMTok: 10 },
  'gpt-5-mini': { kind: 'text', inputPerMTok: 0.25, outputPerMTok: 2 },
  'gpt-5-nano': { kind: 'text', inputPerMTok: 0.05, outputPerMTok: 0.4 },
  'gpt-5-pro': { kind: 'text', inputPerMTok: 15, outputPerMTok: 120 },
  'gpt-4.1': { kind: 'text', inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5 },
  'gpt-4.1-mini': { kind: 'text', inputPerMTok: 0.4, outputPerMTok: 1.6, cachedInputPerMTok: 0.1 },
  'gpt-4.1-nano': {
    kind: 'text',
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    cachedInputPerMTok: 0.025,
  },
  'gpt-4o': { kind: 'text', inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 },
  'gpt-4o-2024-05-13': { kind: 'text', inputPerMTok: 5, outputPerMTok: 15 },
  'gpt-4o-mini': {
    kind: 'text',
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cachedInputPerMTok: 0.075,
  },
  // ── OpenAI: Reasoning ──
  o1: { kind: 'text', inputPerMTok: 15, outputPerMTok: 60, cachedInputPerMTok: 7.5 },
  'o1-pro': { kind: 'text', inputPerMTok: 150, outputPerMTok: 600 },
  'o1-mini': { kind: 'text', inputPerMTok: 1.1, outputPerMTok: 4.4 },
  o3: { kind: 'text', inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5 },
  'o3-pro': { kind: 'text', inputPerMTok: 20, outputPerMTok: 80 },
  'o3-mini': { kind: 'text', inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.55 },
  'o4-mini': { kind: 'text', inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.275 },
  // ── OpenAI: Specialized / Deep research / Computer use ──
  'o3-deep-research': { kind: 'text', inputPerMTok: 10, outputPerMTok: 40 },
  'o4-mini-deep-research': { kind: 'text', inputPerMTok: 2, outputPerMTok: 8 },
  'computer-use-preview': { kind: 'text', inputPerMTok: 3, outputPerMTok: 12 },
  // ── OpenAI: Specialized / ChatGPT, Codex, Cyber, Search ──
  'chat-latest': { kind: 'text', inputPerMTok: 5, outputPerMTok: 30 },
  'gpt-5.3-chat-latest': { kind: 'text', inputPerMTok: 1.75, outputPerMTok: 14 },
  'gpt-5.2-chat-latest': { kind: 'text', inputPerMTok: 1.75, outputPerMTok: 14 },
  'gpt-5.3-codex': { kind: 'text', inputPerMTok: 1.75, outputPerMTok: 14 },
  'gpt-5.6-cyber': { kind: 'text', inputPerMTok: 12.5, outputPerMTok: 75 },
  'gpt-5.5-cyber': { kind: 'text', inputPerMTok: 12.5, outputPerMTok: 75 },
  'gpt-5-search-api': { kind: 'text', inputPerMTok: 1.25, outputPerMTok: 10 },
  // ── OpenAI: Embeddings ──
  'text-embedding-3-small': { kind: 'embedding', inputPerMTok: 0.02, outputPerMTok: 0 },
  'text-embedding-3-large': { kind: 'embedding', inputPerMTok: 0.13, outputPerMTok: 0 },
  'text-embedding-ada-002': { kind: 'embedding', inputPerMTok: 0.1, outputPerMTok: 0 },
  // ── OpenAI: Moderation (free) ──
  'omni-moderation-latest': { kind: 'moderation', inputPerMTok: 0, outputPerMTok: 0 },
  'text-moderation-latest': { kind: 'moderation', inputPerMTok: 0, outputPerMTok: 0 },
  // ── OpenAI: Legacy (chat/completion) ──
  'gpt-4-turbo': { kind: 'text', inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-turbo-2024-04-09': { kind: 'text', inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-0125-preview': { kind: 'text', inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-1106-preview': { kind: 'text', inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-1106-vision-preview': { kind: 'text', inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-0613': { kind: 'text', inputPerMTok: 30, outputPerMTok: 60 },
  'gpt-4-0314': { kind: 'text', inputPerMTok: 30, outputPerMTok: 60 },
  'gpt-4': { kind: 'text', inputPerMTok: 30, outputPerMTok: 60 },
  'gpt-4-32k': { kind: 'text', inputPerMTok: 60, outputPerMTok: 120 },
  'gpt-3.5-turbo': { kind: 'text', inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'gpt-3.5-turbo-0125': { kind: 'text', inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'gpt-3.5-turbo-1106': { kind: 'text', inputPerMTok: 1, outputPerMTok: 2 },
  'gpt-3.5-turbo-0613': { kind: 'text', inputPerMTok: 1.5, outputPerMTok: 2 },
  'gpt-3.5-0301': { kind: 'text', inputPerMTok: 1.5, outputPerMTok: 2 },
  'gpt-3.5-turbo-instruct': { kind: 'text', inputPerMTok: 1.5, outputPerMTok: 2 },
  'gpt-3.5-turbo-16k-0613': { kind: 'text', inputPerMTok: 3, outputPerMTok: 4 },
  'davinci-002': { kind: 'text', inputPerMTok: 2, outputPerMTok: 2 },
  'babbage-002': { kind: 'text', inputPerMTok: 0.4, outputPerMTok: 0.4 },

  // ── Anthropic: Claude (all text — no embedding API) ──
  'claude-fable-5-1': {
    kind: 'text',
    inputPerMTok: 10,
    outputPerMTok: 50,
    cachedInputPerMTok: 0.25,
  },
  'claude-fable-5': { kind: 'text', inputPerMTok: 10, outputPerMTok: 50 },
  'claude-mythos-5-1': {
    kind: 'text',
    inputPerMTok: 10,
    outputPerMTok: 50,
    cachedInputPerMTok: 0.25,
  },
  'claude-mythos-5': { kind: 'text', inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-5': { kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-1': { kind: 'text', inputPerMTok: 15, outputPerMTok: 75 },
  'claude-opus-4': { kind: 'text', inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-5': { kind: 'text', inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { kind: 'text', inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5': { kind: 'text', inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4': { kind: 'text', inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-7-sonnet': { kind: 'text', inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-5-sonnet': { kind: 'text', inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { kind: 'text', inputPerMTok: 1, outputPerMTok: 5 },
  'claude-3-5-haiku': { kind: 'text', inputPerMTok: 0.8, outputPerMTok: 4 },
  'claude-3-opus': { kind: 'text', inputPerMTok: 15, outputPerMTok: 75 },
  'claude-3-haiku': { kind: 'text', inputPerMTok: 0.25, outputPerMTok: 1.25 },

  // ── TypeSafe: Jev (decision models — no chat, no embedding API) ──
  // Published as $42 per Btok (billion tokens) of input, which is
  // $0.042 per MTok. Output tokens are free.
  // Source: https://docs.typesafe.ai/models
  // `@plumbus/ai-typesafe` also returns an explicit `cost`, which wins over
  // these rates; they exist so budget estimation and `listModels` still work
  // without the add-on installed.
  'jev-1.13.0': { kind: 'decision', inputPerMTok: 0.042, outputPerMTok: 0 },
  'jev-1.13': { kind: 'decision', inputPerMTok: 0.042, outputPerMTok: 0 },
  'jev-latest': { kind: 'decision', inputPerMTok: 0.042, outputPerMTok: 0 },
  'jev-preview': { kind: 'decision', inputPerMTok: 0.042, outputPerMTok: 0 },
};

// OpenAI guarantees the special price at least through November 21, 2026.
// November 22 UTC is our static fallback policy, not a confirmed vendor expiry.
// Source: https://developers.openai.com/api/docs/models/gpt-5.6-sol
const SOL_SPECIAL_PRICE_END = Date.parse('2026-11-22T00:00:00.000Z');

function effectiveRate(id: string, rate: ModelRate, now: number): ModelRate {
  if (id === 'gpt-5.6-sol' && now < SOL_SPECIAL_PRICE_END) {
    return { ...rate, inputPerMTok: 4, cachedInputPerMTok: 0.4, outputPerMTok: 20 };
  }
  return rate;
}

/**
 * Finds the per-token rate for a model.
 * Tries exact match first, then strips trailing date suffixes
 * (e.g. "claude-sonnet-4-20250514" → "claude-sonnet-4").
 * Returns null for unknown/unsupported models (Ollama, custom).
 */
export function findModelRate(model: string): ModelRate | null {
  const canonical = model === 'gpt-5.6' ? 'gpt-5.6-sol' : model;
  if (Object.hasOwn(MODEL_PRICING, canonical)) {
    const rate = MODEL_PRICING[canonical];
    return rate ? effectiveRate(canonical, rate, Date.now()) : null;
  }

  // Strip trailing date suffix (e.g. "-20250514")
  const withoutDate = model.replace(/-\d{8}$/, '');
  if (withoutDate !== model) {
    const canonicalWithoutDate = withoutDate === 'gpt-5.6' ? 'gpt-5.6-sol' : withoutDate;
    if (Object.hasOwn(MODEL_PRICING, canonicalWithoutDate)) {
      const rate = MODEL_PRICING[canonicalWithoutDate];
      return rate ? effectiveRate(canonicalWithoutDate, rate, Date.now()) : null;
    }
  }

  return null;
}

/**
 * Return all known model rates as an array of `[id, rate]` tuples. Used by
 * `AIProviderAdapter.listModels()` to join live model ids against the pricing
 * catalog. Order is not guaranteed.
 */
export function allKnownModels(): ReadonlyArray<readonly [string, ModelRate]> {
  const now = Date.now();
  return Object.entries(MODEL_PRICING).map(([id, rate]) => [id, effectiveRate(id, rate, now)]);
}

/** Models subject to Anthropic's long context premium (>200K input tokens). */
const LONG_CONTEXT_PREMIUM_MODELS = new Set(['claude-sonnet-4', 'claude-sonnet-4-5']);

/** Check if a model (after date-stripping) qualifies for long context premium. */
function hasLongContextPremium(model: string): boolean {
  if (LONG_CONTEXT_PREMIUM_MODELS.has(model)) return true;
  const withoutDate = model.replace(/-\d{8}$/, '');
  return withoutDate !== model && LONG_CONTEXT_PREMIUM_MODELS.has(withoutDate);
}

/** Legacy numeric cost helper. Use estimateModelCost when unknown must differ from free. */
export function calculateModelCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  options?: { cachedInputTokens?: number; cacheWriteTokens?: number },
): number {
  return estimateModelCost(inputTokens, outputTokens, model, options) ?? 0;
}

/**
 * Calculate the USD cost for a single AI request based on published per-token rates.
 *
 * Pricing adjustments applied:
 * - **Cached input tokens**: published per-model rate, defaulting to 0.1× input.
 * - **Cache write tokens**: charged at 1.25× the base input rate (Anthropic 5-min cache).
 * - **Long context premium**: for Claude Sonnet 4 / 4.5, when total input exceeds
 *   200K tokens, or GPT-5.6 Sol over 272K, charge 2× input/cache and 1.5× output.
 *
 * Returns undefined for unknown/unsupported models; explicitly free adapters may report zero.
 */
export function estimateModelCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  options?: {
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  },
): number | undefined {
  validateTokenUsage({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...options,
  });
  const rate = findModelRate(model);
  if (!rate) return undefined;

  const cached = options?.cachedInputTokens ?? 0;
  const cacheWrites = options?.cacheWriteTokens ?? 0;

  let inputRate = rate.inputPerMTok;
  let outputRate = rate.outputPerMTok;
  let cachedInputRate = rate.cachedInputPerMTok ?? rate.inputPerMTok * 0.1;

  // Model-specific long context premium; input includes cache reads and writes.
  const totalInput = inputTokens; // Normalized input already includes cache reads and writes.
  const longContextThreshold =
    rate.longContextThreshold ?? (hasLongContextPremium(model) ? 200_000 : undefined);
  if (longContextThreshold != null && totalInput > longContextThreshold) {
    inputRate *= 2;
    cachedInputRate *= 2;
    outputRate *= 1.5;
  }

  // Standard (non-cached) input tokens
  const standardInput = inputTokens - cached - cacheWrites;
  const standardInputCost = Math.max(0, standardInput) * inputRate;

  // Use the published cache-read rate where it differs from the default.
  const cachedCost = cached * cachedInputRate;

  // Cache writes: 1.25× base input rate (five-minute cache pricing).
  const cacheWriteCost = cacheWrites * inputRate * 1.25;

  // Output tokens at standard (or long-context-premium) rate
  const outputCost = outputTokens * outputRate;

  const cost = (standardInputCost + cachedCost + cacheWriteCost + outputCost) / 1_000_000;
  return Number(cost.toPrecision(15));
}
