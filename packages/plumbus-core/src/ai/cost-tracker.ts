// ── AI Cost Tracking & Budget Enforcement ──
// Records per-request token usage and enforces limits.
// Costs are supplied by adapters or estimated from the model pricing catalog.

import { normalizeCost, validateTokenUsage } from './usage-validation.js';
import { z } from 'zod';
import { createErrorService } from '../errors/index.js';
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
  decisionName?: string;
  operation:
    | 'generate'
    | 'extract'
    | 'classify'
    | 'decide'
    | 'embed'
    | 'transcribe'
    | 'synthesize'
    | 'transport';
  /**
   * True when the call originally streamed but fell back to a non-streaming
   * retry after the streamed text failed JSON/schema validation. Both the
   * original streamed attempt and the fallback attempt are billed, so this
   * flag is the signal consumers use to detect duplicate billing for a
   * single logical generation.
   */
  fallbackUsed?: boolean;
  usage: TokenUsage;
  /**
   * Optional provider-native media billing units for non-token workloads such
   * as speech-to-text, text-to-speech, or realtime transport.
   */
  mediaUsage?: {
    audioInputSeconds?: number;
    audioOutputSeconds?: number;
    characters?: number;
    connectionMinutes?: number;
    participantMinutes?: number;
  };
  /** Provider-reported or catalog-estimated USD cost; null when unknown. */
  cost: number | null;
  latencyMs: number;
  tenantId?: string;
  actor?: string;
  /**
   * Whether the underlying provider call completed successfully. Failed rows
   * still represent real provider-side spend and count toward budget caps.
   * Defaults to 'success' inside `createCostTracker` when the caller does
   * not set it, preserving pre-0.3.0 behavior for existing consumers.
   */
  status: 'success' | 'failed' | 'refused' | 'incomplete';
  /** Short description of the failure when `status !== 'success'`. */
  errorMessage?: string;
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

/**
 * Input type for {@link CostTracker.record}. `status` and `errorMessage` are
 * optional so pre-0.3.0 call sites keep compiling; the tracker defaults
 * `status` to `'success'` internally.
 */
export type AICostRecordInput = Omit<AICostRecord, 'id' | 'timestamp' | 'status' | 'cost'> & {
  /** Framework-generated identity shared with the persistence hook. */
  id?: string;
  timestamp?: Date;
  status?: AICostRecord['status'];
  cost?: number | null;
};

// ── Cost Tracker ──
export interface CostTracker {
  record(entry: AICostRecordInput): void;
  checkBudget(config: {
    tenantId?: string;
    estimatedTokens?: number;
    /**
     * Optional normalized USD estimate for non-token workloads. Voice/media
     * layers can compute this ahead of time and pre-check shared daily caps.
     */
    estimatedCostUsd?: number;
  }): BudgetCheckResult;
  getDailyUsage(tenantId?: string): DailyUsage;
  getRecords(): AICostRecord[];
  /** Fetch provider totals for reconciliation; does not infer per-request prices from aggregates. */
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
  const budgetSchema = z.object({
    maxTokensPerRequest: z.number().finite().nonnegative().optional(),
    dailyCostLimit: z.number().finite().nonnegative().optional(),
    perTenantDailyLimit: z.number().finite().nonnegative().optional(),
  });
  if (!budgetSchema.safeParse(budget ?? {}).success)
    throw createErrorService().validation('Invalid AI budget configuration');
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
    const available = recs.length > 0 && recs.every((record) => record.cost != null);
    for (const r of recs) {
      if (r.cost != null) {
        total += r.cost;
      }
    }
    return { total, available };
  }

  return {
    record(entry) {
      const identity = z
        .object({ id: z.string().min(1).optional(), timestamp: z.date().optional() })
        .safeParse(entry);
      if (!identity.success)
        throw createErrorService().validation('Invalid AI cost record identity');
      records.push({
        ...entry,
        cost: normalizeCost(entry.cost),
        usage: validateTokenUsage(entry.usage),
        status: entry.status ?? 'success',
        id: identity.data.id ?? crypto.randomUUID(),
        timestamp: identity.data.timestamp ? new Date(identity.data.timestamp) : new Date(),
      });
    },

    checkBudget(config) {
      const estimate = z
        .object({
          estimatedTokens: z.number().finite().nonnegative().optional(),
          estimatedCostUsd: z.number().finite().nonnegative().optional(),
        })
        .safeParse(config);
      if (!estimate.success) return { allowed: false, reason: 'Invalid budget estimate' };
      if (budget?.maxTokensPerRequest != null && config.estimatedTokens != null) {
        if (config.estimatedTokens > budget.maxTokensPerRequest) {
          return {
            allowed: false,
            reason: `Estimated tokens (${config.estimatedTokens}) exceeds per-request limit (${budget.maxTokensPerRequest})`,
          };
        }
      }

      if (budget?.dailyCostLimit != null) {
        const daily = getTodayRecords();
        const { total } = sumCost(daily);
        const projectedTotal = total + (config.estimatedCostUsd ?? 0);
        if (daily.some((record) => record.cost == null)) {
          return {
            allowed: false,
            reason: 'Cost data unavailable for prior requests — daily budget cannot be enforced.',
          };
        }
        if (projectedTotal >= budget.dailyCostLimit) {
          return {
            allowed: false,
            reason: `Daily cost limit reached ($${projectedTotal.toFixed(4)} / $${budget.dailyCostLimit})`,
          };
        }
      }

      if (budget?.perTenantDailyLimit != null && config.tenantId) {
        const tenantDaily = getTodayRecords(config.tenantId);
        const { total } = sumCost(tenantDaily);
        const projectedTotal = total + (config.estimatedCostUsd ?? 0);
        if (tenantDaily.some((record) => record.cost == null)) {
          return {
            allowed: false,
            reason: 'Cost data unavailable for prior requests — tenant budget cannot be enforced.',
          };
        }
        if (projectedTotal >= budget.perTenantDailyLimit) {
          return {
            allowed: false,
            reason: `Tenant daily cost limit reached ($${projectedTotal.toFixed(4)} / $${budget.perTenantDailyLimit})`,
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
