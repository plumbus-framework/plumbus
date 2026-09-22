import { describe, expect, it } from 'vitest';
import { createCostTracker } from '@plumbus/core';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import { createMockProvider } from './provider.test.js';

describe('checkProviderCostBudget', () => {
  it('throws when CostTracker rejects estimatedCostUsd', () => {
    const costTracker = createCostTracker({ dailyCostLimit: 0.01 });
    costTracker.record({
      model: 'gpt-4o',
      provider: 'mock',
      operation: 'generate',
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      cost: 0.01,
      latencyMs: 200,
    });

    const provider = createMockProvider();
    const service = createAIService(
      singleProviderConfig(provider, {
        costTracker,
        budget: { tenantId: 't1' },
      }),
    );

    expect(() => service.checkProviderCostBudget({ estimatedCostUsd: 0.05 })).toThrow(
      'AI budget exceeded',
    );
  });

  it('allows pre-check when estimatedCostUsd is within budget', () => {
    const costTracker = createCostTracker({ dailyCostLimit: 1 });
    const provider = createMockProvider();
    const service = createAIService(
      singleProviderConfig(provider, {
        costTracker,
        budget: { tenantId: 't1' },
      }),
    );

    expect(() => service.checkProviderCostBudget({ estimatedCostUsd: 0.01 })).not.toThrow();
  });

  it('is a no-op when no cost tracker is configured', () => {
    const provider = createMockProvider();
    const service = createAIService(singleProviderConfig(provider));

    expect(() => service.checkProviderCostBudget({ estimatedCostUsd: 999 })).not.toThrow();
  });
});
