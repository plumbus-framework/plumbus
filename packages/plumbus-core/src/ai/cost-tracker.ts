// ── AI Cost Tracking & Budget Enforcement ──
// Records per-request token usage and enforces limits.
// Actual cost data comes from provider usage APIs — no hardcoded rates.

import type { TokenUsage } from './provider.js';
import type { UsageAPIClient, UsageData } from './usage-client.js';
import { UsageAPIError } from './usage-client.js';

// ── Cost Record ──
export interface AICostRecord {
  id: string;
  timestamp: Date;
  model: string;
  provider: string;
  promptName?: string;
  operation: 'generate' | 'extract' | 'classify' | 'embed';
  usage: TokenUsage;
  /** Actual cost from provider API, or null if API unavailable */
  cost: number | null;
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
  record(entry: Omit<AICostRecord, 'id' | 'timestamp'>): void;
  checkBudget(config: { tenantId?: string; estimatedTokens?: number }): BudgetCheckResult;
  getDailyUsage(tenantId?: string): DailyUsage;
  getRecords(): AICostRecord[];
  /** Fetch actual costs from provider usage APIs and update records */
  syncCosts?(): Promise<UsageSyncResult>;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface DailyUsage {
  totalTokens: number;
  totalCost: number;
  /** Whether cost data is available from provider APIs */
  costAvailable: boolean;
  requestCount: number;
}

export interface UsageSyncResult {
  synced: boolean;
  totalCost?: number;
  error?: string;
}

export function createCostTracker(
  budget?: BudgetConfig,
  usageClients?: UsageAPIClient[],
): CostTracker {
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

  function sumCost(recs: AICostRecord[]): { total: number; available: boolean } {
    let total = 0;
    let available = false;
    for (const r of recs) {
      if (r.cost != null) {
        total += r.cost;
        available = true;
      }
    }
    return { total, available };
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
        const { total, available } = sumCost(daily);
        if (!available) {
          return {
            allowed: true,
            reason:
              'Cost data unavailable — usage API not configured. Dollar-based budget cannot be enforced.',
          };
        }
        if (total >= budget.dailyCostLimit) {
          return {
            allowed: false,
            reason: `Daily cost limit reached ($${total.toFixed(4)} / $${budget.dailyCostLimit})`,
          };
        }
      }

      if (budget?.perTenantDailyLimit && config.tenantId) {
        const tenantDaily = getTodayRecords(config.tenantId);
        const { total, available } = sumCost(tenantDaily);
        if (!available) {
          return {
            allowed: true,
            reason:
              'Cost data unavailable — usage API not configured. Tenant budget cannot be enforced.',
          };
        }
        if (total >= budget.perTenantDailyLimit) {
          return {
            allowed: false,
            reason: `Tenant daily cost limit reached ($${total.toFixed(4)} / $${budget.perTenantDailyLimit})`,
          };
        }
      }

      return { allowed: true };
    },

    getDailyUsage(tenantId) {
      const daily = getTodayRecords(tenantId);
      const { total, available } = sumCost(daily);
      return {
        totalTokens: daily.reduce((sum, r) => sum + r.usage.totalTokens, 0),
        totalCost: total,
        costAvailable: available,
        requestCount: daily.length,
      };
    },

    getRecords() {
      return [...records];
    },

    async syncCosts() {
      if (!usageClients?.length) {
        return { synced: false, error: 'No usage API clients configured' };
      }

      try {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        let totalCostFromAPIs = 0;

        for (const client of usageClients) {
          const usage: UsageData = await client.fetchUsage({ startDate: startOfDay, endDate: now });
          totalCostFromAPIs += usage.totalCost;
        }

        return { synced: true, totalCost: totalCostFromAPIs };
      } catch (err) {
        const message =
          err instanceof UsageAPIError ? err.message : 'Unknown error fetching usage data';
        return { synced: false, error: message };
      }
    },
  };
}
