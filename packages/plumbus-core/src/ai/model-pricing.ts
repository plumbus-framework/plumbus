// ── Model Pricing Table ──
// Published per-token rates for OpenAI and Anthropic models.
// Rates are in USD per 1 million tokens (MTok).
// Source: https://developers.openai.com/api/docs/pricing
//         https://platform.claude.com/docs/en/about-claude/pricing
// Last updated: 2026-03-29
//
// Unknown models (Ollama, custom endpoints) return cost $0.

export interface ModelRate {
  /** USD per 1M input tokens */
  inputPerMTok: number;
  /** USD per 1M output tokens */
  outputPerMTok: number;
}

const MODEL_PRICING: Readonly<Record<string, ModelRate>> = {
  // ── OpenAI: Flagship ──
  'gpt-5.4': { inputPerMTok: 2.5, outputPerMTok: 15 },
  'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5 },
  'gpt-5.4-nano': { inputPerMTok: 0.2, outputPerMTok: 1.25 },
  'gpt-5.4-pro': { inputPerMTok: 30, outputPerMTok: 180 },
  'gpt-5.2': { inputPerMTok: 1.75, outputPerMTok: 14 },
  'gpt-5.2-pro': { inputPerMTok: 21, outputPerMTok: 168 },
  'gpt-5.1': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2 },
  'gpt-5-nano': { inputPerMTok: 0.05, outputPerMTok: 0.4 },
  'gpt-5-pro': { inputPerMTok: 15, outputPerMTok: 120 },
  'gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 },
  'gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  'gpt-4.1-nano': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'gpt-4o-2024-05-13': { inputPerMTok: 5, outputPerMTok: 15 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  // ── OpenAI: Reasoning ──
  o1: { inputPerMTok: 15, outputPerMTok: 60 },
  'o1-pro': { inputPerMTok: 150, outputPerMTok: 600 },
  'o1-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  o3: { inputPerMTok: 2, outputPerMTok: 8 },
  'o3-pro': { inputPerMTok: 20, outputPerMTok: 80 },
  'o3-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  'o4-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  // ── OpenAI: Legacy ──
  'gpt-4-turbo': { inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-turbo-2024-04-09': { inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-0125-preview': { inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-1106-preview': { inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-1106-vision-preview': { inputPerMTok: 10, outputPerMTok: 30 },
  'gpt-4-0613': { inputPerMTok: 30, outputPerMTok: 60 },
  'gpt-4-0314': { inputPerMTok: 30, outputPerMTok: 60 },
  'gpt-4': { inputPerMTok: 30, outputPerMTok: 60 },
  'gpt-4-32k': { inputPerMTok: 60, outputPerMTok: 120 },
  'gpt-3.5-turbo': { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'gpt-3.5-turbo-0125': { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  'gpt-3.5-turbo-1106': { inputPerMTok: 1, outputPerMTok: 2 },
  'gpt-3.5-turbo-0613': { inputPerMTok: 1.5, outputPerMTok: 2 },
  'gpt-3.5-0301': { inputPerMTok: 1.5, outputPerMTok: 2 },
  'gpt-3.5-turbo-instruct': { inputPerMTok: 1.5, outputPerMTok: 2 },
  'gpt-3.5-turbo-16k-0613': { inputPerMTok: 3, outputPerMTok: 4 },

  // ── Anthropic: Claude ──
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-7-sonnet': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-5-sonnet': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4 },
  'claude-3-opus': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-3-haiku': { inputPerMTok: 0.25, outputPerMTok: 1.25 },
};

/**
 * Finds the per-token rate for a model.
 * Tries exact match first, then strips trailing date suffixes
 * (e.g. "claude-sonnet-4-20250514" → "claude-sonnet-4").
 * Returns null for unknown/unsupported models (Ollama, custom).
 */
export function findModelRate(model: string): ModelRate | null {
  const exact = MODEL_PRICING[model];
  if (exact) return exact;

  // Strip trailing date suffix (e.g. "-20250514")
  const withoutDate = model.replace(/-\d{8}$/, '');
  if (withoutDate !== model) {
    const stripped = MODEL_PRICING[withoutDate];
    if (stripped) return stripped;
  }

  return null;
}

/** Models subject to Anthropic's long context premium (>200K input tokens). */
const LONG_CONTEXT_PREMIUM_MODELS = new Set(['claude-sonnet-4', 'claude-sonnet-4-5']);

/** Check if a model (after date-stripping) qualifies for long context premium. */
function hasLongContextPremium(model: string): boolean {
  if (LONG_CONTEXT_PREMIUM_MODELS.has(model)) return true;
  const withoutDate = model.replace(/-\d{8}$/, '');
  return withoutDate !== model && LONG_CONTEXT_PREMIUM_MODELS.has(withoutDate);
}

/**
 * Calculate the USD cost for a single AI request based on published per-token rates.
 *
 * Pricing adjustments applied:
 * - **Cached input tokens**: charged at 0.1× the base input rate (both providers).
 * - **Cache write tokens**: charged at 1.25× the base input rate (Anthropic 5-min cache).
 * - **Long context premium**: for Claude Sonnet 4 / 4.5, when total input exceeds
 *   200K tokens the entire request is charged at 2× input / 1.5× output.
 *
 * Returns 0 for unknown/unsupported models (Ollama, custom endpoints).
 */
export function calculateModelCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  options?: {
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  },
): number {
  const rate = findModelRate(model);
  if (!rate) return 0;

  const cached = options?.cachedInputTokens ?? 0;
  const cacheWrites = options?.cacheWriteTokens ?? 0;

  let inputRate = rate.inputPerMTok;
  let outputRate = rate.outputPerMTok;

  // Long context premium: Sonnet 4/4.5 with >200K total input tokens
  const totalInput = inputTokens + cached + cacheWrites;
  if (hasLongContextPremium(model) && totalInput > 200_000) {
    inputRate *= 2;
    outputRate *= 1.5;
  }

  // Standard (non-cached) input tokens
  const standardInput = inputTokens - cached - cacheWrites;
  const standardInputCost = Math.max(0, standardInput) * inputRate;

  // Cached reads: 0.1× base input rate
  const cachedCost = cached * inputRate * 0.1;

  // Cache writes: 1.25× base input rate (Anthropic); OpenAI doesn't report these
  const cacheWriteCost = cacheWrites * inputRate * 1.25;

  // Output tokens at standard (or long-context-premium) rate
  const outputCost = outputTokens * outputRate;

  const cost = (standardInputCost + cachedCost + cacheWriteCost + outputCost) / 1_000_000;
  return Number(cost.toFixed(6));
}
