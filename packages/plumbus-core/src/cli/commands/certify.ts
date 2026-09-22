// ── plumbus certify policy ──
// Run policy compatibility assessment and generate report

import type { Command } from 'commander';
import type { CapabilityContract } from '../../types/capability.js';
import type { EntityDefinition } from '../../types/entity.js';
import {
  FieldClassification,
  GovernanceSeverity,
  PolicyProfile,
  RuleStatus,
} from '../../types/enums.js';
import type { GovernanceOverride, PolicyReport, RuleEvaluation } from '../../types/governance.js';
import { discoverResources } from '../discover.js';
import { info, error as logError, success, warn } from '../utils.js';

export interface CertifyOptions {
  json?: boolean;
}

// ── Policy Rule Sets ──

export interface PolicyRule {
  name: string;
  severity: (typeof GovernanceSeverity)[keyof typeof GovernanceSeverity];
  evaluate: (ctx: PolicyContext) => (typeof RuleStatus)[keyof typeof RuleStatus];
  description: string;
  remediation?: string;
}

export interface PolicyContext {
  capabilities: CapabilityContract[];
  entities: EntityDefinition[];
  overrides: GovernanceOverride[];
}

const commonRules: PolicyRule[] = [
  {
    name: 'access-control-required',
    severity: GovernanceSeverity.High,
    description: 'All capabilities must have access policies',
    remediation: 'Add access policies to all capabilities',
    evaluate: (ctx) =>
      ctx.capabilities.every(
        (c) => c.access && (c.access.roles?.length || c.access.scopes?.length || c.access.public),
      )
        ? RuleStatus.Pass
        : RuleStatus.Fail,
  },
  {
    name: 'tenant-isolation',
    severity: GovernanceSeverity.High,
    description: 'All data entities must enforce tenant isolation',
    remediation: 'Set tenantScoped: true on all entities',
    evaluate: (ctx) =>
      ctx.entities.every((e) => e.tenantScoped) ? RuleStatus.Pass : RuleStatus.Partial,
  },
  {
    name: 'audit-logging',
    severity: GovernanceSeverity.High,
    description: 'All action/job capabilities must have audit enabled',
    remediation: 'Enable audit settings on action and job capabilities',
    evaluate: (ctx) => {
      const actionCaps = ctx.capabilities.filter((c) => c.kind === 'action' || c.kind === 'job');
      return actionCaps.every((c) => c.audit?.enabled !== false)
        ? RuleStatus.Pass
        : RuleStatus.Fail;
    },
  },
];

const policyRuleSets: Record<string, PolicyRule[]> = {
  [PolicyProfile.PciDss]: [
    ...commonRules,
    {
      name: 'pci-encryption-required',
      severity: GovernanceSeverity.High,
      description: 'Sensitive and highly_sensitive fields must be encrypted',
      remediation: 'Add encrypted: true to all sensitive/highly_sensitive fields',
      evaluate: (ctx) => {
        for (const entity of ctx.entities) {
          for (const field of Object.values(entity.fields)) {
            const cls = field.options.classification;
            if (
              (cls === FieldClassification.Sensitive ||
                cls === FieldClassification.HighlySensitive) &&
              !field.options.encrypted
            ) {
              return RuleStatus.Fail;
            }
          }
        }
        return RuleStatus.Pass;
      },
    },
  ],
  [PolicyProfile.Gdpr]: [
    ...commonRules,
    {
      name: 'gdpr-data-classification',
      severity: GovernanceSeverity.High,
      description: 'All personal data fields must have classification metadata',
      remediation: 'Add classification to fields containing personal data',
      evaluate: (ctx) => {
        for (const entity of ctx.entities) {
          for (const field of Object.values(entity.fields)) {
            if (!field.options.classification) return RuleStatus.Partial;
          }
        }
        return RuleStatus.Pass;
      },
    },
    {
      name: 'gdpr-retention-policy',
      severity: GovernanceSeverity.Warning,
      description: 'Entities with personal data should define retention policies',
      remediation: 'Add retention configuration to entities with personal data',
      evaluate: (ctx) => {
        const hasPersonal = ctx.entities.some((e) =>
          Object.values(e.fields).some(
            (f) =>
              f.options.classification === FieldClassification.Personal ||
              f.options.classification === FieldClassification.Sensitive,
          ),
        );
        if (!hasPersonal) return RuleStatus.Pass;
        return ctx.entities
          .filter((e) =>
            Object.values(e.fields).some(
              (f) => f.options.classification === FieldClassification.Personal,
            ),
          )
          .every((e) => e.retention)
          ? RuleStatus.Pass
          : RuleStatus.Partial;
      },
    },
  ],
  [PolicyProfile.Soc2]: [
    ...commonRules,
    {
      name: 'soc2-comprehensive-audit',
      severity: GovernanceSeverity.High,
      description: 'All capabilities must have audit trails enabled',
      remediation: 'Enable audit on all capabilities',
      evaluate: (ctx) =>
        ctx.capabilities.every((c) => c.audit?.enabled !== false)
          ? RuleStatus.Pass
          : RuleStatus.Fail,
    },
  ],
  [PolicyProfile.Hipaa]: [
    ...commonRules,
    {
      name: 'hipaa-phi-encryption',
      severity: GovernanceSeverity.High,
      description: 'All personal and sensitive fields must be encrypted (PHI protection)',
      remediation: 'Encrypt all fields classified as personal, sensitive, or highly_sensitive',
      evaluate: (ctx) => {
        const protectedClassifications: FieldClassification[] = [
          FieldClassification.Personal,
          FieldClassification.Sensitive,
          FieldClassification.HighlySensitive,
        ];
        for (const entity of ctx.entities) {
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
    },
    {
      name: 'hipaa-field-masking',
      severity: GovernanceSeverity.High,
      description: 'Sensitive fields must be masked in logs',
      remediation: 'Add maskedInLogs: true to sensitive fields',
      evaluate: (ctx) => {
        for (const entity of ctx.entities) {
          for (const field of Object.values(entity.fields)) {
            const cls = field.options.classification;
            if (
              (cls === FieldClassification.Sensitive ||
                cls === FieldClassification.HighlySensitive) &&
              !field.options.maskedInLogs
            ) {
              return RuleStatus.Fail;
            }
          }
        }
        return RuleStatus.Pass;
      },
    },
  ],
  [PolicyProfile.InternalSecurityBaseline]: [...commonRules],
};

/** Evaluate a policy profile against the system inventory */
export function evaluatePolicy(
  policyName: string,
  capabilities: CapabilityContract[],
  entities: EntityDefinition[],
  overrides: GovernanceOverride[] = [],
): PolicyReport {
  const rules = policyRuleSets[policyName] ?? commonRules;
  const ctx: PolicyContext = { capabilities, entities, overrides };

  const results: RuleEvaluation[] = rules.map((rule) => {
    const overridden = overrides.some((o) => o.rule === rule.name);
    const status = overridden ? RuleStatus.Override : rule.evaluate(ctx);
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

  return {
    policy: policyName,
    timestamp: new Date(),
    compatibilityScore: score,
    results,
    overrides,
    recommendations: results
      .filter((r) => r.status === RuleStatus.Fail || r.status === RuleStatus.Partial)
      .map((r) => r.remediation)
      .filter((r): r is string => !!r),
  };
}

export function registerCertifyCommand(program: Command): void {
  const cmd = program.command('certify').description('Policy certification');

  cmd
    .command('policy <name>')
    .description(
      'Run policy compatibility assessment (pci_dss, gdpr, soc2, hipaa, internal_security_baseline)',
    )
    .option('--json', 'Output as JSON')
    .action(async (name: string, opts: CertifyOptions) => {
      info(`Running policy assessment: ${name}`);

      let capabilities: CapabilityContract[] = [];
      let entities: EntityDefinition[] = [];
      try {
        const resources = await discoverResources();
        capabilities = resources.capabilities;
        entities = resources.entities;
        info(`Discovered ${capabilities.length} capability(ies), ${entities.length} entity(ies)`);
      } catch {
        warn('Could not auto-discover resources (app/ directory may not exist)');
      }

      const report = evaluatePolicy(name, capabilities, entities);

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(`\nPolicy: ${report.policy}`);
      console.log(`Score: ${report.compatibilityScore}%`);
      console.log('');

      for (const r of report.results) {
        const icon =
          r.status === RuleStatus.Pass ? '✓' : r.status === RuleStatus.Override ? '⊘' : '✗';
        const line = `${icon} [${r.status.toUpperCase()}] ${r.rule}: ${r.description}`;
        if (r.status === RuleStatus.Fail) logError(line);
        else if (r.status === RuleStatus.Partial) warn(line);
        else success(line);
      }

      if (report.recommendations && report.recommendations.length > 0) {
        console.log('\nRecommendations:');
        for (const rec of report.recommendations) {
          info(`  → ${rec}`);
        }
      }
    });
}
