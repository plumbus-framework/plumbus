import { describe, expect, it } from 'vitest';
import { ErrorDocUrls, ErrorHints } from '../../errors/hints.js';
import {
  evaluateFlowCondition,
  FLOW_CONDITION_SYNTAX_HINT,
  FlowConditionError,
  normalizeFlowConditionExpression,
} from '../evaluate-condition.js';

describe('evaluateFlowCondition', () => {
  const state = { amount: 150, status: 'paid', nested: { flag: true } };

  it('evaluates numeric comparison on state', () => {
    expect(evaluateFlowCondition('state.amount > 100', state)).toBe(true);
    expect(evaluateFlowCondition('state.amount > 200', state)).toBe(false);
  });

  it('normalizes ctx.state to state', () => {
    expect(evaluateFlowCondition('ctx.state.amount > 100', state)).toBe(true);
    expect(normalizeFlowConditionExpression('ctx.state.amount > 1')).toBe('state.amount > 1');
  });

  it('evaluates string equality', () => {
    expect(evaluateFlowCondition('state.status === "paid"', state)).toBe(true);
    expect(evaluateFlowCondition("state.status === 'pending'", state)).toBe(false);
  });

  it('evaluates boolean logic', () => {
    expect(evaluateFlowCondition('state.amount > 100 && state.status === "paid"', state)).toBe(
      true,
    );
    expect(evaluateFlowCondition('state.amount > 100 || state.status === "pending"', state)).toBe(
      true,
    );
    expect(evaluateFlowCondition('!state.nested.flag', { nested: { flag: false } })).toBe(true);
  });

  it('supports property paths without state prefix', () => {
    expect(evaluateFlowCondition('amount > 100', state)).toBe(true);
  });

  it('returns false for empty expression', () => {
    expect(evaluateFlowCondition('   ', state)).toBe(false);
  });

  it('rejects disallowed syntax', () => {
    expect(() => evaluateFlowCondition('state.items.map(x => x)', state)).toThrow(
      FlowConditionError,
    );
    expect(() => evaluateFlowCondition('new Function("return 1")', state)).toThrow(
      FlowConditionError,
    );
  });

  it('rejects invalid expressions with FlowConditionError', () => {
    expect(() => evaluateFlowCondition('state.amount >', state)).toThrow(FlowConditionError);
  });

  it('exposes centralized hint and doc URL on FlowConditionError', () => {
    try {
      evaluateFlowCondition('state.amount >', state);
    } catch (err) {
      expect(err).toBeInstanceOf(FlowConditionError);
      const error = err as FlowConditionError;
      expect(error.hint).toBe(ErrorHints.flowConditionSyntax);
      expect(error.docUrl).toBe(ErrorDocUrls.flowConditions);
      expect(FLOW_CONDITION_SYNTAX_HINT).toBe(ErrorHints.flowConditionSyntax);
      return;
    }
    expect.fail('expected FlowConditionError');
  });
});
