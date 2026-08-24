import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEEPDUB_USD_PER_MINUTE,
  DEEPDUB_VOICE_PRICING,
  resolveDeepdubUsdPerMinute,
} from '../pricing.js';

describe('Deepdub voice pricing', () => {
  it('bills per minute of generated audio, like the vendor', () => {
    expect(DEEPDUB_VOICE_PRICING.unit).toBe('audioOutputSeconds');
    expect(DEEPDUB_VOICE_PRICING.operation).toBe('synthesize');
  });

  it('defaults to the smallest published tier effective rate', () => {
    expect(resolveDeepdubUsdPerMinute({})).toBe(DEFAULT_DEEPDUB_USD_PER_MINUTE);
    expect(DEEPDUB_VOICE_PRICING.usdPerUnit).toBeCloseTo(DEFAULT_DEEPDUB_USD_PER_MINUTE / 60, 8);
  });

  it('honors DEEPDUB_USD_PER_MINUTE for contract-specific rates', () => {
    expect(resolveDeepdubUsdPerMinute({ DEEPDUB_USD_PER_MINUTE: '0.09' })).toBe(0.09);
  });

  it('applies the env rate through the registered pricing entry itself', () => {
    // The pricing entry must resolve the env var per lookup — a static rate
    // baked at registration would ignore the deployment's contract rate.
    const saved = process.env.DEEPDUB_USD_PER_MINUTE;
    process.env.DEEPDUB_USD_PER_MINUTE = '0.21';
    try {
      expect(DEEPDUB_VOICE_PRICING.usdPerUnit).toBeCloseTo(0.21 / 60, 8);
    } finally {
      if (saved === undefined) {
        delete process.env.DEEPDUB_USD_PER_MINUTE;
      } else {
        process.env.DEEPDUB_USD_PER_MINUTE = saved;
      }
    }
  });

  it('ignores invalid env values and falls back to the default', () => {
    expect(resolveDeepdubUsdPerMinute({ DEEPDUB_USD_PER_MINUTE: 'abc' })).toBe(
      DEFAULT_DEEPDUB_USD_PER_MINUTE,
    );
    expect(resolveDeepdubUsdPerMinute({ DEEPDUB_USD_PER_MINUTE: '-3' })).toBe(
      DEFAULT_DEEPDUB_USD_PER_MINUTE,
    );
    expect(resolveDeepdubUsdPerMinute({ DEEPDUB_USD_PER_MINUTE: '  ' })).toBe(
      DEFAULT_DEEPDUB_USD_PER_MINUTE,
    );
  });
});
