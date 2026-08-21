import { describe, expect, it } from 'vitest';
import {
  BUDGET_STATE_KEY,
  chargeExecutionBudget,
  consumeExecutionBudget,
  createExecutionBudgetLedger,
  readExecutionBudget,
} from '../budget.js';

describe('execution budget ledger', () => {
  it('creates an active ledger and charges until exhausted', () => {
    const ledger = createExecutionBudgetLedger({
      executionId: 'exec-1',
      profileId: 'plumbus.budget.default',
      allocated: 1,
    });
    expect(ledger.state).toBe('active');
    expect(ledger.amounts[0]?.allocated).toBe(1);

    const afterFirst = chargeExecutionBudget(ledger, 1);
    expect(afterFirst.state).toBe('active');
    expect(afterFirst.amounts[0]?.consumed).toBe(1);

    const afterSecond = chargeExecutionBudget(afterFirst, 1);
    expect(afterSecond.state).toBe('exhausted');
    expect(afterSecond.amounts[0]?.consumed).toBe(2);
  });

  it('consumeExecutionBudget is a no-op without a ledger', () => {
    expect(consumeExecutionBudget({ other: true })).toBeNull();
  });

  it('reads and consumes from state.__budget', () => {
    const ledger = createExecutionBudgetLedger({
      executionId: 'exec-2',
      profileId: 'plumbus.budget.default',
      allocated: 0,
    });
    expect(ledger.state).toBe('exhausted');
    const state = { [BUDGET_STATE_KEY]: ledger };
    expect(readExecutionBudget(state)?.state).toBe('exhausted');
    const consumed = consumeExecutionBudget(state, 1);
    expect(consumed?.exhausted).toBe(true);
  });
});
