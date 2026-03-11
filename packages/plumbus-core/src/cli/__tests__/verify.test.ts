import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { EntityDefinition } from '../../types/entity.js';
import { FieldClassification, GovernanceSeverity } from '../../types/enums.js';
import {
  ruleCapabilityAccessPolicy,
  ruleCapabilityEffects,
  ruleEncryptedSensitiveFields,
  ruleEntityFieldClassification,
  ruleEntityTenantIsolation,
  runGovernanceRules,
} from '../commands/verify.js';

function mockCap(overrides?: Partial<CapabilityContract>): CapabilityContract {
  return {
    name: 'test',
    kind: 'action',
    domain: 'test',
    input: z.object({}),
    output: z.object({}),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({}),
    ...overrides,
  };
}

function mockEntity(overrides?: Partial<EntityDefinition>): EntityDefinition {
  return {
    name: 'TestEntity',
    fields: {
      id: { type: 'id', options: {} },
    },
    ...overrides,
  };
}

describe('plumbus verify', () => {
  describe('ruleCapabilityAccessPolicy', () => {
    it('flags capabilities without access policies', () => {
      const signals = ruleCapabilityAccessPolicy([mockCap()]);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.severity).toBe(GovernanceSeverity.High);
      expect(signals[0]!.rule).toBe('security.capability-access-policy');
    });

    it('passes capabilities with roles', () => {
      const signals = ruleCapabilityAccessPolicy([mockCap({ access: { roles: ['admin'] } })]);
      expect(signals).toHaveLength(0);
    });

    it('passes public capabilities', () => {
      const signals = ruleCapabilityAccessPolicy([mockCap({ access: { public: true } })]);
      expect(signals).toHaveLength(0);
    });
  });

  describe('ruleCapabilityEffects', () => {
    it('flags capabilities with excessive effects', () => {
      const signals = ruleCapabilityEffects([
        mockCap({
          effects: {
            data: ['a', 'b', 'c', 'd', 'e'],
            events: ['f', 'g', 'h', 'i', 'j'],
            external: ['k'],
            ai: false,
          },
        }),
      ]);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.rule).toBe('architecture.excessive-effects');
    });

    it('passes capabilities with reasonable effects', () => {
      const signals = ruleCapabilityEffects([mockCap()]);
      expect(signals).toHaveLength(0);
    });
  });

  describe('ruleEntityFieldClassification', () => {
    it('flags sensitive-looking fields without classification', () => {
      const signals = ruleEntityFieldClassification([
        mockEntity({
          fields: {
            id: { type: 'id', options: {} },
            email: { type: 'string', options: {} },
          },
        }),
      ]);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.rule).toBe('privacy.missing-field-classification');
    });

    it('passes classified fields', () => {
      const signals = ruleEntityFieldClassification([
        mockEntity({
          fields: {
            id: { type: 'id', options: {} },
            email: { type: 'string', options: { classification: FieldClassification.Personal } },
          },
        }),
      ]);
      expect(signals).toHaveLength(0);
    });
  });

  describe('ruleEncryptedSensitiveFields', () => {
    it('flags unencrypted sensitive fields', () => {
      const signals = ruleEncryptedSensitiveFields([
        mockEntity({
          fields: {
            ssn: {
              type: 'string',
              options: { classification: FieldClassification.HighlySensitive },
            },
          },
        }),
      ]);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.rule).toBe('privacy.sensitive-field-unencrypted');
    });

    it('passes encrypted sensitive fields', () => {
      const signals = ruleEncryptedSensitiveFields([
        mockEntity({
          fields: {
            ssn: {
              type: 'string',
              options: { classification: FieldClassification.HighlySensitive, encrypted: true },
            },
          },
        }),
      ]);
      expect(signals).toHaveLength(0);
    });
  });

  describe('ruleEntityTenantIsolation', () => {
    it('flags entities without tenant isolation', () => {
      const signals = ruleEntityTenantIsolation([mockEntity()]);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.severity).toBe(GovernanceSeverity.Info);
    });

    it('passes tenant-scoped entities', () => {
      const signals = ruleEntityTenantIsolation([mockEntity({ tenantScoped: true })]);
      expect(signals).toHaveLength(0);
    });
  });

  describe('runGovernanceRules', () => {
    it('returns empty for empty inputs', () => {
      expect(runGovernanceRules([], [])).toHaveLength(0);
    });

    it('aggregates signals from all rules', () => {
      const signals = runGovernanceRules(
        [mockCap()],
        [mockEntity({ fields: { email: { type: 'string', options: {} } } })],
      );
      expect(signals.length).toBeGreaterThan(0);
    });
  });
});
