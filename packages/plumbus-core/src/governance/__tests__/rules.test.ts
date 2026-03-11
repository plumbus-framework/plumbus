import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { EntityDefinition } from '../../types/entity.js';
import { FieldClassification, GovernanceSeverity } from '../../types/enums.js';
import type { FlowDefinition } from '../../types/flow.js';
import type { PromptDefinition } from '../../types/prompt.js';
import type { SystemInventory } from '../rule-engine.js';
import { createGovernanceRuleEngine } from '../rule-engine.js';
import {
  ruleAIWithoutExplanation,
  ruleExcessiveAIUsage,
  rulePromptMissingModelConfig,
  rulePromptMissingOutputSchema,
} from '../rules/ai.js';
import {
  ruleEntityMissingDescription,
  ruleExcessiveEffects,
  ruleExcessiveFlowBranching,
  ruleExcessiveFlowSteps,
  ruleMissingAuditConfig,
} from '../rules/architecture.js';
import {
  ruleExcessiveDataRetention,
  ruleMissingFieldClassification,
  rulePersonalDataInLogs,
  ruleSensitiveFieldUnencrypted,
} from '../rules/privacy.js';
import {
  ruleCapabilityMissingAccessPolicy,
  ruleCrossTenantDataAccess,
  ruleEntityTenantIsolation,
  ruleOverlyPermissiveRoles,
  securityRules,
} from '../rules/security.js';

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

function mockFlow(overrides?: Partial<FlowDefinition>): FlowDefinition {
  return {
    name: 'test-flow',
    domain: 'test',
    input: z.object({}),
    state: z.object({}),
    steps: [],
    ...overrides,
  } as FlowDefinition;
}

function mockPrompt(overrides?: Partial<PromptDefinition>): PromptDefinition {
  return {
    name: 'test-prompt',
    input: z.object({}),
    output: z.object({}),
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

// ── Rule Engine Tests ──

describe('GovernanceRuleEngine', () => {
  it('registers and evaluates rules', () => {
    const engine = createGovernanceRuleEngine();
    engine.register(ruleCapabilityMissingAccessPolicy);

    const result = engine.evaluate(emptyInventory({ capabilities: [mockCap()] }));
    expect(result.signals).toHaveLength(1);
    expect(result.effective).toHaveLength(1);
    expect(result.summary.high).toBe(1);
  });

  it('registerMany adds multiple rules', () => {
    const engine = createGovernanceRuleEngine();
    engine.registerMany(securityRules);
    expect(engine.getRules()).toHaveLength(securityRules.length);
  });

  it('unregisters a rule', () => {
    const engine = createGovernanceRuleEngine();
    engine.register(ruleCapabilityMissingAccessPolicy);
    engine.unregister('security.capability-access-policy');
    expect(engine.getRules()).toHaveLength(0);
  });

  it('filters rules by category', () => {
    const engine = createGovernanceRuleEngine();
    engine.register(ruleCapabilityMissingAccessPolicy);
    engine.register(ruleExcessiveEffects);
    expect(engine.getRulesByCategory('security')).toHaveLength(1);
    expect(engine.getRulesByCategory('architecture')).toHaveLength(1);
  });

  it('applies overrides to suppress signals', () => {
    const engine = createGovernanceRuleEngine();
    engine.register(ruleCapabilityMissingAccessPolicy);

    const result = engine.evaluate(emptyInventory({ capabilities: [mockCap()] }), [
      {
        rule: 'security.capability-access-policy',
        justification: 'testing',
        author: 'dev',
        timestamp: new Date(),
      },
    ]);
    expect(result.signals).toHaveLength(1);
    expect(result.effective).toHaveLength(0);
    expect(result.summary.overridden).toBe(1);
  });

  it('returns empty results for clean inventory', () => {
    const engine = createGovernanceRuleEngine();
    engine.registerMany(securityRules);
    const inv = emptyInventory({
      capabilities: [mockCap({ access: { roles: ['admin'] } })],
      entities: [mockEntity({ tenantScoped: true })],
    });
    const result = engine.evaluate(inv);
    expect(result.summary.high).toBe(0);
  });
});

// ── Security Rules ──

describe('Security Rules', () => {
  it('flags capabilities without access policies', () => {
    const signals = ruleCapabilityMissingAccessPolicy.evaluate(
      emptyInventory({ capabilities: [mockCap()] }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe(GovernanceSeverity.High);
  });

  it('passes capabilities with access policies', () => {
    const signals = ruleCapabilityMissingAccessPolicy.evaluate(
      emptyInventory({ capabilities: [mockCap({ access: { roles: ['admin'] } })] }),
    );
    expect(signals).toHaveLength(0);
  });

  it('flags wildcard roles', () => {
    const signals = ruleOverlyPermissiveRoles.evaluate(
      emptyInventory({ capabilities: [mockCap({ access: { roles: ['*'] } })] }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.rule).toBe('security.overly-permissive-roles');
  });

  it('flags cross-tenant data access', () => {
    const signals = ruleCrossTenantDataAccess.evaluate(
      emptyInventory({
        capabilities: [
          mockCap({
            effects: { data: ['User'], events: [], external: [], ai: false },
            access: { tenantScoped: true, roles: ['admin'] },
          }),
        ],
        entities: [mockEntity({ name: 'User', tenantScoped: false })],
      }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.rule).toBe('security.cross-tenant-data-access');
  });

  it('flags entities without tenant isolation', () => {
    const signals = ruleEntityTenantIsolation.evaluate(
      emptyInventory({ entities: [mockEntity()] }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe(GovernanceSeverity.Info);
  });
});

// ── Privacy Rules ──

describe('Privacy Rules', () => {
  it('flags unencrypted sensitive fields', () => {
    const signals = ruleSensitiveFieldUnencrypted.evaluate(
      emptyInventory({
        entities: [
          mockEntity({
            fields: {
              ssn: {
                type: 'string',
                options: { classification: FieldClassification.Sensitive },
              },
            },
          }),
        ],
      }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe(GovernanceSeverity.High);
  });

  it('passes encrypted sensitive fields', () => {
    const signals = ruleSensitiveFieldUnencrypted.evaluate(
      emptyInventory({
        entities: [
          mockEntity({
            fields: {
              ssn: {
                type: 'string',
                options: {
                  classification: FieldClassification.Sensitive,
                  encrypted: true,
                },
              },
            },
          }),
        ],
      }),
    );
    expect(signals).toHaveLength(0);
  });

  it('flags personal data not masked in logs', () => {
    const signals = rulePersonalDataInLogs.evaluate(
      emptyInventory({
        entities: [
          mockEntity({
            fields: {
              email: {
                type: 'string',
                options: { classification: FieldClassification.Personal },
              },
            },
          }),
        ],
      }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.rule).toBe('privacy.personal-data-in-logs');
  });

  it('flags missing classification on sensitive-looking fields', () => {
    const signals = ruleMissingFieldClassification.evaluate(
      emptyInventory({
        entities: [
          mockEntity({
            fields: {
              email: { type: 'string', options: {} },
            },
          }),
        ],
      }),
    );
    expect(signals).toHaveLength(1);
  });

  it('flags entities with personal data and no retention', () => {
    const signals = ruleExcessiveDataRetention.evaluate(
      emptyInventory({
        entities: [
          mockEntity({
            fields: {
              email: {
                type: 'string',
                options: { classification: FieldClassification.Personal },
              },
            },
          }),
        ],
      }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.rule).toBe('privacy.excessive-data-retention');
  });

  it('passes entities with retention policies', () => {
    const signals = ruleExcessiveDataRetention.evaluate(
      emptyInventory({
        entities: [
          mockEntity({
            retention: { duration: '90d' },
            fields: {
              email: {
                type: 'string',
                options: { classification: FieldClassification.Personal },
              },
            },
          }),
        ],
      }),
    );
    expect(signals).toHaveLength(0);
  });
});

// ── Architecture Rules ──

describe('Architecture Rules', () => {
  it('flags capabilities with excessive effects', () => {
    const data = Array.from({ length: 12 }, (_, i) => `entity${i}`);
    const signals = ruleExcessiveEffects.evaluate(
      emptyInventory({
        capabilities: [mockCap({ effects: { data, events: [], external: [], ai: false } })],
      }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.rule).toBe('architecture.excessive-effects');
  });

  it('passes capabilities with reasonable effects', () => {
    const signals = ruleExcessiveEffects.evaluate(
      emptyInventory({
        capabilities: [
          mockCap({ effects: { data: ['User'], events: ['created'], external: [], ai: false } }),
        ],
      }),
    );
    expect(signals).toHaveLength(0);
  });

  it('flags flows with excessive branching', () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({
      name: `cond${i}`,
      type: 'conditional' as const,
      if: 'true',
      then: 'a',
    }));
    const signals = ruleExcessiveFlowBranching.evaluate(
      emptyInventory({ flows: [mockFlow({ steps })] }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.rule).toBe('architecture.excessive-flow-branching');
  });

  it('flags flows with excessive steps', () => {
    const steps = Array.from({ length: 25 }, (_, i) => ({
      name: `step${i}`,
      type: 'capability' as const,
    }));
    const signals = ruleExcessiveFlowSteps.evaluate(
      emptyInventory({ flows: [mockFlow({ steps })] }),
    );
    expect(signals).toHaveLength(1);
  });

  it('flags capabilities with disabled audit', () => {
    const signals = ruleMissingAuditConfig.evaluate(
      emptyInventory({
        capabilities: [mockCap({ audit: { enabled: false, event: 'x' } })],
      }),
    );
    expect(signals).toHaveLength(1);
  });

  it('flags entities without descriptions', () => {
    const signals = ruleEntityMissingDescription.evaluate(
      emptyInventory({ entities: [mockEntity()] }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.rule).toBe('architecture.entity-missing-description');
  });
});

// ── AI Rules ──

describe('AI Rules', () => {
  it('flags prompts without output schemas', () => {
    const signals = rulePromptMissingOutputSchema.evaluate(
      emptyInventory({
        prompts: [{ name: 'test', input: z.object({}) } as unknown as PromptDefinition],
      }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.rule).toBe('ai.prompt-missing-output-schema');
  });

  it('flags prompts without model config', () => {
    const signals = rulePromptMissingModelConfig.evaluate(
      emptyInventory({ prompts: [mockPrompt()] }),
    );
    expect(signals).toHaveLength(1);
  });

  it('flags AI capabilities without explanation', () => {
    const signals = ruleAIWithoutExplanation.evaluate(
      emptyInventory({
        capabilities: [mockCap({ effects: { data: [], events: [], external: [], ai: true } })],
      }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.rule).toBe('ai.missing-explanation');
  });

  it('passes AI capabilities with explanation enabled', () => {
    const signals = ruleAIWithoutExplanation.evaluate(
      emptyInventory({
        capabilities: [
          mockCap({
            effects: { data: [], events: [], external: [], ai: true },
            explanation: { enabled: true },
          }),
        ],
      }),
    );
    expect(signals).toHaveLength(0);
  });

  it('flags excessive AI usage', () => {
    const caps = Array.from({ length: 5 }, (_, i) =>
      mockCap({
        name: `ai-${i}`,
        effects: { data: [], events: [], external: [], ai: true },
      }),
    );
    const signals = ruleExcessiveAIUsage.evaluate(emptyInventory({ capabilities: caps }));
    expect(signals).toHaveLength(1);
    expect(signals[0]!.rule).toBe('ai.excessive-usage');
  });

  it('passes with reasonable AI usage ratio', () => {
    const caps = [
      mockCap({ name: 'a', effects: { data: [], events: [], external: [], ai: true } }),
      mockCap({ name: 'b' }),
      mockCap({ name: 'c' }),
      mockCap({ name: 'd' }),
    ];
    const signals = ruleExcessiveAIUsage.evaluate(emptyInventory({ capabilities: caps }));
    expect(signals).toHaveLength(0);
  });
});
