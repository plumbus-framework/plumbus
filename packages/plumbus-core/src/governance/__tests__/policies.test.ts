import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { EntityDefinition } from '../../types/entity.js';
import { FieldClassification, PolicyProfile, RuleStatus } from '../../types/enums.js';
import { builtInProfiles, evaluatePolicyProfile } from '../policies.js';
import { formatPolicyReport, generateAllPolicyReports, generatePolicyReport } from '../reports.js';
import type { SystemInventory } from '../rule-engine.js';

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
    fields: { id: { type: 'id', options: {} } },
    ...overrides,
  };
}

function emptyInventory(overrides?: Partial<SystemInventory>): SystemInventory {
  return {
    capabilities: [],
    entities: [],
    flows: [],
    events: [],
    prompts: [],
    ...overrides,
  };
}

// ── Policy Profiles Tests ──

describe('Policy Profiles', () => {
  it('has all built-in profiles defined', () => {
    expect(builtInProfiles[PolicyProfile.PciDss]).toBeDefined();
    expect(builtInProfiles[PolicyProfile.Gdpr]).toBeDefined();
    expect(builtInProfiles[PolicyProfile.Soc2]).toBeDefined();
    expect(builtInProfiles[PolicyProfile.Hipaa]).toBeDefined();
    expect(builtInProfiles[PolicyProfile.InternalSecurityBaseline]).toBeDefined();
  });

  it('evaluates PCI DSS — all pass for compliant inventory', () => {
    const inv = emptyInventory({
      capabilities: [
        mockCap({ access: { roles: ['admin'] }, audit: { enabled: true, event: 'x' } }),
      ],
      entities: [
        mockEntity({
          tenantScoped: true,
          fields: {
            ssn: {
              type: 'string',
              options: { classification: FieldClassification.Sensitive, encrypted: true },
            },
          },
        }),
      ],
    });
    const { results, score } = evaluatePolicyProfile(PolicyProfile.PciDss, inv);
    expect(score).toBe(100);
    expect(results.every((r) => r.status === RuleStatus.Pass)).toBe(true);
  });

  it('evaluates PCI DSS — fails for unencrypted sensitive fields', () => {
    const inv = emptyInventory({
      capabilities: [mockCap({ access: { roles: ['admin'] } })],
      entities: [
        mockEntity({
          tenantScoped: true,
          fields: {
            card: {
              type: 'string',
              options: { classification: FieldClassification.Sensitive },
            },
          },
        }),
      ],
    });
    const { results } = evaluatePolicyProfile(PolicyProfile.PciDss, inv);
    const encRule = results.find((r) => r.rule === 'pci-encryption-required');
    expect(encRule?.status).toBe(RuleStatus.Fail);
  });

  it('evaluates GDPR — flags missing retention', () => {
    const inv = emptyInventory({
      capabilities: [mockCap({ access: { roles: ['admin'] } })],
      entities: [
        mockEntity({
          tenantScoped: true,
          fields: {
            email: {
              type: 'string',
              options: { classification: FieldClassification.Personal },
            },
          },
        }),
      ],
    });
    const { results } = evaluatePolicyProfile(PolicyProfile.Gdpr, inv);
    const retRule = results.find((r) => r.rule === 'gdpr-retention-policy');
    expect(retRule?.status).toBe(RuleStatus.Partial);
  });

  it('evaluates HIPAA — fails for unmasked sensitive fields', () => {
    const inv = emptyInventory({
      capabilities: [mockCap({ access: { roles: ['admin'] } })],
      entities: [
        mockEntity({
          tenantScoped: true,
          fields: {
            phi: {
              type: 'string',
              options: { classification: FieldClassification.Sensitive, encrypted: true },
            },
          },
        }),
      ],
    });
    const { results } = evaluatePolicyProfile(PolicyProfile.Hipaa, inv);
    const maskRule = results.find((r) => r.rule === 'hipaa-field-masking');
    expect(maskRule?.status).toBe(RuleStatus.Fail);
  });

  it('evaluates SOC2 — passes with full audit', () => {
    const inv = emptyInventory({
      capabilities: [
        mockCap({ access: { roles: ['admin'] }, audit: { enabled: true, event: 'x' } }),
      ],
      entities: [mockEntity({ tenantScoped: true })],
    });
    const { score } = evaluatePolicyProfile(PolicyProfile.Soc2, inv);
    expect(score).toBe(100);
  });

  it('respects overrides in policy evaluation', () => {
    const inv = emptyInventory({
      capabilities: [mockCap()], // no access policy — would fail
    });
    const { results } = evaluatePolicyProfile(PolicyProfile.InternalSecurityBaseline, inv, [
      {
        rule: 'access-control-required',
        justification: 'testing',
        author: 'dev',
        timestamp: new Date(),
      },
    ]);
    const rule = results.find((r) => r.rule === 'access-control-required');
    expect(rule?.status).toBe(RuleStatus.Override);
  });
});

// ── Report Generator Tests ──

describe('Policy Report Generator', () => {
  it('generates a report with score and results', () => {
    const report = generatePolicyReport(PolicyProfile.PciDss, emptyInventory());
    expect(report.policy).toBe(PolicyProfile.PciDss);
    expect(typeof report.compatibilityScore).toBe('number');
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.timestamp).toBeInstanceOf(Date);
  });

  it('includes recommendations for failing rules', () => {
    const inv = emptyInventory({
      capabilities: [mockCap()], // no access policy
    });
    const report = generatePolicyReport(PolicyProfile.PciDss, inv);
    expect(report.recommendations!.length).toBeGreaterThan(0);
    expect(report.recommendations!.some((r) => r.includes('access-control-required'))).toBe(true);
  });

  it('includes overrides in report', () => {
    const inv = emptyInventory({ capabilities: [mockCap()] });
    const report = generatePolicyReport(PolicyProfile.PciDss, inv, [
      {
        rule: 'access-control-required',
        justification: 'test',
        author: 'dev',
        timestamp: new Date(),
      },
    ]);
    expect(report.overrides!.length).toBeGreaterThan(0);
  });

  it('formats report as human-readable text', () => {
    const report = generatePolicyReport(PolicyProfile.PciDss, emptyInventory());
    const text = formatPolicyReport(report);
    expect(text).toContain('Policy: pci_dss');
    expect(text).toContain('Compatibility Score:');
    expect(text).toContain('Results:');
  });

  it('generates reports for all profiles', () => {
    const reports = generateAllPolicyReports(emptyInventory());
    expect(reports).toHaveLength(Object.keys(builtInProfiles).length);
  });

  it('formatted report includes override section', () => {
    const inv = emptyInventory({ capabilities: [mockCap()] });
    const report = generatePolicyReport(PolicyProfile.PciDss, inv, [
      {
        rule: 'access-control-required',
        justification: 'justified reason',
        author: 'dev',
        timestamp: new Date(),
      },
    ]);
    const text = formatPolicyReport(report);
    expect(text).toContain('Overrides:');
    expect(text).toContain('justified reason');
  });
});
