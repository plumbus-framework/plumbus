import { describe, expect, it } from 'vitest';
import { allKnownModels, calculateModelCost, findModelRate } from '../model-pricing.js';

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

  it('returns non-zero cost for legacy OpenAI models', () => {
    // gpt-4-0314: input $30/MTok, output $60/MTok
    expect(calculateModelCost(1000, 500, 'gpt-4-0314')).toBeGreaterThan(0);
    // gpt-4-1106-vision-preview: input $10/MTok, output $30/MTok
    expect(calculateModelCost(1000, 500, 'gpt-4-1106-vision-preview')).toBeGreaterThan(0);
    // gpt-3.5-turbo-0613: input $1.5/MTok, output $2/MTok
    expect(calculateModelCost(1000, 500, 'gpt-3.5-turbo-0613')).toBeGreaterThan(0);
    // gpt-3.5-turbo-16k-0613: input $3/MTok, output $4/MTok
    expect(calculateModelCost(1000, 500, 'gpt-3.5-turbo-16k-0613')).toBeGreaterThan(0);
  });

  it('every catalog entry carries a kind field', () => {
    const entries = allKnownModels();
    expect(entries.length).toBeGreaterThan(0);
    for (const [model, rate] of entries) {
      expect(rate.kind, `model "${model}" missing kind`).toBeDefined();
    }
  });

  it('catalog includes embedding entries with kind="embedding" and outputPerMTok=0', () => {
    const small = findModelRate('text-embedding-3-small');
    expect(small?.kind).toBe('embedding');
    expect(small?.outputPerMTok).toBe(0);
    const large = findModelRate('text-embedding-3-large');
    expect(large?.kind).toBe('embedding');
    const ada = findModelRate('text-embedding-ada-002');
    expect(ada?.kind).toBe('embedding');
  });

  it('catalog includes moderation entries with kind="moderation" and zero pricing', () => {
    const omni = findModelRate('omni-moderation-latest');
    expect(omni?.kind).toBe('moderation');
    expect(omni?.inputPerMTok).toBe(0);
    expect(omni?.outputPerMTok).toBe(0);
  });

  it('findModelRate returns kind alongside prices for chat models', () => {
    const gpt4o = findModelRate('gpt-4o');
    expect(gpt4o?.kind).toBe('text');
    expect(gpt4o?.inputPerMTok).toBe(2.5);
    const opus = findModelRate('claude-opus-4-7');
    expect(opus?.kind).toBe('text');
  });

  it('calculateModelCost ignores kind and prices embeddings against inputPerMTok only', () => {
    // text-embedding-3-small: $0.02/MTok input, $0 output
    // 10_000 input tokens × $0.02/MTok = $0.0002
    const cost = calculateModelCost(10_000, 0, 'text-embedding-3-small');
    expect(cost).toBe(0.0002);
  });

  it('returns non-zero cost for newly added models', () => {
    // gpt-5.6-sol: input $5/MTok, output $30/MTok
    // 1000 × 5 + 500 × 30 = 5000 + 15000 = 20000 / 1M = 0.02
    expect(calculateModelCost(1000, 500, 'gpt-5.6-sol')).toBe(0.02);
    // gpt-5.5: input $5/MTok, output $30/MTok
    // 1000 × 5 + 500 × 30 = 5000 + 15000 = 20000 / 1M = 0.02
    expect(calculateModelCost(1000, 500, 'gpt-5.5')).toBe(0.02);
    // gpt-5.5-pro: input $30/MTok, output $180/MTok
    expect(calculateModelCost(1000, 500, 'gpt-5.5-pro')).toBe(0.12);
    // claude-opus-4-8: input $5/MTok, output $25/MTok
    expect(calculateModelCost(1000, 500, 'claude-opus-4-8')).toBe(0.0175);
    // claude-opus-4-7: input $5/MTok, output $25/MTok
    expect(calculateModelCost(1000, 500, 'claude-opus-4-7')).toBe(0.0175);
    // claude-sonnet-5: introductory input $2/MTok, output $10/MTok (through Aug 2026)
    expect(calculateModelCost(1000, 500, 'claude-sonnet-5')).toBe(0.007);
    // claude-opus-5: input $5/MTok, output $25/MTok
    expect(calculateModelCost(1000, 500, 'claude-opus-5')).toBe(0.0175);
  });

  it('prices the gpt-5.6 line at its reduced rates', () => {
    // gpt-5.6-luna: input $0.20/MTok, output $1.20/MTok
    // 1000 × 0.2 + 500 × 1.2 = 200 + 600 = 800 / 1M = 0.0008
    expect(calculateModelCost(1000, 500, 'gpt-5.6-luna')).toBe(0.0008);
    // gpt-5.6-terra: input $2/MTok, output $12/MTok
    // 1000 × 2 + 500 × 12 = 2000 + 6000 = 8000 / 1M = 0.008
    expect(calculateModelCost(1000, 500, 'gpt-5.6-terra')).toBe(0.008);
    // luna is the cheapest of the three; sol is unchanged at $5/$30
    expect(calculateModelCost(1000, 500, 'gpt-5.6-luna')).toBeLessThan(
      calculateModelCost(1000, 500, 'gpt-5.6-terra'),
    );
    expect(calculateModelCost(1000, 500, 'gpt-5.6-terra')).toBeLessThan(
      calculateModelCost(1000, 500, 'gpt-5.6-sol'),
    );
  });

  it('returns non-zero cost for OpenAI specialized models', () => {
    // gpt-5.3-codex: input $1.75/MTok, output $14/MTok
    expect(calculateModelCost(1000, 500, 'gpt-5.3-codex')).toBe(0.00875);
    // gpt-5.5-cyber: input $12.50/MTok, output $75/MTok
    expect(calculateModelCost(1000, 500, 'gpt-5.5-cyber')).toBe(0.05);
    // gpt-5-search-api: input $1.25/MTok, output $10/MTok
    expect(calculateModelCost(1000, 500, 'gpt-5-search-api')).toBe(0.00625);
    for (const model of ['chat-latest', 'gpt-5.3-chat-latest', 'gpt-5.2-chat-latest']) {
      expect(findModelRate(model)?.kind, model).toBe('text');
      expect(calculateModelCost(1000, 500, model), model).toBeGreaterThan(0);
    }
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
