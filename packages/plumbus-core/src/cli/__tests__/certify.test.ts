import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { EntityDefinition } from '../../types/entity.js';
import { FieldClassification, PolicyProfile, RuleStatus } from '../../types/enums.js';
import { evaluatePolicy } from '../commands/certify.js';

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
    tenantScoped: true,
    fields: {
      id: { type: 'id', options: {} },
    },
    ...overrides,
  };
}

describe('plumbus certify policy', () => {
  it('returns 100% score for empty system', () => {
    const report = evaluatePolicy(PolicyProfile.Soc2, [], []);
    expect(report.compatibilityScore).toBe(100);
    expect(report.policy).toBe('soc2');
  });

  it('evaluates PCI DSS policy with failing encryption rule', () => {
    const report = evaluatePolicy(
      PolicyProfile.PciDss,
      [mockCap({ access: { roles: ['admin'] } })],
      [
        mockEntity({
          fields: {
            ssn: { type: 'string', options: { classification: FieldClassification.Sensitive } },
          },
        }),
      ],
    );
    const encRule = report.results.find((r) => r.rule === 'pci-encryption-required');
    expect(encRule?.status).toBe(RuleStatus.Fail);
    expect(report.compatibilityScore).toBeLessThan(100);
  });

  it('evaluates GDPR policy with classification rule', () => {
    const report = evaluatePolicy(
      PolicyProfile.Gdpr,
      [mockCap({ access: { roles: ['admin'] } })],
      [
        mockEntity({
          fields: {
            name: { type: 'string', options: {} },
          },
        }),
      ],
    );
    const classRule = report.results.find((r) => r.rule === 'gdpr-data-classification');
    expect(classRule?.status).toBe(RuleStatus.Partial);
  });

  it('respects overrides', () => {
    const report = evaluatePolicy(
      PolicyProfile.InternalSecurityBaseline,
      [mockCap()],
      [],
      [
        {
          rule: 'access-control-required',
          justification: 'test',
          author: 'dev',
          timestamp: new Date(),
        },
      ],
    );
    const overridden = report.results.find((r) => r.rule === 'access-control-required');
    expect(overridden?.status).toBe(RuleStatus.Override);
  });

  it('provides remediation recommendations', () => {
    const report = evaluatePolicy(
      PolicyProfile.PciDss,
      [mockCap()],
      [
        mockEntity({
          tenantScoped: false,
          fields: {
            secret: {
              type: 'string',
              options: { classification: FieldClassification.HighlySensitive },
            },
          },
        }),
      ],
    );
    expect(report.recommendations!.length).toBeGreaterThan(0);
  });

  it('evaluates HIPAA policy with masking rule', () => {
    const report = evaluatePolicy(
      PolicyProfile.Hipaa,
      [mockCap({ access: { roles: ['admin'] } })],
      [
        mockEntity({
          fields: {
            diagnosis: {
              type: 'string',
              options: { classification: FieldClassification.Sensitive, encrypted: true },
            },
          },
        }),
      ],
    );
    const maskRule = report.results.find((r) => r.rule === 'hipaa-field-masking');
    expect(maskRule?.status).toBe(RuleStatus.Fail);
  });
});
