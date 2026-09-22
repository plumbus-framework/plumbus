// ── Jev Pricing ──
// Package-owned rates, on the same principle as `@plumbus/ai-bedrock`: the
// vendor publishes them, so the adapter computes `cost` and the framework does
// not have to keep a decision-model catalog in sync.
//
// Jev is charged per input token only; output tokens are free. Published as
// $42 per Btok (billion tokens), which is $0.042 per MTok.
// Source: https://docs.typesafe.ai/models
// Last updated: 2026-09-22

/** USD per 1M input tokens, by model or alias. */
const JEV_INPUT_PER_MTOK: Readonly<Record<string, number>> = {
  'jev-1.13.0': 0.042,
  'jev-1.13': 0.042,
  'jev-latest': 0.042,
  'jev-preview': 0.042,
};

/** Every `jev-*` release shares one rate today, so unknown versions use it. */
const JEV_DEFAULT_INPUT_PER_MTOK = 0.042;

/**
 * USD per 1M input tokens for a model id or alias, or `null` for a name that
 * is not a Jev model at all.
 */
export function findJevInputRate(model: string): number | null {
  const exact = JEV_INPUT_PER_MTOK[model];
  if (exact != null) return exact;
  // A version we have not seen yet (e.g. jev-1.14.0) still bills as a Jev
  // model. Guessing the shared rate beats reporting no cost at all.
  return model.startsWith('jev-') ? JEV_DEFAULT_INPUT_PER_MTOK : null;
}

/**
 * USD cost for a call. Returns `undefined` for a non-Jev model so the caller
 * falls back to core's pricing catalog rather than recording a wrong zero.
 */
export function calculateJevCost(model: string, inputTokens: number): number | undefined {
  const rate = findJevInputRate(model);
  if (rate == null) return undefined;
  return (inputTokens / 1_000_000) * rate;
}
