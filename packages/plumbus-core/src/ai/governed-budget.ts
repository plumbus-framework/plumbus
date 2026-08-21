import type { BudgetCheckResult, BudgetConfig, CostTracker } from './cost-tracker.js';

export interface GovernedBudgetInput {
  tracker?: CostTracker;
  budget?: BudgetConfig;
  tenantId?: string;
  estimatedTokens?: number;
  estimatedCostUsd?: number;
}

function hasDeclaredLimit(budget: BudgetConfig): boolean {
  return (
    budget.maxTokensPerRequest != null ||
    budget.dailyCostLimit != null ||
    budget.perTenantDailyLimit != null
  );
}

/**
 * Fail-closed budget check for governed model calls.
 *
 * The existing cost tracker allows a call when dollar cost is unknown.
 * Governed AI does the opposite: missing limits, missing estimates, or
 * unavailable cost data refuse the call.
 */
export function checkGovernedBudget(input: GovernedBudgetInput): BudgetCheckResult {
  if (!input.budget || !hasDeclaredLimit(input.budget)) {
    return { allowed: false, reason: 'Governed AI requires a declared budget limit' };
  }

  if (input.budget.maxTokensPerRequest != null && input.estimatedTokens == null) {
    return { allowed: false, reason: 'Token budget cannot be checked without an estimate' };
  }

  if (
    (input.budget.dailyCostLimit != null || input.budget.perTenantDailyLimit != null) &&
    input.estimatedCostUsd == null
  ) {
    return { allowed: false, reason: 'Dollar budget cannot be checked without a cost estimate' };
  }

  if (
    (input.budget.dailyCostLimit != null || input.budget.perTenantDailyLimit != null) &&
    !input.tracker
  ) {
    return { allowed: false, reason: 'Dollar budget cannot be checked without a cost ledger' };
  }

  if (!input.tracker) {
    if (
      input.budget.maxTokensPerRequest != null &&
      input.estimatedTokens != null &&
      input.estimatedTokens > input.budget.maxTokensPerRequest
    ) {
      return {
        allowed: false,
        reason: `Estimated tokens (${input.estimatedTokens}) exceeds per-request limit (${input.budget.maxTokensPerRequest})`,
      };
    }
    return { allowed: true };
  }

  const result = input.tracker.checkBudget({
    tenantId: input.tenantId,
    estimatedTokens: input.estimatedTokens,
    estimatedCostUsd: input.estimatedCostUsd,
  });
  if (!result.allowed) {
    return result;
  }
  if (result.reason?.includes('Cost data unavailable')) {
    return { allowed: false, reason: result.reason };
  }
  return result;
}
