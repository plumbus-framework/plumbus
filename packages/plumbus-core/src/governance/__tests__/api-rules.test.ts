import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import {
  ruleApiDeprecatedWithoutReplacement,
  ruleApiMetadataWithoutExposure,
  ruleApiMissingAuth,
  ruleApiMissingOperationId,
  ruleApiPublicMutationWithoutIdempotency,
} from '../rules/api.js';

function mockCap(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name: 'testCap',
    kind: 'query',
    domain: 'billing',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
    ...overrides,
  };
}

const inventory = (capabilities: CapabilityContract[]) => ({
  capabilities,
  entities: [],
  flows: [],
  events: [],
  prompts: [],
});

describe('api governance rules', () => {
  it('api.metadata-without-exposure signals when api block without exposeAs', () => {
    const signals = ruleApiMetadataWithoutExposure.evaluate(
      inventory([mockCap({ api: { operationId: 'x', method: 'GET', path: '/x' } })]),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.rule).toBe('api.metadata-without-exposure');
  });

  it('api.metadata-without-exposure absent when properly exposed', () => {
    const signals = ruleApiMetadataWithoutExposure.evaluate(
      inventory([
        mockCap({
          exposeAs: ['api'],
          api: { operationId: 'x', method: 'GET', path: '/x' },
        }),
      ]),
    );
    expect(signals).toHaveLength(0);
  });

  it('api.public-mutation-without-idempotency signals public POST without idempotency', () => {
    const signals = ruleApiPublicMutationWithoutIdempotency.evaluate(
      inventory([
        mockCap({
          exposeAs: ['api'],
          access: { public: true },
          api: { operationId: 'x', method: 'POST', path: '/x' },
        }),
      ]),
    );
    expect(signals.some((s) => s.rule === 'api.public-mutation-without-idempotency')).toBe(true);
  });

  it('api.missing-auth signals api-exposed cap without auth metadata', () => {
    const signals = ruleApiMissingAuth.evaluate(
      inventory([
        mockCap({
          exposeAs: ['api'],
          api: { operationId: 'x', method: 'GET', path: '/x' },
        }),
      ]),
    );
    expect(signals.some((s) => s.rule === 'api.missing-auth')).toBe(true);
  });

  it('api.deprecated-without-replacement signals deprecated without replacement', () => {
    const signals = ruleApiDeprecatedWithoutReplacement.evaluate(
      inventory([
        mockCap({
          exposeAs: ['api'],
          api: {
            operationId: 'x',
            method: 'GET',
            path: '/x',
            stability: 'deprecated',
          },
        }),
      ]),
    );
    expect(signals.some((s) => s.rule === 'api.deprecated-without-replacement')).toBe(true);
  });

  it('api.missing-operation-id signals missing operationId', () => {
    const signals = ruleApiMissingOperationId.evaluate(
      inventory([
        mockCap({
          exposeAs: ['api'],
          api: { method: 'GET', path: '/x' } as CapabilityContract['api'],
        }),
      ]),
    );
    expect(signals.some((s) => s.rule === 'api.missing-operation-id')).toBe(true);
  });
});
