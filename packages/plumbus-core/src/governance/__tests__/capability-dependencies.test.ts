import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import { CapabilityKind } from '../../types/enums.js';
import {
  ruleCircularCapabilityDependency,
  ruleDeepCapabilityChain,
  ruleJobCapabilityDependency,
  ruleMissingCapabilityDependency,
  ruleNonCanonicalCapabilityReference,
} from '../rules/capability-dependencies.js';

function cap(name: string, domain: string, deps: string[] = []): CapabilityContract {
  return {
    name,
    kind: 'action',
    domain,
    input: z.object({}),
    output: z.object({}),
    effects: { data: [], events: [], external: [], ai: false, capabilities: deps },
    handler: async () => ({}),
  } as CapabilityContract;
}

describe('capability dependency governance rules', () => {
  it('missing-capability-dependency detects unknown targets', () => {
    const signals = ruleMissingCapabilityDependency.evaluate({
      capabilities: [cap('a', 'orders', ['billing.missing'])],
      entities: [],
      flows: [],
      events: [],
      prompts: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.rule).toBe('architecture.missing-capability-dependency');
  });

  it('circular-capability-dependency detects declared cycles', () => {
    const signals = ruleCircularCapabilityDependency.evaluate({
      capabilities: [cap('a', 'orders', ['billing.b']), cap('b', 'billing', ['orders.a'])],
      entities: [],
      flows: [],
      events: [],
      prompts: [],
    });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]?.rule).toBe('architecture.circular-capability-dependency');
  });

  it('non-canonical-capability-reference flags short names', () => {
    const signals = ruleNonCanonicalCapabilityReference.evaluate({
      capabilities: [cap('a', 'orders', ['chargeCard'])],
      entities: [],
      flows: [],
      events: [],
      prompts: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.rule).toBe('architecture.non-canonical-capability-reference');
  });

  it('deep-capability-chain flags depth >= 3', () => {
    const signals = ruleDeepCapabilityChain.evaluate({
      capabilities: [
        cap('a', 'orders', ['billing.b']),
        cap('b', 'billing', ['reports.c']),
        cap('c', 'reports', ['audit.d']),
        cap('d', 'audit', []),
      ],
      entities: [],
      flows: [],
      events: [],
      prompts: [],
    });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]?.rule).toBe('architecture.deep-capability-chain');
  });

  it('job-capability-dependency flags synchronous job invoke declarations', () => {
    const job = {
      ...cap('generateReport', 'reports'),
      kind: CapabilityKind.Job,
    } as ReturnType<typeof cap>;
    const signals = ruleJobCapabilityDependency.evaluate({
      capabilities: [cap('createOrder', 'orders', ['reports.generateReport']), job],
      entities: [],
      flows: [],
      events: [],
      prompts: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.rule).toBe('architecture.job-capability-dependency');
  });
});
