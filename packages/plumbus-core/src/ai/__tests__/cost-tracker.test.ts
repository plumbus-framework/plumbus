import { describe, expect, it, vi } from 'vitest';
import { type BudgetConfig, createCostTracker } from '../cost-tracker.js';
import type { UsageAPIClient } from '../usage-client.js';
import { UsageAPIError } from '../usage-client.js';

describe('Cost Tracker', () => {
  describe('createCostTracker', () => {
    it('records and retrieves cost entries', () => {
      const tracker = createCostTracker();
      tracker.record({
        model: 'gpt-4o',
        provider: 'openai',
        operation: 'generate',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cost: null,
        latencyMs: 500,
      });

      const records = tracker.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.model).toBe('gpt-4o');
      expect(records[0]?.cost).toBeNull();
      expect(records[0]?.id).toBeDefined();
      expect(records[0]?.timestamp).toBeInstanceOf(Date);
    });

    it('records entries with actual cost from usage API', () => {
      const tracker = createCostTracker();
      tracker.record({
        model: 'gpt-4o',
        provider: 'openai',
        operation: 'generate',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cost: 0.001,
        latencyMs: 500,
      });

      const records = tracker.getRecords();
      expect(records[0]?.cost).toBe(0.001);
    });

    it('tracks daily usage with cost available', () => {
      const tracker = createCostTracker();
      tracker.record({
        model: 'gpt-4o',
        provider: 'openai',
        operation: 'generate',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cost: 0.001,
        latencyMs: 500,
      });
      tracker.record({
        model: 'gpt-4o',
        provider: 'openai',
        operation: 'extract',
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        cost: 0.002,
        latencyMs: 300,
      });

      const daily = tracker.getDailyUsage();
      expect(daily.requestCount).toBe(2);
      expect(daily.totalTokens).toBe(450);
      expect(daily.totalCost).toBeCloseTo(0.003, 4);
      expect(daily.costAvailable).toBe(true);
    });

    it('reports costAvailable=false when no cost data', () => {
      const tracker = createCostTracker();
      tracker.record({
        model: 'gpt-4o',
        provider: 'openai',
        operation: 'generate',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cost: null,
        latencyMs: 500,
      });

      const daily = tracker.getDailyUsage();
      expect(daily.costAvailable).toBe(false);
      expect(daily.totalCost).toBe(0);
    });

    it('filters daily usage by tenant', () => {
      const tracker = createCostTracker();
      tracker.record({
        model: 'gpt-4o',
        provider: 'openai',
        operation: 'generate',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cost: null,
        latencyMs: 500,
        tenantId: 't1',
      });
      tracker.record({
        model: 'gpt-4o',
        provider: 'openai',
        operation: 'generate',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cost: null,
        latencyMs: 500,
        tenantId: 't2',
      });

      expect(tracker.getDailyUsage('t1').requestCount).toBe(1);
      expect(tracker.getDailyUsage('t2').requestCount).toBe(1);
    });

    it('enforces max tokens per request', () => {
      const budget: BudgetConfig = { maxTokensPerRequest: 1000 };
      const tracker = createCostTracker(budget);

      expect(tracker.checkBudget({ estimatedTokens: 500 }).allowed).toBe(true);
      expect(tracker.checkBudget({ estimatedTokens: 1500 }).allowed).toBe(false);
      expect(tracker.checkBudget({ estimatedTokens: 1500 }).reason).toContain('per-request limit');
    });

    it('enforces daily cost limit when cost data is available', () => {
      const budget: BudgetConfig = { dailyCostLimit: 0.01 };
      const tracker = createCostTracker(budget);

      tracker.record({
        model: 'gpt-4o',
        provider: 'openai',
        operation: 'generate',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cost: 0.01,
        latencyMs: 200,
      });

      const result = tracker.checkBudget({});
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily cost limit');
    });

    it('allows but warns when cost data unavailable for daily budget', () => {
      const budget: BudgetConfig = { dailyCostLimit: 0.01 };
      const tracker = createCostTracker(budget);

      tracker.record({
        model: 'gpt-4o',
        provider: 'openai',
        operation: 'generate',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cost: null,
        latencyMs: 200,
      });

      const result = tracker.checkBudget({});
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('Cost data unavailable');
    });

    it('enforces per-tenant daily limit', () => {
      const budget: BudgetConfig = { perTenantDailyLimit: 0.005 };
      const tracker = createCostTracker(budget);

      tracker.record({
        model: 'gpt-4o',
        provider: 'openai',
        operation: 'generate',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cost: 0.005,
        latencyMs: 200,
        tenantId: 't1',
      });

      expect(tracker.checkBudget({ tenantId: 't1' }).allowed).toBe(false);
      expect(tracker.checkBudget({ tenantId: 't2' }).allowed).toBe(true);
    });

    it('allows when under budget', () => {
      const budget: BudgetConfig = {
        maxTokensPerRequest: 5000,
        dailyCostLimit: 100,
        perTenantDailyLimit: 50,
      };
      const tracker = createCostTracker(budget);

      const result = tracker.checkBudget({
        tenantId: 't1',
        estimatedTokens: 1000,
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('syncCosts', () => {
    it('returns error when no usage clients configured', async () => {
      const tracker = createCostTracker();
      const result = await tracker.syncCosts?.();
      expect(result?.synced).toBe(false);
      expect(result?.error).toContain('No usage API clients');
    });

    it('fetches costs from usage API client', async () => {
      const mockClient: UsageAPIClient = {
        provider: 'openai',
        fetchUsage: vi.fn(async () => ({
          totalCost: 1.5,
          currency: 'usd',
          entries: [
            { model: 'gpt-4o', inputTokens: 1000, outputTokens: 500, cost: 1.5, requestCount: 10 },
          ],
        })),
      };

      const tracker = createCostTracker(undefined, [mockClient]);
      const result = await tracker.syncCosts?.();
      expect(result?.synced).toBe(true);
      expect(result?.totalCost).toBe(1.5);
      expect(mockClient.fetchUsage).toHaveBeenCalled();
    });

    it('handles usage API errors gracefully', async () => {
      const failingClient: UsageAPIClient = {
        provider: 'openai',
        fetchUsage: vi.fn(async () => {
          throw new UsageAPIError('openai', 'OpenAI Usage API returned 401: Unauthorized');
        }),
      };

      const tracker = createCostTracker(undefined, [failingClient]);
      const result = await tracker.syncCosts?.();
      expect(result?.synced).toBe(false);
      expect(result?.error).toContain('401');
    });
  });
});
