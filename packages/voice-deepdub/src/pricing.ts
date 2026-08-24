import type { VoicePricingEntry } from '@plumbus/voice';

/**
 * Deepdub bills by **minutes of generated audio** against a contract-specific
 * monthly allotment (the vendor's own conversion: ~1,000 characters ≈ 1 minute
 * of speech). There is no public per-minute rate card — the effective rate
 * depends on the customer's contract — so the rate is env-driven:
 * `DEEPDUB_USD_PER_MINUTE`. The default is the effective rate of the smallest
 * published AI-agents tier ($300/mo for 2.1M credits ≈ 2,100 minutes ≈ $0.143/min);
 * deployments should set their real contract rate.
 */
export const DEFAULT_DEEPDUB_USD_PER_MINUTE = 0.143;

export function resolveDeepdubUsdPerMinute(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.DEEPDUB_USD_PER_MINUTE;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_DEEPDUB_USD_PER_MINUTE;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[voice-pricing] ignoring invalid DEEPDUB_USD_PER_MINUTE=${JSON.stringify(raw)} — using default ${DEFAULT_DEEPDUB_USD_PER_MINUTE}`,
    );
    return DEFAULT_DEEPDUB_USD_PER_MINUTE;
  }
  return parsed;
}

export const DEEPDUB_VOICE_PRICING: VoicePricingEntry = {
  model: 'deepdub-phantom-x',
  operation: 'synthesize',
  unit: 'audioOutputSeconds',
  // Resolved per lookup so DEEPDUB_USD_PER_MINUTE applies whenever it is set,
  // regardless of import/registration order.
  get usdPerUnit() {
    return resolveDeepdubUsdPerMinute() / 60;
  },
};
