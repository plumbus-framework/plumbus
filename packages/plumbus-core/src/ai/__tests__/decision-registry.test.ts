import { describe, expect, it } from 'vitest';
import { defineDecision } from '../../define/defineDecision.js';
import { noul } from '../decision.js';
import { DecisionRegistry } from '../decision-registry.js';

const triage = defineDecision({
  name: 'support.triage',
  domain: 'support',
  questions: { isUrgent: noul('Urgent?') },
});

const moderate = defineDecision({
  name: 'moderation.screen',
  domain: 'moderation',
  questions: { isAbusive: noul('Abusive?') },
});

describe('DecisionRegistry', () => {
  it('registers and retrieves by name', () => {
    const registry = new DecisionRegistry();
    registry.register(triage);

    expect(registry.has('support.triage')).toBe(true);
    expect(registry.get('support.triage')).toBe(triage);
  });

  it('rejects a duplicate name', () => {
    const registry = new DecisionRegistry();
    registry.register(triage);

    expect(() => registry.register(triage)).toThrow(/already registered/);
  });

  it('throws for an unknown name', () => {
    expect(() => new DecisionRegistry().get('nope')).toThrow(/not found in registry/);
  });

  it('filters by domain', () => {
    const registry = new DecisionRegistry();
    registry.register(triage);
    registry.register(moderate);

    expect(registry.getAll()).toHaveLength(2);
    expect(registry.getByDomain('support')).toEqual([triage]);
  });

  it('discovers nothing from a directory that does not exist', async () => {
    await expect(
      new DecisionRegistry().discoverDecisions('/nonexistent/decisions'),
    ).resolves.toEqual([]);
  });
});
