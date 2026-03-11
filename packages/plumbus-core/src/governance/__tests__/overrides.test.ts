import { describe, expect, it } from 'vitest';
import { GovernanceSeverity } from '../../types/enums.js';
import type { GovernanceSignal } from '../../types/governance.js';
import { applyOverrides, createOverrideStore } from '../overrides.js';

describe('OverrideStore', () => {
  it('creates an empty store', () => {
    const store = createOverrideStore();
    expect(store.getOverrides()).toHaveLength(0);
  });

  it('loads entries from constructor', () => {
    const store = createOverrideStore([
      { rule: 'test', justification: 'ok', author: 'dev', timestamp: new Date().toISOString() },
    ]);
    expect(store.getOverrides()).toHaveLength(1);
  });

  it('adds overrides', () => {
    const store = createOverrideStore();
    store.addOverride({
      rule: 'my-rule',
      justification: 'needed',
      author: 'dev',
      timestamp: new Date().toISOString(),
    });
    expect(store.getOverrides()).toHaveLength(1);
    expect(store.hasOverride('my-rule')).toBe(true);
  });

  it('removes overrides', () => {
    const store = createOverrideStore([
      { rule: 'test', justification: 'ok', author: 'dev', timestamp: new Date().toISOString() },
    ]);
    expect(store.removeOverride('test')).toBe(true);
    expect(store.getOverrides()).toHaveLength(0);
  });

  it('returns false when removing non-existent override', () => {
    const store = createOverrideStore();
    expect(store.removeOverride('nothing')).toBe(false);
  });

  it('filters expired overrides from getOverrides()', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const store = createOverrideStore([
      { rule: 'expired', justification: 'old', author: 'dev', timestamp: past, expiresAt: past },
    ]);
    expect(store.getOverrides()).toHaveLength(0);
  });

  it('returns expired overrides via getExpired()', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const store = createOverrideStore([
      { rule: 'expired', justification: 'old', author: 'dev', timestamp: past, expiresAt: past },
    ]);
    expect(store.getExpired()).toHaveLength(1);
  });

  it('includes non-expired overrides', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const store = createOverrideStore([
      {
        rule: 'valid',
        justification: 'ok',
        author: 'dev',
        timestamp: new Date().toISOString(),
        expiresAt: future,
      },
    ]);
    expect(store.getOverrides()).toHaveLength(1);
    expect(store.getExpired()).toHaveLength(0);
  });

  it('serializes back to entries', () => {
    const store = createOverrideStore([
      { rule: 'test', justification: 'ok', author: 'dev', timestamp: '2024-01-01T00:00:00.000Z' },
    ]);
    const serialized = store.serialize();
    expect(serialized).toHaveLength(1);
    expect(serialized[0]!.rule).toBe('test');
    expect(serialized[0]!.timestamp).toBe('2024-01-01T00:00:00.000Z');
  });

  it('hasOverride checks scope', () => {
    const store = createOverrideStore([
      {
        rule: 'test',
        justification: 'ok',
        author: 'dev',
        timestamp: new Date().toISOString(),
        scope: 'entity:User',
      },
    ]);
    expect(store.hasOverride('test', 'entity:User')).toBe(true);
    expect(store.hasOverride('test')).toBe(true); // no scope = matches unscoped
    expect(store.hasOverride('test', 'entity:Order')).toBe(false);
  });
});

describe('applyOverrides', () => {
  const signals: GovernanceSignal[] = [
    { severity: GovernanceSeverity.High, rule: 'rule-a', description: 'A', affectedComponent: 'x' },
    {
      severity: GovernanceSeverity.Warning,
      rule: 'rule-b',
      description: 'B',
      affectedComponent: 'y',
    },
    { severity: GovernanceSeverity.Info, rule: 'rule-c', description: 'C', affectedComponent: 'z' },
  ];

  it('returns all signals as effective with no overrides', () => {
    const { effective, overridden } = applyOverrides(signals, []);
    expect(effective).toHaveLength(3);
    expect(overridden).toHaveLength(0);
  });

  it('moves overridden signals out of effective', () => {
    const { effective, overridden } = applyOverrides(signals, [
      { rule: 'rule-a', justification: 'ok', author: 'dev', timestamp: new Date() },
    ]);
    expect(effective).toHaveLength(2);
    expect(overridden).toHaveLength(1);
    expect(overridden[0]!.rule).toBe('rule-a');
  });

  it('handles multiple overrides', () => {
    const { effective, overridden } = applyOverrides(signals, [
      { rule: 'rule-a', justification: 'ok', author: 'dev', timestamp: new Date() },
      { rule: 'rule-c', justification: 'ok', author: 'dev', timestamp: new Date() },
    ]);
    expect(effective).toHaveLength(1);
    expect(overridden).toHaveLength(2);
    expect(effective[0]!.rule).toBe('rule-b');
  });
});
