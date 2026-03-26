import { describe, expect, it } from 'vitest';
import { calculateModelCost } from '../model-pricing.js';

describe('calculateModelCost', () => {
  it('returns 0 for unknown models', () => {
    expect(calculateModelCost(1000, 500, 'gpt-oss:20b')).toBe(0);
    expect(calculateModelCost(1000, 500, 'llama-3')).toBe(0);
  });

  it('calculates standard cost for known models', () => {
    // gpt-4o: input $2.5/MTok, output $10/MTok
    // 1000 input × 2.5 + 500 output × 10 = 2500 + 5000 = 7500 / 1M = 0.0075
    expect(calculateModelCost(1000, 500, 'gpt-4o')).toBe(0.0075);
  });

  it('resolves date-suffixed model names', () => {
    // claude-sonnet-4-20250514 → claude-sonnet-4
    const cost = calculateModelCost(1000, 500, 'claude-sonnet-4-20250514');
    const costWithoutDate = calculateModelCost(1000, 500, 'claude-sonnet-4');
    expect(cost).toBe(costWithoutDate);
    expect(cost).toBeGreaterThan(0);
  });

  describe('cached input tokens', () => {
    it('charges cached tokens at 0.1× base input rate', () => {
      // gpt-4o: input $2.5/MTok
      // 1000 total input, 600 cached, 400 standard
      // Standard: 400 × 2.5 = 1000
      // Cached:   600 × 2.5 × 0.1 = 150
      // Output:   500 × 10 = 5000
      // Total = 6150 / 1M = 0.00615
      const cost = calculateModelCost(1000, 500, 'gpt-4o', {
        cachedInputTokens: 600,
      });
      expect(cost).toBe(0.00615);
    });

    it('is cheaper than all-standard input', () => {
      const standardCost = calculateModelCost(10000, 1000, 'gpt-4o');
      const cachedCost = calculateModelCost(10000, 1000, 'gpt-4o', {
        cachedInputTokens: 8000,
      });
      expect(cachedCost).toBeLessThan(standardCost);
    });
  });

  describe('cache write tokens (Anthropic)', () => {
    it('charges cache writes at 1.25× base input rate', () => {
      // claude-sonnet-4: input $3/MTok
      // 1000 total input, 500 cache-writes, 500 standard
      // Standard:    500 × 3 = 1500
      // Cache write: 500 × 3 × 1.25 = 1875
      // Output:      200 × 15 = 3000
      // Total = 6375 / 1M = 0.006375
      const cost = calculateModelCost(1000, 200, 'claude-sonnet-4', {
        cacheWriteTokens: 500,
      });
      expect(cost).toBe(0.006375);
    });
  });

  describe('long context premium', () => {
    it('applies 2× input / 1.5× output for Sonnet 4 over 200K input', () => {
      // claude-sonnet-4: base input $3/MTok, output $15/MTok
      // 250K input tokens (over 200K threshold)
      // Premium: input $6/MTok, output $22.5/MTok
      // 250000 × 6 + 10000 × 22.5 = 1_500_000 + 225_000 = 1_725_000 / 1M = 1.725
      const cost = calculateModelCost(250_000, 10_000, 'claude-sonnet-4');
      expect(cost).toBe(1.725);
    });

    it('applies premium for Sonnet 4.5 with date suffix', () => {
      const cost = calculateModelCost(250_000, 10_000, 'claude-sonnet-4-5-20250514');
      const costNoDate = calculateModelCost(250_000, 10_000, 'claude-sonnet-4-5');
      expect(cost).toBe(costNoDate);
      expect(cost).toBeGreaterThan(0);
    });

    it('does NOT apply premium below 200K tokens', () => {
      // 199K tokens — no premium
      const costBelow = calculateModelCost(199_000, 10_000, 'claude-sonnet-4');
      // base rates: 199000 × 3 + 10000 × 15 = 597000 + 150000 = 747000 / 1M = 0.747
      expect(costBelow).toBe(0.747);
    });

    it('does NOT apply premium for non-Sonnet models', () => {
      // claude-opus-4-6 with 250K input — no premium
      // base rates: 250000 × 5 + 10000 × 25 = 1250000 + 250000 = 1500000 / 1M = 1.5
      const cost = calculateModelCost(250_000, 10_000, 'claude-opus-4-6');
      expect(cost).toBe(1.5);
    });

    it('does NOT apply premium for Sonnet 4.6 (it has flat pricing)', () => {
      // claude-sonnet-4-6 with 250K input — no premium
      // base rates: 250000 × 3 + 10000 × 15 = 750000 + 150000 = 900000 / 1M = 0.9
      const cost = calculateModelCost(250_000, 10_000, 'claude-sonnet-4-6');
      expect(cost).toBe(0.9);
    });

    it('includes cached tokens in the 200K threshold calculation', () => {
      // 150K standard + 60K cached = 210K total → triggers premium
      // Premium rates: input $6/MTok, output $22.5/MTok
      // Standard: (150000-60000) × 6 = 90000 × 6 = 540000
      // Cached:   60000 × 6 × 0.1 = 36000
      // Output:   1000 × 22.5 = 22500
      // Total = 598500 / 1M = 0.5985
      const cost = calculateModelCost(150_000, 1000, 'claude-sonnet-4', {
        cachedInputTokens: 60_000,
      });
      expect(cost).toBe(0.5985);
    });
  });
});
