// ── Policy Profiles ──
// Define policy rule sets for compliance frameworks: PCI DSS, GDPR, SOC2, HIPAA, internal baseline.
// Each profile contains rules that evaluate against the system inventory.

import {
  FieldClassification,
  GovernanceSeverity,
  PolicyProfile,
  RuleStatus,
} from '../types/enums.js';
import type { GovernanceOverride, RuleEvaluation } from '../types/governance.js';
import type { SystemInventory } from './rule-engine.js';

// ── Policy Rule ──
export interface PolicyProfileRule {
  name: string;
  severity: GovernanceSeverity;
  description: string;
  remediation?: string;
  evaluate: (inventory: SystemInventory, overrides: GovernanceOverride[]) => RuleStatus;
}

// ── Policy Profile Definition ──
export interface PolicyProfileDefinition {
  name: PolicyProfile | string;
  description: string;
  rules: PolicyProfileRule[];
}

// ── Common Rules (shared across profiles) ──

const ruleAccessControlRequired: PolicyProfileRule = {
  name: 'access-control-required',
  severity: GovernanceSeverity.High,
  description: 'All capabilities must have access policies',
  remediation: 'Add access policies to all capabilities',
  evaluate(inventory) {
    return inventory.capabilities.every(
      (c) => c.access && (c.access.roles?.length || c.access.scopes?.length || c.access.public),
    )
      ? RuleStatus.Pass
      : RuleStatus.Fail;
  },
};

const ruleTenantIsolation: PolicyProfileRule = {
  name: 'tenant-isolation',
  severity: GovernanceSeverity.High,
  description: 'All data entities must enforce tenant isolation',
  remediation: 'Set tenantScoped: true on all entities',
  evaluate(inventory) {
    if (inventory.entities.length === 0) return RuleStatus.Pass;
    return inventory.entities.every((e) => e.tenantScoped) ? RuleStatus.Pass : RuleStatus.Partial;
  },
};

const ruleAuditLogging: PolicyProfileRule = {
  name: 'audit-logging',
  severity: GovernanceSeverity.High,
  description: 'All action/job capabilities must have audit enabled',
  remediation: 'Enable audit settings on action and job capabilities',
  evaluate(inventory) {
    const actionCaps = inventory.capabilities.filter(
      (c) => c.kind === 'action' || c.kind === 'job',
    );
    if (actionCaps.length === 0) return RuleStatus.Pass;
    return actionCaps.every((c) => c.audit?.enabled !== false) ? RuleStatus.Pass : RuleStatus.Fail;
  },
};

// ── PCI DSS ──

const pciEncryptionRequired: PolicyProfileRule = {
  name: 'pci-encryption-required',
  severity: GovernanceSeverity.High,
  description: 'Sensitive and highly_sensitive fields must be encrypted',
  remediation: 'Add encrypted: true to all sensitive/highly_sensitive fields',
  evaluate(inventory) {
    for (const entity of inventory.entities) {
      for (const field of Object.values(entity.fields)) {
        const cls = field.options.classification;
        if (
          (cls === FieldClassification.Sensitive || cls === FieldClassification.HighlySensitive) &&
          !field.options.encrypted
        ) {
          return RuleStatus.Fail;
        }
      }
    }
    return RuleStatus.Pass;
  },
};

// ── GDPR ──

const gdprDataClassification: PolicyProfileRule = {
  name: 'gdpr-data-classification',
  severity: GovernanceSeverity.High,
  description: 'All personal data fields must have classification metadata',
  remediation: 'Add classification to fields containing personal data',
  evaluate(inventory) {
    for (const entity of inventory.entities) {
      for (const field of Object.values(entity.fields)) {
        if (!field.options.classification) return RuleStatus.Partial;
      }
    }
    return RuleStatus.Pass;
  },
};

const gdprRetentionPolicy: PolicyProfileRule = {
  name: 'gdpr-retention-policy',
  severity: GovernanceSeverity.Warning,
  description: 'Entities with personal data should define retention policies',
  remediation: 'Add retention configuration to entities with personal data',
  evaluate(inventory) {
    const entitiesWithPersonal = inventory.entities.filter((e) =>
      Object.values(e.fields).some(
        (f) =>
          f.options.classification === FieldClassification.Personal ||
          f.options.classification === FieldClassification.Sensitive,
      ),
    );
    if (entitiesWithPersonal.length === 0) return RuleStatus.Pass;
    return entitiesWithPersonal.every((e) => e.retention) ? RuleStatus.Pass : RuleStatus.Partial;
  },
};

const gdprDataMinimization: PolicyProfileRule = {
  name: 'gdpr-data-minimization',
  severity: GovernanceSeverity.Info,
  description: 'Capabilities should not expose unnecessary personal data fields',
  remediation: 'Review capability outputs to exclude unnecessary personal data',
  evaluate(inventory) {
    // Passes if all capabilities with AI usage have explanation enabled (proxy for data governance awareness)
    const aiCaps = inventory.capabilities.filter((c) => c.effects.ai);
    if (aiCaps.length === 0) return RuleStatus.Pass;
    return aiCaps.every((c) => c.explanation?.enabled) ? RuleStatus.Pass : RuleStatus.Partial;
  },
};

// ── SOC2 ──

const soc2ComprehensiveAudit: PolicyProfileRule = {
  name: 'soc2-comprehensive-audit',
  severity: GovernanceSeverity.High,
  description: 'All capabilities must have audit trails enabled',
  remediation: 'Enable audit on all capabilities',
  evaluate(inventory) {
    if (inventory.capabilities.length === 0) return RuleStatus.Pass;
    return inventory.capabilities.every((c) => c.audit?.enabled !== false)
      ? RuleStatus.Pass
      : RuleStatus.Fail;
  },
};

const soc2ChangeManagement: PolicyProfileRule = {
  name: 'soc2-change-management',
  severity: GovernanceSeverity.Warning,
  description: 'All capabilities should declare their effects for change tracking',
  remediation: 'Ensure all capabilities declare complete effects (data, events, external)',
  evaluate(inventory) {
    return inventory.capabilities.every((c) => c.effects) ? RuleStatus.Pass : RuleStatus.Partial;
  },
};

// ── HIPAA ──

const hipaaPhiEncryption: PolicyProfileRule = {
  name: 'hipaa-phi-encryption',
  severity: GovernanceSeverity.High,
  description: 'All personal and sensitive fields must be encrypted (PHI protection)',
  remediation: 'Encrypt all fields classified as personal, sensitive, or highly_sensitive',
  evaluate(inventory) {
    const protectedClassifications: FieldClassification[] = [
      FieldClassification.Personal,
      FieldClassification.Sensitive,
      FieldClassification.HighlySensitive,
    ];
    for (const entity of inventory.entities) {
      for (const field of Object.values(entity.fields)) {
        if (
          field.options.classification &&
          protectedClassifications.includes(field.options.classification) &&
          !field.options.encrypted
        ) {
          return RuleStatus.Fail;
        }
      }
    }
    return RuleStatus.Pass;
  },
};

const hipaaFieldMasking: PolicyProfileRule = {
  name: 'hipaa-field-masking',
  severity: GovernanceSeverity.High,
  description: 'Sensitive fields must be masked in logs',
  remediation: 'Add maskedInLogs: true to sensitive fields',
  evaluate(inventory) {
    for (const entity of inventory.entities) {
      for (const field of Object.values(entity.fields)) {
        const cls = field.options.classification;
        if (
          (cls === FieldClassification.Sensitive || cls === FieldClassification.HighlySensitive) &&
          !field.options.maskedInLogs
        ) {
          return RuleStatus.Fail;
        }
      }
    }
    return RuleStatus.Pass;
  },
};

const hipaaAccessControls: PolicyProfileRule = {
  name: 'hipaa-access-controls',
  severity: GovernanceSeverity.High,
  description: 'All capabilities accessing patient data must use role-based access control',
  remediation: 'Add specific roles to capabilities that access patient/health data',
  evaluate(inventory) {
    return inventory.capabilities
      .filter((c) => c.access?.tenantScoped)
      .every((c) => c.access?.roles?.length)
      ? RuleStatus.Pass
      : RuleStatus.Partial;
  },
};

// ── Internal Security Baseline ──

const internalFieldEncryption: PolicyProfileRule = {
  name: 'internal-field-encryption',
  severity: GovernanceSeverity.Warning,
  description: 'Highly sensitive fields should be encrypted',
  remediation: 'Add encrypted: true to highly_sensitive fields',
  evaluate(inventory) {
    for (const entity of inventory.entities) {
      for (const field of Object.values(entity.fields)) {
        if (
          field.options.classification === FieldClassification.HighlySensitive &&
          !field.options.encrypted
        ) {
          return RuleStatus.Fail;
        }
      }
    }
    return RuleStatus.Pass;
  },
};

// ── Built-in Profile Definitions ──

export const builtInProfiles: Record<string, PolicyProfileDefinition> = {
  [PolicyProfile.PciDss]: {
    name: PolicyProfile.PciDss,
    description: 'Payment Card Industry Data Security Standard',
    rules: [
      ruleAccessControlRequired,
      ruleTenantIsolation,
      ruleAuditLogging,
      pciEncryptionRequired,
    ],
  },
  [PolicyProfile.Gdpr]: {
    name: PolicyProfile.Gdpr,
    description: 'General Data Protection Regulation',
    rules: [
      ruleAccessControlRequired,
      ruleTenantIsolation,
      ruleAuditLogging,
      gdprDataClassification,
      gdprRetentionPolicy,
      gdprDataMinimization,
    ],
  },
  [PolicyProfile.Soc2]: {
    name: PolicyProfile.Soc2,
    description: 'Service Organization Control 2',
    rules: [
      ruleAccessControlRequired,
      ruleTenantIsolation,
      ruleAuditLogging,
      soc2ComprehensiveAudit,
      soc2ChangeManagement,
    ],
  },
  [PolicyProfile.Hipaa]: {
    name: PolicyProfile.Hipaa,
    description: 'Health Insurance Portability and Accountability Act',
    rules: [
      ruleAccessControlRequired,
      ruleTenantIsolation,
      ruleAuditLogging,
      hipaaPhiEncryption,
      hipaaFieldMasking,
      hipaaAccessControls,
    ],
  },
  [PolicyProfile.InternalSecurityBaseline]: {
    name: PolicyProfile.InternalSecurityBaseline,
    description: 'Organization internal security baseline',
    rules: [
      ruleAccessControlRequired,
      ruleTenantIsolation,
      ruleAuditLogging,
      internalFieldEncryption,
    ],
  },
};

/** Evaluate a policy profile against a system inventory */
export function evaluatePolicyProfile(
  profileName: string,
  inventory: SystemInventory,
  overrides: GovernanceOverride[] = [],
): { results: RuleEvaluation[]; score: number } {
  const profile = builtInProfiles[profileName];
  const rules = profile?.rules ?? [
    ruleAccessControlRequired,
    ruleTenantIsolation,
    ruleAuditLogging,
  ];

  const results: RuleEvaluation[] = rules.map((rule) => {
    const overridden = overrides.some((o) => o.rule === rule.name);
    const status = overridden ? RuleStatus.Override : rule.evaluate(inventory, overrides);
    return {
      rule: rule.name,
      status,
      severity: rule.severity,
      description: rule.description,
      remediation: rule.remediation,
    };
  });

  const total = results.length;
  const passCount = results.filter(
    (r) => r.status === RuleStatus.Pass || r.status === RuleStatus.Override,
  ).length;
  const score = total > 0 ? Math.round((passCount / total) * 100) : 100;

  return { results, score };
}
