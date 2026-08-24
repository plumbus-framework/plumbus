import { randomUUID } from 'node:crypto';
import { BudgetExhaustedError } from '../errors/index.js';

export const BUDGET_STATE_KEY = '__budget';
export const BUDGET_EXHAUSTED = 'budget-exhausted';
export { BudgetExhaustedError };

/** Per-execution ledger (recovery.schema BudgetLedger v1 subset). */
export interface ExecutionBudgetAmount {
  dimensionId: string;
  unitId: string;
  allocated: number;
  consumed: number;
  reserved: number;
}

export interface ExecutionBudgetLedger {
  contractVersion: '0.1.0';
  budgetLedgerId: string;
  executionId: string;
  budgetProfileId: string;
  state: 'active' | 'exhausted' | 'closed';
  amounts: ExecutionBudgetAmount[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type { FlowBudget } from '../types/flow.js';

export function createExecutionBudgetLedger(input: {
  executionId: string;
  profileId: string;
  allocated: number;
  unitId?: string;
  dimensionId?: string;
  now?: Date;
}): ExecutionBudgetLedger {
  const now = (input.now ?? new Date()).toISOString();
  return {
    contractVersion: '0.1.0',
    budgetLedgerId: randomUUID(),
    executionId: input.executionId,
    budgetProfileId: input.profileId,
    state: input.allocated <= 0 ? 'exhausted' : 'active',
    amounts: [
      {
        dimensionId: input.dimensionId ?? 'plumbus.execution.step',
        unitId: input.unitId ?? 'plumbus.unit.step',
        allocated: input.allocated,
        consumed: 0,
        reserved: 0,
      },
    ],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function readExecutionBudget(state: unknown): ExecutionBudgetLedger | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const ledger = (state as Record<string, unknown>)[BUDGET_STATE_KEY];
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return undefined;
  const typed = ledger as ExecutionBudgetLedger;
  if (typed.contractVersion !== '0.1.0' || !Array.isArray(typed.amounts)) return undefined;
  return typed;
}

export function writeExecutionBudget(
  state: unknown,
  ledger: ExecutionBudgetLedger,
): Record<string, unknown> {
  const base =
    state && typeof state === 'object' && !Array.isArray(state)
      ? { ...(state as Record<string, unknown>) }
      : {};
  base[BUDGET_STATE_KEY] = ledger;
  return base;
}

export function chargeExecutionBudget(
  ledger: ExecutionBudgetLedger,
  amount: number,
  now = new Date(),
): ExecutionBudgetLedger {
  const primary = ledger.amounts[0];
  if (!primary) {
    return {
      ...ledger,
      state: 'exhausted',
      revision: ledger.revision + 1,
      updatedAt: now.toISOString(),
    };
  }
  const nextConsumed = primary.consumed + amount;
  const next: ExecutionBudgetAmount = { ...primary, consumed: nextConsumed };
  const exhausted = nextConsumed > primary.allocated;
  return {
    ...ledger,
    amounts: [next, ...ledger.amounts.slice(1)],
    state: exhausted ? 'exhausted' : ledger.state,
    revision: ledger.revision + 1,
    updatedAt: now.toISOString(),
  };
}

/**
 * Charge one unit from `state.__budget` when a ledger is present.
 * Returns null when the flow has no budget (no-op).
 */
export function consumeExecutionBudget(
  state: unknown,
  amount = 1,
): { state: Record<string, unknown>; exhausted: boolean } | null {
  const ledger = readExecutionBudget(state);
  if (!ledger) return null;
  if (ledger.state === 'exhausted' || ledger.state === 'closed') {
    return { state: writeExecutionBudget(state, ledger), exhausted: true };
  }
  const next = chargeExecutionBudget(ledger, amount);
  return { state: writeExecutionBudget(state, next), exhausted: next.state === 'exhausted' };
}
