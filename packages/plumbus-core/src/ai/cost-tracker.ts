// ── AI Cost Tracking & Budget Enforcement ──
// Records per-request token usage, estimated cost, and enforces limits

import type { TokenUsage } from "./provider.js";

// ── Cost Record ──
export interface AICostRecord {
  id: string;
  timestamp: Date;
  model: string;
  promptName?: string;
  operation: "generate" | "extract" | "classify" | "embed";
  usage: TokenUsage;
  estimatedCost: number;
  latencyMs: number;
  tenantId?: string;
  actor?: string;
}

// ── Budget Config ──
export interface BudgetConfig {
  /** Max tokens per single request */
  maxTokensPerRequest?: number;
  /** Daily cost limit in USD */
  dailyCostLimit?: number;
  /** Per-tenant daily cost limit in USD */
  perTenantDailyLimit?: number;
}

// ── Cost Tracker ──
export interface CostTracker {
  record(entry: Omit<AICostRecord, "id" | "timestamp">): void;
  checkBudget(config: {
    tenantId?: string;
    estimatedTokens?: number;
  }): BudgetCheckResult;
  getDailyUsage(tenantId?: string): DailyUsage;
  getRecords(): AICostRecord[];
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface DailyUsage {
  totalTokens: number;
  totalCost: number;
  requestCount: number;
}

// ── Default cost rates per 1M tokens (approximate) ──
const DEFAULT_COST_RATES: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
};

export function estimateCost(model: string, usage: TokenUsage): number {
  const rate = DEFAULT_COST_RATES[model] ?? { input: 5, output: 15 };
  return (usage.inputTokens * rate.input + usage.outputTokens * rate.output) / 1_000_000;
}

export function createCostTracker(budget?: BudgetConfig): CostTracker {
  const records: AICostRecord[] = [];

  function getTodayRecords(tenantId?: string): AICostRecord[] {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return records.filter((r) => {
      if (r.timestamp < startOfDay) return false;
      if (tenantId && r.tenantId !== tenantId) return false;
      return true;
    });
  }

  return {
    record(entry) {
      records.push({
        ...entry,
        id: crypto.randomUUID(),
        timestamp: new Date(),
      });
    },

    checkBudget(config) {
      if (budget?.maxTokensPerRequest && config.estimatedTokens) {
        if (config.estimatedTokens > budget.maxTokensPerRequest) {
          return {
            allowed: false,
            reason: `Estimated tokens (${config.estimatedTokens}) exceeds per-request limit (${budget.maxTokensPerRequest})`,
          };
        }
      }

      if (budget?.dailyCostLimit) {
        const daily = getTodayRecords();
        const totalCost = daily.reduce((sum, r) => sum + r.estimatedCost, 0);
        if (totalCost >= budget.dailyCostLimit) {
          return {
            allowed: false,
            reason: `Daily cost limit reached ($${totalCost.toFixed(4)} / $${budget.dailyCostLimit})`,
          };
        }
      }

      if (budget?.perTenantDailyLimit && config.tenantId) {
        const tenantDaily = getTodayRecords(config.tenantId);
        const tenantCost = tenantDaily.reduce((sum, r) => sum + r.estimatedCost, 0);
        if (tenantCost >= budget.perTenantDailyLimit) {
          return {
            allowed: false,
            reason: `Tenant daily cost limit reached ($${tenantCost.toFixed(4)} / $${budget.perTenantDailyLimit})`,
          };
        }
      }

      return { allowed: true };
    },

    getDailyUsage(tenantId) {
      const daily = getTodayRecords(tenantId);
      return {
        totalTokens: daily.reduce((sum, r) => sum + r.usage.totalTokens, 0),
        totalCost: daily.reduce((sum, r) => sum + r.estimatedCost, 0),
        requestCount: daily.length,
      };
    },

    getRecords() {
      return [...records];
    },
  };
}
