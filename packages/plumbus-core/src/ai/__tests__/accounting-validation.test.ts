import { describe, expect, it } from 'vitest';
import { calculateModelCost } from '../model-pricing.js';
import { createCostTracker } from '../cost-tracker.js';

describe('accounting validation', () => {
  it.each([
    -1,
    NaN,
    Infinity,
    -Infinity,
  ])('rejects invalid token counts and fails closed for invalid cost %s', (bad) => {
    expect(() => calculateModelCost(bad, 1, 'gpt-4o')).toThrow('Invalid provider token usage');
    const tracker = createCostTracker({ dailyCostLimit: 1 });
    tracker.record({
      model: 'custom',
      provider: 'custom',
      operation: 'generate',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      cost: bad,
      latencyMs: 0,
    });
    expect(tracker.getRecords()[0]?.cost).toBeNull();
    expect(tracker.checkBudget({}).allowed).toBe(false);
    expect(tracker.checkBudget({ estimatedCostUsd: bad }).allowed).toBe(false);
  });
  it('does not hide an unpriced row behind priced rows or a cost estimate', () => {
    const tracker = createCostTracker({ dailyCostLimit: 10 });
    for (const cost of [1, null])
      tracker.record({
        model: 'custom',
        provider: 'custom',
        operation: 'generate',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        cost,
        latencyMs: 0,
      });
    expect(tracker.checkBudget({ estimatedCostUsd: 1 }).allowed).toBe(false);
  });
  it('honors a zero-dollar cap and rejects invalid cap configuration', () => {
    expect(createCostTracker({ dailyCostLimit: 0 }).checkBudget({}).allowed).toBe(false);
    expect(() => createCostTracker({ dailyCostLimit: NaN })).toThrow('Invalid AI budget');
  });
});
