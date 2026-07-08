import { describe, expect, it } from 'vitest';
import { createCostTracker } from '../cost-tracker.js';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import { AIBudgetExceededError, AISecurityBlockedError } from '../../errors/data-errors.js';
import { createMockProvider } from './provider.test.js';
import type { EntityDefinition } from '../../types/entity.js';
import type { FieldDescriptor } from '../../types/fields.js';

function makeEntity(name: string, fields: Record<string, FieldDescriptor>): EntityDefinition {
  return { name, fields };
}

describe('AI service structured errors (A2)', () => {
  it('throws AISecurityBlockedError when mode is block', async () => {
    const entities: EntityDefinition[] = [
      makeEntity('User', {
        salary: { type: 'number', options: { classification: 'sensitive' } },
      }),
    ];
    const provider = createMockProvider();
    const service = createAIService(
      singleProviderConfig(provider, {
        security: { mode: 'block', warnThreshold: 'sensitive', entities },
      }),
    );

    await expect(
      service.generate({ prompt: 'test.prompt', input: { salary: 1 } }),
    ).rejects.toBeInstanceOf(AISecurityBlockedError);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('forbidden code on AISecurityBlockedError', async () => {
    const entities: EntityDefinition[] = [
      makeEntity('User', {
        salary: { type: 'number', options: { classification: 'sensitive' } },
      }),
    ];
    const service = createAIService(
      singleProviderConfig(createMockProvider(), {
        security: { mode: 'block', warnThreshold: 'sensitive', entities },
      }),
    );
    await expect(
      service.generate({ prompt: 'test.prompt', input: { salary: 1 } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('throws AIBudgetExceededError from checkProviderCostBudget', () => {
    const costTracker = createCostTracker({ dailyCostLimit: 0.01 });
    costTracker.record({
      model: 'gpt-4o',
      provider: 'mock',
      operation: 'generate',
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      cost: 0.01,
      latencyMs: 200,
    });
    const service = createAIService(
      singleProviderConfig(createMockProvider(), {
        costTracker,
        budget: { tenantId: 't1' },
      }),
    );

    expect(() => service.checkProviderCostBudget({ estimatedCostUsd: 0.05 })).toThrow(
      AIBudgetExceededError,
    );
  });
});
